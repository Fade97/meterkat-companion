// The island: a click-through, always-on-top window at the top edge of the display (or of the AI window, when pinned
// to it) that shows while an AI tool is in front. The page
// draws the drop and its animations; this side decides when it is visible, which colour it takes and what it announces.
// The window takes the pointer only while it is on the drop (or the open panel); a click opens the panel with every
// provider, and it closes when clicked again or once the pointer has left it.
import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display, type IpcMainEvent } from "electron";
import { Worker } from "node:worker_threads";
import type { Snapshot } from "../../shared/snapshot.js";
import { isAiWindow } from "./ai-apps.js";
import { linuxProbe, nextTone, threadedProbe, unsupportedReason, windowsPrimaryButton, windowsProbe, x11Pointer, type ForegroundProbe, type ForegroundReading, type KoffiModule, type Point, type Rect, type ScreenCapture } from "./foreground.js";
import { dequeue, enqueue, IslandTracker, type IslandEvent } from "./island-events.js";
import type { BarMode } from "./format.js";
import { hits, islandEdge, missedClicks, PANEL_MAX_HEIGHT, samplePoints, type HitArea, type IslandAnchor, type IslandEdge } from "./island-shape.js";
import { windowEventStream, type WindowEvent } from "./window-events.js";
import { ISLAND_CHANNEL, ISLAND_HIT_CHANNEL, ISLAND_TOGGLE_CHANNEL, type IslandShown, type IslandTone, type IslandUpdate } from "./ipc.js";

/** Tall enough for the open panel; everything outside the drop lets the pointer through. */
export const ISLAND_WINDOW = { width: 440, height: PANEL_MAX_HEIGHT + 24 };
/** How often the pointer is checked while the island is on screen; until then a press on arrival goes to the window below. */
const POINTER_MS = 25;
/** The panel closes once the pointer has been off it this long. */
const LEAVE_MS = 900;
const POLL_MS = 1000;
/** Poll interval while the pinned AI window moves and window events are not available, so the drop keeps up. */
const FOLLOW_MS = 150;
const TONE_MS = 1500;
const EVENTS_MS = 5000;
/** How long an announcement stays open; the page needs about 0.9 s on top to open and close the pill. */
export const HOLD_MS: Record<IslandEvent["kind"], number> = { usage: 4200, "reset-soon": 3400, "reset-done": 3400 };
const SETTLE_MS = 900;
/** Readings in a row without an AI window before the drop retracts, so switching windows does not make it flicker. */
const HIDE_AFTER = 2;

export type IslandOptions = {
  snapshot: () => Snapshot | null;
  enabled: () => boolean;
  mode: () => BarMode;
  /** Top of the screen, or the top edge of the AI window in front. */
  anchor: () => IslandAnchor;
  preload: string;
  page: string;
  /** foreground-worker.cjs: the Win32 probe runs there so it cannot stall the pointer tracking. */
  probeWorker: string;
  /** window-events-worker.cjs: while pinned, moves of the window in front come from there. */
  eventsWorker: string;
  /** Pretends an AI tool is in front and cycles sample announcements (METERKAT_ISLAND_DEMO=1). */
  demo: boolean;
};

export function createIsland(options: IslandOptions) {
  const reason = unsupportedReason(process.platform, process.env);
  const tracker = new IslandTracker();
  let probe: ForegroundProbe | null = null;
  let win: BrowserWindow | null = null;
  let display: Display | null = null, edge: IslandEdge | null = null, moving = false, again = false;
  /** Pushes moves of the window in front while pinned; null when off or failed (then the poll follows the window). */
  let events: ReturnType<typeof windowEventStream> | null = null, eventsFailed = false;
  /** The process of the AI window the last poll saw in front; moves of other windows are ignored. */
  let aiPid: number | null = null;
  let visible = false, hidden = true, misses = 0, failures = 0;
  let tone: IslandTone = "ink";
  let queue: IslandEvent[] = [];
  let current: IslandShown | null = null;
  let busyUntil = 0, quietUntil = 0, toneAt = 0, eventsAt = 0, nextId = 1, demoStep = 0, invisibleSince = 0;
  let timer: NodeJS.Timeout | null = null, polling = false, stopped = true;
  let pointer: NodeJS.Timeout | null = null, area: HitArea | null = null, hover = false, expanded = false, insideAt = 0;
  const missed = missedClicks();

  function createProbe(): ForegroundProbe {
    if (process.platform === "win32") {
      const local = () => windowsProbe(require("koffi") as KoffiModule, rect => screen.screenToDipRect(null, rect), point => screen.dipToScreenPoint(point));
      return threadedProbe(() => new Worker(options.probeWorker), point => screen.screenToDipPoint(point), rect => screen.screenToDipRect(null, rect), point => screen.dipToScreenPoint(point), local);
    }
    return linuxProbe(capture, cursor, () => options.anchor() === "window", dipRect);
  }

  /** The pointer in DIP and whether the primary button is held. Windows reports the point live; X11 is asked directly (see x11Pointer). */
  let x11: ReturnType<typeof x11Pointer> | null | undefined;
  let button: (() => boolean) | null | undefined;
  function pointerState(): { point: Point; pressed: boolean } {
    if (process.platform === "linux" && x11 === undefined) {
      try { x11 = x11Pointer(require("koffi") as KoffiModule); } catch (error) {
        x11 = null;
        console.warn(`Meterkat island: cannot read the pointer from X11 (${error instanceof Error ? error.message : error})`);
      }
    }
    if (process.platform === "win32" && button === undefined) {
      try { button = windowsPrimaryButton(require("koffi") as KoffiModule); } catch { button = null; }
    }
    const x = x11?.();
    if (x) return { point: screen.screenToDipPoint(x), pressed: x.primary };
    return { point: screen.getCursorScreenPoint(), pressed: button?.() ?? false };
  }
  const cursor = () => pointerState().point;

  const capture: ScreenCapture = async displayId => {
    const target = screen.getAllDisplays().find(d => d.id === displayId);
    if (!target) return null;
    const width = Math.round(target.bounds.width / 2), height = Math.round(target.bounds.height / 2);
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
    const source = sources.find(s => s.display_id === String(displayId)) ?? (sources.length === 1 ? sources[0] : undefined);
    if (!source || source.thumbnail.isEmpty()) return null;
    const size = source.thumbnail.getSize();
    return { displayId: String(displayId), width: size.width, height: size.height, bitmap: source.thumbnail.toBitmap(), scale: size.width / target.bounds.width, origin: { x: target.bounds.x, y: target.bounds.y } };
  };

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      ...ISLAND_WINDOW, show: false, frame: false, transparent: true, backgroundColor: "#00000000", resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false, focusable: false,
      alwaysOnTop: true, title: "Meterkat island",
      // A tool window is ignored by Chromium's occlusion tracking, so videos behind the island keep playing (Windows).
      ...(process.platform === "win32" ? { type: "toolbar" } : {}),
      webPreferences: { preload: options.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false },
    });
    win.setIgnoreMouseEvents(true);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.on("did-finish-load", send);
    win.on("closed", () => { win = null; hidden = true; area = null; hover = false; expanded = false; });
    void win.loadFile(options.page);
    return win;
  }

  function place(at: IslandEdge) {
    if (!win) return;
    const bounds = { x: Math.round(at.cx - ISLAND_WINDOW.width / 2), y: at.y, ...ISLAND_WINDOW };
    win.setBounds(bounds);
    // Moving to a display with another scale factor applies the old factor first (Windows).
    if (process.platform === "win32") win.setBounds(bounds);
  }

  /** Puts the island on `frame`'s top edge (pinned) or on the display nearest `near`; true when it had to move. */
  function position(frame: Rect | null, near: Point | null) {
    const anchor = options.anchor(), pinned = anchor === "window" ? frame : null;
    const point = pinned ? { x: pinned.x + pinned.width / 2, y: pinned.y } : near;
    const target = point ? screen.getDisplayNearestPoint(point) : screen.getPrimaryDisplay();
    const next = islandEdge(anchor, target.bounds, pinned, ISLAND_WINDOW.width / 2);
    const moved = !edge || next.cx !== edge.cx || next.y !== edge.y;
    if (!display || target.id !== display.id || hidden || moved) { display = target; edge = next; ensureWindow(); place(next); }
    return moved && !!pinned;
  }

  /** Window events run only while pinned and shown; they replace the fast poll that otherwise follows the window. */
  function syncEvents() {
    const want = !reason && !options.demo && !eventsFailed && options.enabled() && options.anchor() === "window";
    if (want && !events) events = windowEventStream(() => new Worker(options.eventsWorker), onWindowEvent, failure => {
      events = null; eventsFailed = true;
      console.warn(`Meterkat island: window events unavailable, following the window by polling (${failure})`);
    });
    if (!want && events) { events.close(); events = null; }
  }
  function onWindowEvent(event: WindowEvent) {
    if (stopped) return;
    // Another window in front: classify it now instead of within a second.
    if (event.type === "foreground") { if (polling) again = true; else schedule(0); return; }
    if (event.pid !== aiPid || hidden || expanded || options.anchor() !== "window") return;
    position(dipRect(event.bounds), null);
  }

  function send() {
    if (!win || win.isDestroyed()) return;
    const update: IslandUpdate = { visible, tone, event: current, now: Date.now(), mode: options.mode(), hover, expanded, snapshot: expanded ? options.snapshot() : null };
    win.webContents.send(ISLAND_CHANNEL, update);
  }

  function hideWindow() {
    visible = false; current = null; misses = 0; release();
    if (win && !win.isDestroyed() && !hidden) { send(); win.hide(); }
    hidden = true;
  }

  // ---- Pointer and panel -------------------------------------------------------------------------------------

  /** Lets the pointer through again and closes the panel. */
  function release() {
    expanded = false;
    if (hover) { hover = false; if (win && !win.isDestroyed()) win.setIgnoreMouseEvents(true); }
  }

  function setExpanded(next: boolean) {
    if (next === expanded || (next && !visible)) return;
    expanded = next;
    // An announcement in progress gives way to the panel; queued ones wait until it has closed.
    if (expanded) current = null; else quietUntil = Date.now() + SETTLE_MS;
    send();
  }

  function track() {
    if (!win || win.isDestroyed() || hidden) return;
    const now = Date.now(), { point, pressed } = pointerState();
    const inside = visible && hits(win.getBounds(), area, point);
    // Compared with the pointer state before this poll: was the window still letting the press through?
    const click = missed(pressed, inside, hover);
    if (inside !== hover) { hover = inside; win.setIgnoreMouseEvents(!inside); send(); }
    if (inside) insideAt = now;
    else if (expanded && now - insideAt > LEAVE_MS) setExpanded(false);
    if (click) setExpanded(!expanded);
  }

  const fromPage = (event: IpcMainEvent) => !!win && !win.isDestroyed() && event.sender === win.webContents;
  const onHitArea = (event: IpcMainEvent, next: unknown) => {
    if (!fromPage(event)) return;
    const value = next as HitArea | null;
    area = value && [value.x, value.y, value.width, value.height].every(Number.isFinite) ? { x: value.x, y: value.y, width: value.width, height: value.height } : null;
  };
  // Only a click while the pointer is on the island counts; the window lets every other click through anyway.
  const onToggle = (event: IpcMainEvent) => { if (fromPage(event) && hover) { insideAt = Date.now(); setExpanded(!expanded); } };

  async function read(): Promise<ForegroundReading | null> {
    if (options.demo) return { window: { app: "claude", title: "Claude", descendants: [], fullscreen: false }, anchor: cursor(), bounds: null, pid: 0 };
    probe ??= createProbe();
    return probe.read();
  }

  function demoEvents(now: number): IslandEvent[] {
    if (now < eventsAt) return [];
    const base = { at: now, expiresAt: now + 60_000 };
    const samples: IslandEvent[] = [
      { ...base, key: "claude:5-hour", provider: "claude", label: "5-hour", kind: "usage", from: 41, to: 63 },
      { ...base, key: "codex:5-hour", provider: "codex", label: "5-hour", kind: "reset-soon", resetsAt: now + 10 * 60_000, usedPercent: 92 },
      { ...base, key: "claude:Weekly", provider: "claude", label: "Weekly", kind: "reset-done" },
      { ...base, key: "antigravity:Gemini Pro", provider: "antigravity", label: "Gemini Pro", kind: "usage", from: 12, to: 47 },
    ];
    const event = samples[demoStep % samples.length]!;
    if (demoStep % 2 === 0 && demoStep > 0) tone = tone === "ink" ? "white" : "ink";
    demoStep++;
    return [event];
  }

  async function poll() {
    const now = Date.now();
    syncEvents();
    if (reason || !options.enabled()) { hideWindow(); return; }
    let reading: ForegroundReading | null = null;
    try { reading = await read(); failures = 0; } catch (error) {
      if (++failures === 5) console.warn(`Meterkat island: cannot read the foreground window (${error instanceof Error ? error.message : error})`);
    }
    if (reading?.window.fullscreen && reading.pid !== process.pid) { hideWindow(); return; }
    const ai = !!reading && reading.pid !== process.pid && isAiWindow(reading.window);
    misses = ai ? 0 : misses + 1;
    const nextVisible = ai || (visible && misses < HIDE_AFTER);

    aiPid = ai && reading ? reading.pid : null;
    moving = false;
    if (ai && reading && !expanded) {
      const shown = !!edge && !hidden;
      // A pinned island that had to move is probably following a drag; without window events, look again soon.
      moving = position(reading.bounds, reading.anchor) && shown && !events;
    }
    if (nextVisible && hidden && win) { win.showInactive(); hidden = false; }
    if (!hidden && win && process.platform === "win32") win.setAlwaysOnTop(true, "screen-saver"); // others may have risen above
    const changed = nextVisible !== visible;
    visible = nextVisible;
    if (changed && !visible) release();
    if (changed && !visible) invisibleSince = now;
    // Let the drop form before it opens into an announcement.
    if (changed && visible) quietUntil = Math.max(quietUntil, now + 1400);
    // Once the drop has retracted, the window itself goes away until an AI tool is in front again.
    if (!visible && !hidden && win && now - invisibleSince > 3000) { win.hide(); hidden = true; }

    if (visible && display && edge && !options.demo && now >= toneAt) {
      toneAt = now + TONE_MS;
      try {
        const next = nextTone(tone, await probe!.luminance(samplePoints(edge), display.id));
        if (next !== tone) { tone = next; send(); }
      } catch { /* keep the current tone */ }
    }

    if (now >= eventsAt || options.demo) {
      const fresh = options.demo ? demoEvents(now) : tracker.update(options.snapshot(), now);
      if (options.demo && fresh.length) eventsAt = now + 7000;
      else if (!options.demo) eventsAt = now + EVENTS_MS;
      queue = enqueue(queue, fresh);
    }

    if (current && (now >= busyUntil || !visible)) { current = null; quietUntil = now + SETTLE_MS; send(); }
    else if (!current && visible && !expanded && now >= quietUntil) {
      const { event, rest } = dequeue(queue, now);
      queue = rest;
      if (event) { current = { ...event, id: nextId++, holdMs: HOLD_MS[event.kind] }; busyUntil = now + HOLD_MS[event.kind] + 600; send(); }
      else if (changed) send();
    } else if (changed) send();
  }

  function schedule(ms: number) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, ms);
  }
  function loop() {
    timer = null; polling = true;
    void poll().finally(() => {
      polling = false;
      if (!stopped) schedule(again ? 0 : moving ? FOLLOW_MS : POLL_MS);
      again = false;
    });
  }

  return {
    /** Why the island is unavailable here, or null. */
    unsupported: reason,
    start() {
      if (!stopped) return;
      stopped = false; schedule(0);
      ipcMain.on(ISLAND_HIT_CHANNEL, onHitArea); ipcMain.on(ISLAND_TOGGLE_CHANNEL, onToggle);
      pointer = setInterval(track, POINTER_MS);
    },
    /** Re-reads settings and the snapshot right away, e.g. after a sync or when switched on or off. */
    refresh() { eventsAt = 0; if (expanded) send(); if (!stopped && !polling) schedule(0); },
    stop() {
      stopped = true; if (timer) clearTimeout(timer); timer = null;
      if (pointer) clearInterval(pointer); pointer = null;
      ipcMain.off(ISLAND_HIT_CHANNEL, onHitArea); ipcMain.off(ISLAND_TOGGLE_CHANNEL, onToggle);
      if (win && !win.isDestroyed()) win.destroy(); win = null;
      probe?.close?.(); probe = null;
      events?.close(); events = null;
    },
  };
}

/** Screen pixels → DIP. Electron converts rectangles only on Windows; on X11 the corners are converted instead. */
function dipRect(rect: Rect): Rect {
  if (process.platform === "win32") return screen.screenToDipRect(null, rect);
  const from = screen.screenToDipPoint({ x: rect.x, y: rect.y }), to = screen.screenToDipPoint({ x: rect.x + rect.width, y: rect.y + rect.height });
  return { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y };
}
