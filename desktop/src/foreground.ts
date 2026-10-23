// Which window is in front, and how bright the screen is next to the island. Windows reads both through Win32 (koffi);
// Linux under X11 asks xprop and /proc and samples a screen thumbnail. Wayland exposes neither, so the island is off there.
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import type { ForegroundWindow } from "./ai-apps.js";
import { isTerminal } from "./ai-apps.js";
import type { IslandTone } from "./ipc.js";

const run = promisify(execFile);
export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; width: number; height: number };
/** A foreground window and a point on it (DIP), used to pick the display the island goes to. */
export type ForegroundReading = { window: ForegroundWindow; anchor: Point | null; pid: number };

export interface ForegroundProbe {
  read(): Promise<ForegroundReading | null>;
  /** Relative luminance (0–1) per screen point in DIP; null where it cannot be read. */
  luminance(points: Point[], displayId: number): Promise<(number | null)[]>;
  close?(): void;
}

export type ProbeRequest = { id: number; op: "read" } | { id: number; op: "luminance"; points: Point[] };
export type ProbeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
/** The part of a worker_threads Worker the threaded probe uses. */
export interface ProbeWorker {
  postMessage(request: ProbeRequest): void;
  on(event: "message", listener: (response: ProbeResponse) => void): unknown;
  on(event: "error" | "exit", listener: (reason: unknown) => void): unknown;
  terminate(): unknown;
}

/**
 * A probe running in a worker (foreground-worker.ts) in screen pixels, converted to DIP here. Should the worker fail
 * to start or die, requests go to `fallback` instead, on this thread.
 */
export function threadedProbe(start: () => ProbeWorker, toDip: (point: Point) => Point, toScreen: (point: Point) => Point, fallback: () => ForegroundProbe): ForegroundProbe {
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let worker: ProbeWorker | null = null, local: ForegroundProbe | null = null, nextId = 1;
  const fail = (reason: unknown) => {
    if (!worker) return;
    const message = reason instanceof Error ? reason.message : `worker stopped (${String(reason)})`;
    console.warn(`Meterkat island: foreground probe runs on the main thread (${message})`);
    worker = null;
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
  };
  try {
    worker = start();
    worker.on("message", response => {
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.ok) request.resolve(response.result); else request.reject(new Error(response.error));
    });
    worker.on("error", fail);
    worker.on("exit", fail);
  } catch (error) { worker = null; console.warn(`Meterkat island: foreground probe runs on the main thread (${error instanceof Error ? error.message : error})`); }

  function ask(request: { op: "read" } | { op: "luminance"; points: Point[] }) {
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => { pending.set(id, { resolve, reject }); worker!.postMessage({ ...request, id }); });
  }
  return {
    async read() {
      if (!worker) return (local ??= fallback()).read();
      const reading = await ask({ op: "read" }) as ForegroundReading | null;
      return reading && { ...reading, anchor: reading.anchor && toDip(reading.anchor) };
    },
    async luminance(points, displayId) {
      if (!worker) return (local ??= fallback()).luminance(points, displayId);
      return await ask({ op: "luminance", points: points.map(toScreen) }) as (number | null)[];
    },
    close() { const running = worker; worker = null; void running?.terminate(); },
  };
}

/** Why the island cannot run here, or null when it can. */
export function unsupportedReason(platform: string, env: NodeJS.ProcessEnv): string | null {
  if (platform === "win32") return null;
  if (platform !== "linux") return "Not available on this system.";
  if (env.XDG_SESSION_TYPE === "wayland" || (env.WAYLAND_DISPLAY && !env.DISPLAY)) return "Not available on Wayland: it does not tell apps which window is in front.";
  return env.DISPLAY ? null : "Needs an X11 desktop session.";
}

/** sRGB → relative luminance, as in WCAG. */
export function luminance(r: number, g: number, b: number) {
  const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Hysteresis between the two tones so a mid-grey title bar does not make the drop flip back and forth. */
export function nextTone(current: IslandTone, values: (number | null)[]): IslandTone {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return current;
  const average = known.reduce((sum, v) => sum + v, 0) / known.length;
  if (average > 0.4) return "ink";
  if (average < 0.25) return "white";
  return current;
}

// ---- Linux (X11) -----------------------------------------------------------------------------------------------

/** `xprop -root _NET_ACTIVE_WINDOW` → the window id, or null when no window has the focus. */
export function parseActiveWindow(output: string): string | null {
  const id = /window id # (0x[0-9a-f]+)/i.exec(output)?.[1];
  return id && Number(id) !== 0 ? id : null;
}

/** `xprop -id <id> WM_CLASS _NET_WM_NAME _NET_WM_PID _NET_WM_STATE` → class, title, pid and full-screen state. */
export function parseWindowProps(output: string) {
  const classes = /^WM_CLASS(?:\(\w+\))? = (.*)$/m.exec(output)?.[1]?.match(/"((?:[^"\\]|\\.)*)"/g)?.map(s => JSON.parse(s) as string) ?? [];
  const titleRaw = /^_NET_WM_NAME(?:\(\w+\))? = (".*")$/m.exec(output)?.[1];
  let title = "";
  try { title = titleRaw ? JSON.parse(titleRaw) as string : ""; } catch { title = titleRaw?.slice(1, -1) ?? ""; }
  const pid = Number(/^_NET_WM_PID(?:\(\w+\))? = (\d+)$/m.exec(output)?.[1] ?? 0);
  const fullscreen = /^_NET_WM_STATE(?:\(\w+\))? = .*_NET_WM_STATE_FULLSCREEN/m.test(output);
  // WM_CLASS is "instance", "Class"; the class is the stable app name (Firefox's instance is "Navigator").
  return { app: classes[1] ?? classes[0] ?? "", title, pid, fullscreen };
}

/** Command lines of every process below `root`, read from /proc. */
export function linuxDescendants(root: number, proc = "/proc", limit = 200): string[] {
  const children = new Map<number, number[]>();
  for (const entry of readdirSync(proc)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`${proc}/${entry}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(ppid) ?? []; list.push(Number(entry)); children.set(ppid, list);
    } catch { /* process ended */ }
  }
  const result: string[] = [];
  const queue = [...(children.get(root) ?? [])];
  for (let i = 0; i < queue.length && result.length < limit; i++) {
    const pid = queue[i]!;
    try { result.push(readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" ")); } catch { /* ended */ }
    queue.push(...(children.get(pid) ?? []));
  }
  return result;
}

type Thumbnail = { displayId: string; width: number; height: number; bitmap: Buffer; scale: number; origin: Point };
export type ScreenCapture = (displayId: number) => Promise<Thumbnail | null>;

export function linuxProbe(capture: ScreenCapture, cursor: () => Point): ForegroundProbe {
  return {
    async read() {
      const id = parseActiveWindow((await run("xprop", ["-root", "-notype", "_NET_ACTIVE_WINDOW"], { timeout: 2000 })).stdout);
      if (!id) return null;
      const props = parseWindowProps((await run("xprop", ["-id", id, "-notype", "WM_CLASS", "_NET_WM_NAME", "_NET_WM_PID", "_NET_WM_STATE"], { timeout: 2000 })).stdout);
      const descendants = props.pid && isTerminal(props.app) ? linuxDescendants(props.pid) : [];
      return { window: { app: props.app, title: props.title, descendants, fullscreen: props.fullscreen }, anchor: cursor(), pid: props.pid };
    },
    async luminance(points, displayId) {
      const shot = await capture(displayId);
      return points.map(p => shot ? pixelLuminance(shot, p) : null);
    },
  };
}

/**
 * The pointer in physical pixels, asked from the X server directly: on X11, Electron's screen.getCursorScreenPoint()
 * keeps returning a stale point unless one of the app's own windows receives pointer events, and the island's window
 * lets them through. `primary` is whether the (logical) first button is held. Throws when libX11 cannot be loaded or
 * the display not opened.
 */
export function x11Pointer(koffi: KoffiModule): () => (Point & { primary: boolean }) | null {
  const x11 = koffi.load("libX11.so.6");
  const openDisplay = x11.func("void *XOpenDisplay(const char *name)");
  const rootWindow = x11.func("unsigned long XDefaultRootWindow(void *display)");
  const queryPointer = x11.func("int XQueryPointer(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)");
  const display = openDisplay(null);
  if (!display) throw new Error("Cannot open the X display");
  const root = rootWindow(display);
  return () => {
    const x = [0], y = [0], mask = [0];
    // False when the pointer is on another screen of the display: there is no point on this one.
    return queryPointer(display, root, [0], [0], x, y, [0], [0], mask) ? { x: x[0]!, y: y[0]!, primary: (mask[0]! & BUTTON1_MASK) !== 0 } : null;
  };
}
const BUTTON1_MASK = 1 << 8;

/** Whether the primary mouse button is held (Windows). GetAsyncKeyState reads the physical buttons, so swapped ones are honoured here. */
export function windowsPrimaryButton(koffi: KoffiModule): () => boolean {
  const user32 = koffi.load("user32.dll");
  const keyState = user32.func("int16 __stdcall GetAsyncKeyState(int32 key)");
  const metrics = user32.func("int32 __stdcall GetSystemMetrics(int32 index)");
  const VK_LBUTTON = 0x01, VK_RBUTTON = 0x02, SM_SWAPBUTTON = 23;
  return () => (keyState(metrics(SM_SWAPBUTTON) ? VK_RBUTTON : VK_LBUTTON) & 0x8000) !== 0;
}

function pixelLuminance(shot: Thumbnail, p: Point): number | null {
  const x = Math.round((p.x - shot.origin.x) * shot.scale), y = Math.round((p.y - shot.origin.y) * shot.scale);
  if (x < 0 || y < 0 || x >= shot.width || y >= shot.height) return null;
  const i = (y * shot.width + x) * 4; // BGRA
  return luminance(shot.bitmap[i + 2]!, shot.bitmap[i + 1]!, shot.bitmap[i]!);
}

// ---- Windows (Win32 through koffi) -----------------------------------------------------------------------------

/** The part of koffi the bindings use. */
export interface KoffiModule {
  load(path: string): { func(definition: string): (...args: any[]) => any };
  struct(name: string, fields: Record<string, unknown>): unknown;
  array(type: string, length: number, hint?: string): unknown;
  sizeof(type: unknown): number;
  address(pointer: unknown): bigint;
}

type Win32Rect = { left: number; top: number; right: number; bottom: number };
const MONITOR_DEFAULTTONEAREST = 2, TH32CS_SNAPPROCESS = 2, CLR_INVALID = 0xffffffff;

export function windowsProbe(koffi: KoffiModule, toDip: (rect: Rect) => Rect, toScreen: (point: Point) => Point): ForegroundProbe {
  const user32 = koffi.load("user32.dll"), gdi32 = koffi.load("gdi32.dll"), kernel32 = koffi.load("kernel32.dll");
  const RECT = koffi.struct("MK_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
  const MONITORINFO = koffi.struct("MK_MONITORINFO", { cbSize: "uint32", rcMonitor: RECT, rcWork: RECT, dwFlags: "uint32" });
  const ENTRY = koffi.struct("MK_PROCESSENTRY32W", {
    dwSize: "uint32", cntUsage: "uint32", th32ProcessID: "uint32", th32DefaultHeapID: "uintptr_t", th32ModuleID: "uint32",
    cntThreads: "uint32", th32ParentProcessID: "uint32", pcPriClassBase: "int32", dwFlags: "uint32", szExeFile: koffi.array("char16_t", 260, "String"),
  });
  const getForegroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
  const getShellWindow = user32.func("void * __stdcall GetShellWindow()");
  const windowProcess = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
  const windowText = user32.func("int32 __stdcall GetWindowTextW(void *hwnd, void *text, int32 max)");
  const className = user32.func("int32 __stdcall GetClassNameW(void *hwnd, void *name, int32 max)");
  const windowRect = user32.func("int32 __stdcall GetWindowRect(void *hwnd, _Out_ MK_RECT *rect)");
  const monitorFromWindow = user32.func("void * __stdcall MonitorFromWindow(void *hwnd, uint32 flags)");
  const monitorInfo = user32.func("int32 __stdcall GetMonitorInfoW(void *monitor, _Inout_ MK_MONITORINFO *info)");
  const getDC = user32.func("void * __stdcall GetDC(void *hwnd)");
  const releaseDC = user32.func("int32 __stdcall ReleaseDC(void *hwnd, void *dc)");
  const getPixel = gdi32.func("uint32 __stdcall GetPixel(void *dc, int32 x, int32 y)");
  const snapshot = kernel32.func("void * __stdcall CreateToolhelp32Snapshot(uint32 flags, uint32 pid)");
  const firstProcess = kernel32.func("int32 __stdcall Process32FirstW(void *snapshot, _Inout_ MK_PROCESSENTRY32W *entry)");
  const nextProcess = kernel32.func("int32 __stdcall Process32NextW(void *snapshot, _Inout_ MK_PROCESSENTRY32W *entry)");
  const closeHandle = kernel32.func("int32 __stdcall CloseHandle(void *handle)");

  const text = (fn: (...args: any[]) => number, hwnd: unknown) => {
    const buffer = Buffer.alloc(1024);
    const length = fn(hwnd, buffer, 512);
    return buffer.toString("utf16le", 0, Math.max(0, length) * 2);
  };

  function processes() {
    const exe = new Map<number, string>(), children = new Map<number, number[]>();
    const handle = snapshot(TH32CS_SNAPPROCESS, 0);
    if (!handle || koffi.address(handle) === 0xffffffffffffffffn) return { exe, children };
    try {
      const entry: Record<string, unknown> = { dwSize: koffi.sizeof(ENTRY) };
      for (let ok = firstProcess(handle, entry); ok; ok = nextProcess(handle, entry)) {
        const pid = Number(entry.th32ProcessID), parent = Number(entry.th32ParentProcessID);
        exe.set(pid, String(entry.szExeFile));
        if (pid !== parent) { const list = children.get(parent) ?? []; list.push(pid); children.set(parent, list); }
      }
    } finally { closeHandle(handle); }
    return { exe, children };
  }

  function descendants(root: number, tree: ReturnType<typeof processes>) {
    const names = new Set<string>(), seen = new Set<number>([root]);
    const queue = [...(tree.children.get(root) ?? [])];
    for (let i = 0; i < queue.length && names.size < 64; i++) {
      const pid = queue[i]!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      const name = tree.exe.get(pid);
      if (name) names.add(name);
      queue.push(...(tree.children.get(pid) ?? []));
    }
    return [...names];
  }

  return {
    async read() {
      const hwnd = getForegroundWindow();
      if (!hwnd) return null;
      const pidOut: number[] = [0];
      windowProcess(hwnd, pidOut);
      const pid = pidOut[0]!;
      const rect = {} as Win32Rect, info = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {} as Win32Rect, rcWork: {}, dwFlags: 0 };
      const hasRect = !!windowRect(hwnd, rect) && !!monitorInfo(monitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), info);
      const cls = text(className, hwnd);
      const shell = getShellWindow();
      const desktop = (!!shell && koffi.address(hwnd) === koffi.address(shell)) || cls === "Progman" || cls === "WorkerW";
      const m = info.rcMonitor;
      const fullscreen = hasRect && !desktop && rect.left <= m.left && rect.top <= m.top && rect.right >= m.right && rect.bottom >= m.bottom;
      const tree = processes();
      const app = tree.exe.get(pid) ?? "";
      const window: ForegroundWindow = { app, title: text(windowText, hwnd), descendants: isTerminal(app) ? descendants(pid, tree) : [], fullscreen };
      const bounds = hasRect ? toDip({ x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }) : null;
      return { window, pid, anchor: bounds ? { x: bounds.x + bounds.width / 2, y: bounds.y + Math.min(bounds.height / 2, 40) } : null };
    },
    async luminance(points) {
      const dc = getDC(null);
      if (!dc) return points.map(() => null);
      try {
        return points.map(p => {
          const s = toScreen(p);
          const color = getPixel(dc, Math.round(s.x), Math.round(s.y)) >>> 0;
          return color === CLR_INVALID ? null : luminance(color & 0xff, (color >> 8) & 0xff, (color >> 16) & 0xff);
        });
      } finally { releaseDC(null, dc); }
    },
  };
}
