// Window events for the pinned island: which window is in front and where it is, pushed by the system instead of
// polled. Windows uses WinEvent hooks, X11 an own xcb connection. Both run in window-events-worker.ts, work in screen
// pixels and report the foreground window's process, so the main process can ignore windows that are not AI tools.
import type { KoffiModule, Rect } from "./foreground.js";
import { visibleFrame } from "./foreground.js";

/** A new window came to the front (pid 0: unknown), or the one in front moved or changed size. Screen pixels. */
export type WindowEvent = { type: "foreground"; pid: number } | { type: "bounds"; pid: number; bounds: Rect };
type Post = (event: WindowEvent) => void;

/** Lets a burst of moves through at most once every `ms`; `wait` says how long until the next may go. */
export function throttle(ms: number) {
  let last = -Infinity;
  return {
    wait: (now: number) => Math.max(0, last + ms - now),
    take(now: number) { if (now - last < ms) return false; last = now; return true; },
  };
}
/** One bounds update per frame at 120 Hz is plenty; a drag reports the position far more often. */
const BOUNDS_MS = 8;
/** How long a worker blocks while nothing happens; it can be stopped in between. */
const IDLE_MS = 250;

/** The part of a worker_threads Worker the stream uses. */
export interface EventWorker {
  on(event: "message", listener: (event: WindowEvent) => void): unknown;
  on(event: "error" | "exit", listener: (reason: unknown) => void): unknown;
  terminate(): unknown;
}

/** Runs the worker and forwards its events. `onFail` is called once if it cannot start or stops by itself. */
export function windowEventStream(start: () => EventWorker, onEvent: (event: WindowEvent) => void, onFail: (reason: string) => void) {
  let worker: EventWorker | null = null;
  const fail = (reason: unknown) => {
    if (!worker) return;
    worker = null;
    onFail(reason instanceof Error ? reason.message : `worker stopped (${String(reason)})`);
  };
  try {
    worker = start();
    worker.on("message", event => { if (worker) onEvent(event); });
    worker.on("error", fail);
    worker.on("exit", fail);
  } catch (error) { worker = { on: () => undefined, terminate: () => undefined }; fail(error); }
  return { close() { const running = worker; worker = null; void running?.terminate(); } };
}

/** Calls `step` again and again, giving the worker's event loop a turn in between (so it can be terminated). */
function loop(step: () => void) {
  const next = () => { step(); setImmediate(next); };
  setImmediate(next);
}

// ---- Windows -----------------------------------------------------------------------------------------------------

const EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_OBJECT_LOCATIONCHANGE = 0x800b, WINEVENT_OUTOFCONTEXT = 0;
const OBJID_WINDOW = 0, CHILDID_SELF = 0, QS_ALLINPUT = 0x04ff, MWMO_INPUTAVAILABLE = 0x0004, PM_REMOVE = 0x0001;
const DWMWA_EXTENDED_FRAME_BOUNDS = 9;

/**
 * Foreground changes come from a global hook (rare); moves only from a hook on the foreground window's process,
 * re-registered whenever another window comes to the front, so the rest of the desktop costs nothing. Out-of-context
 * hooks are delivered through this thread's message queue, hence the pump.
 */
export function win32WindowEvents(koffi: KoffiModule & { proto(definition: string): unknown; register(callback: Function, type: unknown): unknown; pointer(type: unknown): unknown }, post: Post) {
  const user32 = koffi.load("user32.dll"), dwmapi = koffi.load("dwmapi.dll");
  const RECT = koffi.struct("MKE_RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });
  const proc = koffi.proto("void __stdcall MKE_WinEventProc(void *hook, uint32 event, void *hwnd, int32 object, int32 child, uint32 thread, uint32 time)");
  const setHook = user32.func("void * __stdcall SetWinEventHook(uint32 eventMin, uint32 eventMax, void *module, MKE_WinEventProc *proc, uint32 pid, uint32 thread, uint32 flags)");
  const unhook = user32.func("int32 __stdcall UnhookWinEvent(void *hook)");
  const foregroundWindow = user32.func("void * __stdcall GetForegroundWindow()");
  const windowProcess = user32.func("uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)");
  const windowRect = user32.func("int32 __stdcall GetWindowRect(void *hwnd, _Out_ MKE_RECT *rect)");
  const frameBounds = dwmapi.func("int32 __stdcall DwmGetWindowAttribute(void *hwnd, uint32 attribute, _Out_ MKE_RECT *value, uint32 size)");
  const wait = user32.func("uint32 __stdcall MsgWaitForMultipleObjectsEx(uint32 count, void *handles, uint32 ms, uint32 wake, uint32 flags)");
  const peek = user32.func("int32 __stdcall PeekMessageW(void *msg, void *hwnd, uint32 min, uint32 max, uint32 remove)");
  const translate = user32.func("int32 __stdcall TranslateMessage(void *msg)");
  const dispatch = user32.func("intptr_t __stdcall DispatchMessageW(void *msg)");

  let hwnd: unknown = null, address = 0n, pid = 0, moveHook: unknown = null, switched = true, moved = false;
  const callback = koffi.register((_hook: unknown, event: number, window: unknown, object: number, child: number) => {
    if (event === EVENT_SYSTEM_FOREGROUND) switched = true;
    else if (object === OBJID_WINDOW && child === CHILDID_SELF && window && koffi.address(window) === address) moved = true;
  }, koffi.pointer(proc));
  if (!setHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, null, callback, 0, 0, WINEVENT_OUTOFCONTEXT)) throw new Error("SetWinEventHook failed");

  function follow() {
    hwnd = foregroundWindow();
    address = hwnd ? koffi.address(hwnd) : 0n;
    const out = [0];
    pid = hwnd && windowProcess(hwnd, out) ? out[0]! : 0;
    if (moveHook) unhook(moveHook);
    moveHook = pid ? setHook(EVENT_OBJECT_LOCATIONCHANGE, EVENT_OBJECT_LOCATIONCHANGE, null, callback, pid, 0, WINEVENT_OUTOFCONTEXT) : null;
    post({ type: "foreground", pid });
  }
  function bounds() {
    if (!hwnd) return;
    const visible = {} as Record<string, number>, rect = {} as Record<string, number>;
    const frame = frameBounds(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, visible, koffi.sizeof(RECT)) === 0 ? visible : windowRect(hwnd, rect) ? rect : null;
    if (frame) post({ type: "bounds", pid, bounds: { x: frame.left!, y: frame.top!, width: frame.right! - frame.left!, height: frame.bottom! - frame.top! } });
  }

  const message = Buffer.alloc(64), pace = throttle(BOUNDS_MS);
  loop(() => {
    wait(0, null, moved ? pace.wait(Date.now()) : IDLE_MS, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    while (peek(message, null, 0, 0, PM_REMOVE)) { translate(message); dispatch(message); }
    if (switched) { switched = false; follow(); moved = true; }
    if (moved && pace.take(Date.now())) { moved = false; bounds(); }
  });
}

// ---- Linux (X11 through xcb) -------------------------------------------------------------------------------------

const XCB_CW_EVENT_MASK = 1 << 11, XCB_EVENT_MASK_STRUCTURE_NOTIFY = 1 << 17, XCB_EVENT_MASK_PROPERTY_CHANGE = 1 << 22;
const XCB_ATOM_CARDINAL = 6, XCB_ATOM_WINDOW = 33;
const XCB_MAP_NOTIFY = 19, XCB_REPARENT_NOTIFY = 21, XCB_CONFIGURE_NOTIFY = 22, XCB_PROPERTY_NOTIFY = 28;

/** What an xcb event means here: the active window may have changed, the followed window may have moved, or neither. */
export function xcbEventKind(type: number, atom: number, activeAtom: number): "switched" | "moved" | null {
  const kind = type & 0x7f; // the high bit marks events sent by another client (the window manager's synthetic ConfigureNotify)
  if (kind === XCB_PROPERTY_NOTIFY) return atom === activeAtom ? "switched" : null;
  return kind === XCB_CONFIGURE_NOTIFY || kind === XCB_REPARENT_NOTIFY || kind === XCB_MAP_NOTIFY ? "moved" : null;
}

/**
 * An own connection, so errors (a window that has just gone away) come back as events and no process-wide Xlib error
 * handler is needed, which would clash with Chromium's. Listens to the root window for _NET_ACTIVE_WINDOW and to the
 * active window and its window-manager frame for moves and resizes.
 */
export function x11WindowEvents(koffi: KoffiModule & { decode(value: unknown, offset: number, type: string): any }, post: Post) {
  const xcb = koffi.load("libxcb.so.1"), libc = koffi.load("libc.so.6");
  koffi.struct("MKE_cookie", { sequence: "uint32" });
  koffi.struct("MKE_screen_iterator", { data: "void *", rem: "int", index: "int" });
  const connect = xcb.func("void *xcb_connect(const char *display, _Out_ int *screen)");
  const hasError = xcb.func("int xcb_connection_has_error(void *c)");
  const setup = xcb.func("void *xcb_get_setup(void *c)");
  const roots = xcb.func("MKE_screen_iterator xcb_setup_roots_iterator(void *setup)");
  const nextScreen = xcb.func("void xcb_screen_next(_Inout_ MKE_screen_iterator *iterator)");
  const descriptor = xcb.func("int xcb_get_file_descriptor(void *c)");
  const flush = xcb.func("int xcb_flush(void *c)");
  const pollEvent = xcb.func("void *xcb_poll_for_event(void *c)");
  const internAtom = xcb.func("MKE_cookie xcb_intern_atom(void *c, uint8 onlyIfExists, uint16 length, const char *name)");
  const internAtomReply = xcb.func("void *xcb_intern_atom_reply(void *c, MKE_cookie cookie, void *error)");
  const changeAttributes = xcb.func("MKE_cookie xcb_change_window_attributes(void *c, uint32 window, uint32 mask, const uint32 *values)");
  const getProperty = xcb.func("MKE_cookie xcb_get_property(void *c, uint8 remove, uint32 window, uint32 property, uint32 type, uint32 offset, uint32 length)");
  const getPropertyReply = xcb.func("void *xcb_get_property_reply(void *c, MKE_cookie cookie, void *error)");
  const getGeometry = xcb.func("MKE_cookie xcb_get_geometry(void *c, uint32 drawable)");
  const getGeometryReply = xcb.func("void *xcb_get_geometry_reply(void *c, MKE_cookie cookie, void *error)");
  const translate = xcb.func("MKE_cookie xcb_translate_coordinates(void *c, uint32 source, uint32 target, int16 x, int16 y)");
  const translateReply = xcb.func("void *xcb_translate_coordinates_reply(void *c, MKE_cookie cookie, void *error)");
  const queryTree = xcb.func("MKE_cookie xcb_query_tree(void *c, uint32 window)");
  const queryTreeReply = xcb.func("void *xcb_query_tree_reply(void *c, MKE_cookie cookie, void *error)");
  // xcb allocates replies with whatever malloc the process uses; in Electron that is Chromium's allocator, so free
  // must come from the process's global symbols too, not straight from libc (that aborts with "invalid pointer").
  const free = (koffi.load as (path: string | null) => ReturnType<KoffiModule["load"]>)(null).func("void free(void *pointer)");
  const poll = libc.func("int poll(void *fds, uint64 count, int timeout)");

  const screen = [0];
  const c = connect(null, screen);
  if (!c || hasError(c)) throw new Error("Cannot connect to the X server");
  const iterator = roots(setup(c));
  for (let i = 0; i < screen[0]!; i++) nextScreen(iterator);
  const root: number = koffi.decode(iterator.data, 0, "uint32");

  /** Reads a reply (offsets per the X protocol's reply layouts) and frees it; null when the request failed. */
  const read = <T>(reply: unknown, parse: (reply: unknown) => T): T | null => {
    if (!reply) return null;
    try { return parse(reply); } finally { free(reply); }
  };
  const atom = (name: string) => read(internAtomReply(c, internAtom(c, 0, name.length, name), null), r => koffi.decode(r, 8, "uint32") as number) ?? 0;
  /** The 32-bit values of a property (value_len at 16, data at 32). */
  const property = (window: number, name: number, type: number, length: number) => read(getPropertyReply(c, getProperty(c, 0, window, name, type, 0, length), null), r => {
    const count = Math.min(koffi.decode(r, 16, "uint32") as number, length);
    return Array.from({ length: count }, (_, i) => koffi.decode(r, 32 + 4 * i, "uint32") as number);
  }) ?? [];
  const extents = (window: number, name: number) => {
    const [left, right, top, bottom] = property(window, name, XCB_ATOM_CARDINAL, 4);
    return bottom === undefined ? null : { left: left!, right: right!, top: top!, bottom };
  };
  /** The window manager's frame around `window`: its ancestor just below the root (the window itself without a frame). */
  function frameOf(window: number) {
    let current = window;
    for (let depth = 0; depth < 16; depth++) {
      const parent = read(queryTreeReply(c, queryTree(c, current), null), r => koffi.decode(r, 12, "uint32") as number);
      if (!parent || parent === root) return current;
      current = parent;
    }
    return current;
  }
  const listen = (window: number, mask: number) => { if (window) changeAttributes(c, window, XCB_CW_EVENT_MASK, [mask]); };

  const ACTIVE = atom("_NET_ACTIVE_WINDOW"), PID = atom("_NET_WM_PID"), FRAME = atom("_NET_FRAME_EXTENTS"), SHADOW = atom("_GTK_FRAME_EXTENTS");
  listen(root, XCB_EVENT_MASK_PROPERTY_CHANGE);
  let window = 0, frame = 0, pid = 0, switched = true, moved = false;

  function follow() {
    const next = property(root, ACTIVE, XCB_ATOM_WINDOW, 1)[0] ?? 0;
    if (next !== window) {
      // Stop listening to the previous window; only this connection's selection changes.
      listen(window, 0); if (frame !== window) listen(frame, 0);
      window = next; frame = next ? frameOf(next) : 0;
      listen(window, XCB_EVENT_MASK_STRUCTURE_NOTIFY); if (frame !== window) listen(frame, XCB_EVENT_MASK_STRUCTURE_NOTIFY);
      pid = next ? property(next, PID, XCB_ATOM_CARDINAL, 1)[0] ?? 0 : 0;
    }
    post({ type: "foreground", pid });
  }
  function bounds() {
    if (!window) return;
    const origin = read(translateReply(c, translate(c, window, root, 0, 0), null), r => ({ x: koffi.decode(r, 12, "int16") as number, y: koffi.decode(r, 14, "int16") as number }));
    const size = read(getGeometryReply(c, getGeometry(c, window), null), r => ({ width: koffi.decode(r, 16, "uint16") as number, height: koffi.decode(r, 18, "uint16") as number }));
    if (origin && size && size.width > 0 && size.height > 0) post({ type: "bounds", pid, bounds: visibleFrame({ ...origin, ...size }, extents(window, FRAME), extents(window, SHADOW)) });
  }

  const fds = Buffer.alloc(8), pace = throttle(BOUNDS_MS);
  fds.writeInt32LE(descriptor(c), 0); fds.writeInt16LE(1, 4); // POLLIN
  flush(c);
  loop(() => {
    if (hasError(c)) throw new Error("Lost the connection to the X server");
    poll(fds, 1, moved || switched ? pace.wait(Date.now()) : IDLE_MS);
    for (let event = pollEvent(c); event; event = pollEvent(c)) {
      const kind = xcbEventKind(koffi.decode(event, 0, "uint8"), koffi.decode(event, 8, "uint32"), ACTIVE);
      free(event);
      if (kind === "switched") switched = true; else if (kind === "moved") moved = true;
    }
    if (switched) { switched = false; follow(); moved = true; }
    if (moved && pace.take(Date.now())) { moved = false; bounds(); }
    flush(c);
  });
}
