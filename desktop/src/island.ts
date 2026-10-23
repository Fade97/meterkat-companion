// The island: a click-through, always-on-top window at the top edge of the display that shows an AI tool. The page
// draws the drop and its animations; this side decides when it is visible, which colour it takes and what it announces.
// The window takes the pointer only while it is on the drop (or the open panel); a click opens the panel with every
// provider, and it closes when clicked again or once the pointer has left it.
import { BrowserWindow, desktopCapturer, ipcMain, screen, type Display, type IpcMainEvent } from "electron";
import type { Snapshot } from "../../shared/snapshot.js";
import { isAiWindow } from "./ai-apps.js";
import { linuxProbe, nextTone, unsupportedReason, windowsProbe, x11Pointer, type ForegroundProbe, type ForegroundReading, type KoffiModule, type Point, type ScreenCapture } from "./foreground.js";
import { dequeue, enqueue, IslandTracker, type IslandEvent } from "./island-events.js";
import type { BarMode } from "./format.js";
import { hits, PANEL_MAX_HEIGHT, samplePoints, type HitArea } from "./island-shape.js";
import { ISLAND_CHANNEL, ISLAND_HIT_CHANNEL, ISLAND_TOGGLE_CHANNEL, type IslandShown, type IslandTone, type IslandUpdate } from "./ipc.js";

/** Tall enough for the open panel; everything outside the drop lets the pointer through. */
export const ISLAND_WINDOW = { width: 440, height: PANEL_MAX_HEIGHT + 24 };
/** How often the pointer is checked while the island is on screen. */
const POINTER_MS = 50;
/** The panel closes once the pointer has been off it this long. */
const LEAVE_MS = 900;
const POLL_MS = 1000;
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
  preload: string;
  page: string;
  /** Pretends an AI tool is in front and cycles sample announcements (METERKAT_ISLAND_DEMO=1). */
  demo: boolean;
};

export function createIsland(options: IslandOptions) {
  const reason = unsupportedReason(process.platform, process.env);
  const tracker = new IslandTracker();
  let probe: ForegroundProbe | null = null;
  let win: BrowserWindow | null = null;
  let display: Display | null = null;
  let visible = false, hidden = true, misses = 0, failures = 0;
  let tone: IslandTone = "ink";
  let queue: IslandEvent[] = [];
  let current: IslandShown | null = null;
  let busyUntil = 0, quietUntil = 0, toneAt = 0, eventsAt = 0, nextId = 1, demoStep = 0, invisibleSince = 0;
  let timer: NodeJS.Timeout | null = null, polling = false, stopped = true;
  let pointer: NodeJS.Timeout | null = null, area: HitArea | null = null, hover = false, expanded = false, insideAt = 0;

  function createProbe(): ForegroundProbe {
    if (process.platform === "win32") {
      const koffi = require("koffi") as KoffiModule;
      return windowsProbe(koffi, rect => screen.screenToDipRect(null, rect), point => screen.dipToScreenPoint(point));
    }
    return linuxProbe(capture, cursor);
  }

  /** The pointer in DIP. Windows reports it live; X11 is asked directly (see x11Pointer). */
  let x11: (() => Point | null) | null | undefined;
  function cursor(): Point {
    if (process.platform === "linux" && x11 === undefined) {
      try { x11 = x11Pointer(require("koffi") as KoffiModule); } catch (error) {
        x11 = null;
        console.warn(`Meterkat island: cannot read the pointer from X11 (${error instanceof Error ? error.message : error})`);
      }
    }
    const point = x11?.();
    return point ? screen.screenToDipPoint(point) : screen.getCursorScreenPoint();
  }

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

  function place(target: Display) {
    if (!win) return;
    const bounds = { x: Math.round(target.bounds.x + (target.bounds.width - ISLAND_WINDOW.width) / 2), y: target.bounds.y, ...ISLAND_WINDOW };
    win.setBounds(bounds);
    // Moving to a display with another scale factor applies the old factor first (Windows).
    if (process.platform === "win32") win.setBounds(bounds);
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
    const now = Date.now();
    const inside = visible && hits(win.getBounds(), area, cursor());
    if (inside !== hover) { hover = inside; win.setIgnoreMouseEvents(!inside); send(); }
    if (inside) insideAt = now;
    else if (expanded && now - insideAt > LEAVE_MS) setExpanded(false);
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
    if (options.demo) return { window: { app: "claude", title: "Claude", descendants: [], fullscreen: false }, anchor: cursor(), pid: 0 };
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
    if (reason || !options.enabled()) { hideWindow(); return; }
    let reading: ForegroundReading | null = null;
    try { reading = await read(); failures = 0; } catch (error) {
      if (++failures === 5) console.warn(`Meterkat island: cannot read the foreground window (${error instanceof Error ? error.message : error})`);
    }
    if (reading?.window.fullscreen && reading.pid !== process.pid) { hideWindow(); return; }
    const ai = !!reading && reading.pid !== process.pid && isAiWindow(reading.window);
    misses = ai ? 0 : misses + 1;
    const nextVisible = ai || (visible && misses < HIDE_AFTER);

    if (ai && reading && !expanded) {
      const target = reading.anchor ? screen.getDisplayNearestPoint(reading.anchor) : screen.getPrimaryDisplay();
      if (!display || target.id !== display.id || hidden) { display = target; ensureWindow(); place(target); }
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

    if (visible && display && !options.demo && now >= toneAt) {
      toneAt = now + TONE_MS;
      try {
        const next = nextTone(tone, await probe!.luminance(samplePoints(display), display.id));
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
    void poll().finally(() => { polling = false; if (!stopped) schedule(POLL_MS); });
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
    },
  };
}
