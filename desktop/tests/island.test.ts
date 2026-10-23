import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderUsage, Snapshot } from "../../shared/snapshot.js";
import { isAiWindow, type ForegroundWindow } from "../src/ai-apps.js";
import { linuxDescendants, luminance, nextTone, parseActiveWindow, parseWindowProps, threadedProbe, unsupportedReason, type ForegroundProbe, type ProbeRequest, type ProbeResponse, type ProbeWorker } from "../src/foreground.js";
import { dequeue, enqueue, IslandTracker, type IslandEvent } from "../src/island-events.js";
import { hits, islandFootprint, islandPath, ISLAND_SIZES, missedClicks, samplePoints } from "../src/island-shape.js";

const now = 1_800_000_000_000;
const MIN = 60_000;

test("the outline leaves the edge tangentially and meets the circle at its widest points", () => {
  // Circle r = 15 centred 17 below the edge (gap 2), side arcs 15 wide.
  const d = islandPath({ cx: 100, top: 2, w: 30, h: 30, fillet: 15 });
  assert.equal(d, "M70,-2L70,0A15,17 0 0 1 85,17A15,15 0 0 0 100,32L100,32A15,15 0 0 0 115,17A15,17 0 0 1 130,0L130,-2Z");
  // The arc ends at the circle's leftmost point (cx - r, cy) and starts on the edge one arc width further out.
  assert.match(d, /A15,17 0 0 1 85,17/);
  assert.equal(islandFootprint({ cx: 100, ...ISLAND_SIZES.idle }), 60);
  assert.equal(islandPath({ cx: 100, top: 0, w: 0, h: 0, fillet: 0 }), "");
});

test("a pill keeps its straight bottom between the two end caps", () => {
  const d = islandPath({ cx: 200, top: 2, w: 300, h: 50, fillet: 19 });
  assert.match(d, /^M31,-2L31,0A19,27 0 0 1 50,27A25,25 0 0 0 75,52L325,52A25,25 0 0 0 350,27A19,27 0 0 1 369,0L369,-2Z$/);
});

test("the panel is a rounded rectangle whose sides run straight down from the side arcs", () => {
  const d = islandPath({ cx: 200, top: 2, w: 380, h: 200, fillet: 19, radius: 22 });
  // Upper corner centres 24 below the edge (gap 2 + radius 22), lower ones at 202 - 22 = 180.
  assert.equal(d, "M-9,-2L-9,0A19,24 0 0 1 10,24L10,180A22,22 0 0 0 32,202L368,202A22,22 0 0 0 390,180L390,24A19,24 0 0 1 409,0L409,-2Z");
  assert.equal(islandFootprint({ cx: 0, ...ISLAND_SIZES.panel }), 418);
  // A radius above h / 2 is the pill again.
  assert.equal(islandPath({ cx: 200, top: 2, w: 300, h: 50, fillet: 19, radius: 80 }), islandPath({ cx: 200, top: 2, w: 300, h: 50, fillet: 19 }));
});

test("the pointer is on the island only inside its hit area", () => {
  const bounds = { x: 740, y: 0 }, area = { x: 200, y: 0, width: 40, height: 36 };
  assert.equal(hits(bounds, area, { x: 960, y: 10 }), true);
  assert.equal(hits(bounds, area, { x: 960, y: 37 }), false);
  assert.equal(hits(bounds, area, { x: 939, y: 10 }), false);
  assert.equal(hits(bounds, null, { x: 960, y: 10 }), false);
});

const provider = (id: string, five: number, resetsAt: number, state: ProviderUsage["state"] = "ok"): ProviderUsage =>
  ({ id, state, sampledAt: now, windows: { fiveHour: { usedPercent: five, resetsAt } } });
const snap = (...providers: ProviderUsage[]): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: now, providers });
const kinds = (events: IslandEvent[]) => events.map(e => e.kind === "usage" ? `usage ${e.provider} ${e.from}->${e.to}` : `${e.kind} ${e.provider}`);

test("a press that reaches the drop before the window takes the pointer still counts as a click", () => {
  const missed = missedClicks();
  // Pressed on arrival while the window still let the pointer through, released on the island.
  assert.equal(missed(false, false, false), false);
  assert.equal(missed(true, true, false), false);
  assert.equal(missed(true, true, true), false);
  assert.equal(missed(false, true, true), true);
  // Pressed while the window already took the pointer: the page sees that click itself.
  assert.equal(missed(true, true, true), false);
  assert.equal(missed(false, true, true), false);
  // Released off the island, or pressed elsewhere and dragged onto it: no click.
  assert.equal(missed(true, true, false), false);
  assert.equal(missed(false, false, true), false);
  assert.equal(missed(true, false, false), false);
  assert.equal(missed(false, true, true), false);
});

test("usage is announced after a jump of 10 points or when it crosses 50, 75 or 90 %", () => {
  const t = new IslandTracker(), reset = now + 5 * 3_600_000;
  assert.deepEqual(kinds(t.update(snap(provider("claude", 30, reset)), now)), [], "first sight only sets the baseline");
  assert.deepEqual(kinds(t.update(snap(provider("claude", 38, reset)), now)), []);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 41, reset)), now)), ["usage claude 30->41"]);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 41, reset)), now)), [], "unchanged data says nothing twice");
  assert.deepEqual(kinds(t.update(snap(provider("claude", 50, reset)), now)), ["usage claude 41->50"], "crossed 50 %");
  assert.deepEqual(kinds(t.update(snap(provider("claude", 58, reset)), now)), []);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 76, reset)), now)), ["usage claude 50->76"]);
  // A drop (reset) sets a new baseline instead of announcing.
  assert.deepEqual(kinds(t.update(snap(provider("claude", 2, reset)), now)), []);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 9, reset)), now)), []);
  // Stale data never announces a jump.
  assert.deepEqual(kinds(t.update(snap(provider("claude", 40, reset, "unavailable")), now)), []);
});

test("resets are announced 60, 30, 10, 5 and 1 minutes ahead and once afterwards", () => {
  const t = new IslandTracker(), resetsAt = now + 90 * MIN;
  const at = (minutesLeft: number) => resetsAt - minutesLeft * MIN;
  const run = (minutesLeft: number) => kinds(t.update(snap(provider("codex", 70, resetsAt)), at(minutesLeft)));
  assert.deepEqual(run(90), []);
  assert.deepEqual(run(61), []);
  assert.deepEqual(run(59.9), ["reset-soon codex"]);
  assert.deepEqual(run(45), []);
  assert.deepEqual(run(30), ["reset-soon codex"]);
  // A long gap (sleep) announces only the most urgent milestone, not every missed one.
  assert.deepEqual(run(4), ["reset-soon codex"]);
  assert.deepEqual(run(2), []);
  assert.deepEqual(run(0.5), ["reset-soon codex"]);
  assert.deepEqual(run(-0.1), ["reset-done codex"]);
  assert.deepEqual(run(-1), []);
  // The next window starts quietly.
  assert.deepEqual(kinds(t.update(snap(provider("codex", 0, resetsAt + 300 * MIN)), at(-2))), []);
});

test("windows seen for the first time do not announce milestones already behind them", () => {
  const t = new IslandTracker(), resetsAt = now + 20 * MIN;
  assert.deepEqual(kinds(t.update(snap(provider("claude", 40, resetsAt)), now)), []);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 40, resetsAt)), now + 11 * MIN)), ["reset-soon claude"], "10 minutes left");
});

test("an unused window has nothing to reset", () => {
  const t = new IslandTracker(), resetsAt = now + 90 * MIN;
  t.update(snap(provider("claude", 0, resetsAt)), now);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 0, resetsAt)), resetsAt - 30 * MIN)), []);
  assert.deepEqual(kinds(t.update(snap(provider("claude", 0, resetsAt)), resetsAt + 1)), []);
});

test("the queue keeps the newest event per bar and shows resets before usage", () => {
  const base = { provider: "claude", label: "5-hour", at: now, expiresAt: now + 10 * MIN };
  const usage = (to: number): IslandEvent => ({ ...base, key: "claude:5-hour", kind: "usage", from: 40, to });
  const soon: IslandEvent = { ...base, key: "codex:5-hour", provider: "codex", kind: "reset-soon", resetsAt: now + 5 * MIN, usedPercent: 80, expiresAt: now + 5 * MIN };
  let queue = enqueue([], [usage(55)]);
  queue = enqueue(queue, [usage(70), soon]);
  assert.equal(queue.length, 2);
  const first = dequeue(queue, now);
  assert.equal(first.event?.kind, "reset-soon");
  const second = dequeue(first.rest, now);
  assert.equal(second.event?.kind === "usage" && second.event.to, 70);
  assert.equal(dequeue(enqueue([], [soon]), now + 6 * MIN).event, null, "expired");
});

const fg = (app: string, title = "", descendants: string[] = []): ForegroundWindow => ({ app, title, descendants, fullscreen: false });

test("AI apps, terminals running the CLIs and AI browser tabs are recognised", () => {
  assert.ok(isAiWindow(fg("Claude.exe")));
  assert.ok(isAiWindow(fg("C:\\Users\\me\\AppData\\Local\\Programs\\T3 Code\\T3 Code.exe")));
  assert.ok(isAiWindow(fg("Codex.exe")));
  assert.ok(isAiWindow(fg("WindowsTerminal.exe", "PowerShell", ["OpenConsole.exe", "pwsh.exe", "claude.exe"])));
  assert.ok(isAiWindow(fg("Gnome-terminal", "fabian@vulcan: ~", ["bash", "node /home/u/.npm/lib/node_modules/@openai/codex/bin/codex.js"])));
  assert.ok(isAiWindow(fg("kitty", "✳ Refactor sync loop", ["zsh"])), "Claude Code's terminal title");
  assert.ok(!isAiWindow(fg("WindowsTerminal.exe", "PowerShell", ["OpenConsole.exe", "pwsh.exe", "git.exe"])));
  assert.ok(isAiWindow(fg("chrome.exe", "Refactoring help - Claude - Google Chrome")));
  assert.ok(isAiWindow(fg("msedge.exe", "Codex - Personal - Microsoft\u200b Edge")));
  assert.ok(isAiWindow(fg("firefox", "ChatGPT — Mozilla Firefox")));
  assert.ok(!isAiWindow(fg("chrome.exe", "Claude Monet - Wikipedia - Google Chrome")));
  assert.ok(!isAiWindow(fg("explorer.exe", "Claude")));
  assert.ok(!isAiWindow(fg("Spotify.exe", "Codex")));
});

test("xprop output is parsed into class, title, pid and full-screen state", () => {
  assert.equal(parseActiveWindow("_NET_ACTIVE_WINDOW: window id # 0x3a00007"), "0x3a00007");
  assert.equal(parseActiveWindow("_NET_ACTIVE_WINDOW: window id # 0x0"), null);
  const props = parseWindowProps(['WM_CLASS = "Navigator", "firefox"', '_NET_WM_NAME = "Claude \\"beta\\" — Mozilla Firefox"', "_NET_WM_PID = 4242", "_NET_WM_STATE = _NET_WM_STATE_MAXIMIZED_VERT, _NET_WM_STATE_FULLSCREEN"].join("\n"));
  assert.deepEqual(props, { app: "firefox", title: 'Claude "beta" — Mozilla Firefox', pid: 4242, fullscreen: true });
});

test("descendants are read from /proc", () => {
  const proc = mkdtempSync(join(tmpdir(), "meterkat-proc-"));
  const add = (pid: number, ppid: number, cmd: string[]) => {
    mkdirSync(join(proc, String(pid)));
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (some (odd) name) S ${ppid} 1 1 0`);
    writeFileSync(join(proc, String(pid), "cmdline"), cmd.join("\0") + "\0");
  };
  add(10, 1, ["gnome-terminal-server"]); add(11, 10, ["bash"]); add(12, 11, ["claude", "--resume"]); add(20, 1, ["other"]);
  assert.deepEqual(linuxDescendants(10, proc), ["bash", "claude --resume"]);
});

test("the island runs on Windows and X11, not on Wayland", () => {
  assert.equal(unsupportedReason("win32", {}), null);
  assert.equal(unsupportedReason("linux", { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }), null);
  assert.match(unsupportedReason("linux", { DISPLAY: ":0", XDG_SESSION_TYPE: "wayland" }) ?? "", /Wayland/);
  assert.match(unsupportedReason("darwin", {}) ?? "", /Not available/);
  assert.ok(luminance(255, 255, 255) > 0.99 && luminance(0, 0, 0) === 0);
});

test("the drop turns ink on light backgrounds and white on dark ones, with a dead band in between", () => {
  assert.equal(nextTone("white", [0.9, 0.95, null]), "ink");
  assert.equal(nextTone("ink", [0.01, 0.02]), "white");
  assert.equal(nextTone("ink", [0.3]), "ink");
  assert.equal(nextTone("white", [0.3]), "white");
  assert.equal(nextTone("white", [null, null]), "white");
});

test("brightness is sampled beside the widest shape, never under it", () => {
  const points = samplePoints({ bounds: { x: 1920, y: 0, width: 1920 } });
  const half = Math.max(...Object.values(ISLAND_SIZES).map(size => islandFootprint({ cx: 0, ...size }))) / 2;
  assert.equal(points.length, 8);
  assert.ok(points.every(p => Math.abs(p.x - (1920 + 960)) > half && p.y >= 0 && p.y < 20));
});

/** A worker that answers like foreground-worker.ts, in screen pixels at a scale of 2. */
function fakeWorker(answer: (request: ProbeRequest) => unknown) {
  const listeners: Record<string, ((value: any) => void)[]> = {};
  const worker: ProbeWorker & { emit(event: string, value: unknown): void; requests: ProbeRequest[] } = {
    requests: [],
    postMessage(request) { this.requests.push(request); queueMicrotask(() => listeners.message?.forEach(l => l({ id: request.id, ok: true, result: answer(request) } satisfies ProbeResponse))); },
    on(event: string, listener: (value: any) => void) { (listeners[event] ??= []).push(listener); return worker; },
    terminate() { return undefined; },
    emit(event, value) { listeners[event]?.forEach(l => l(value)); },
  };
  return worker;
}
const half = (p: { x: number; y: number }) => ({ x: p.x / 2, y: p.y / 2 }), double = (p: { x: number; y: number }) => ({ x: p.x * 2, y: p.y * 2 });
const noFallback = (): ForegroundProbe => { throw new Error("fallback used"); };

test("the threaded probe converts between DIP and the worker's screen pixels", async () => {
  const worker = fakeWorker(request => request.op === "read"
    ? { window: { app: "claude.exe", title: "Claude", descendants: [], fullscreen: false }, anchor: { x: 1920, y: 80 }, pid: 7 }
    : request.points.map(p => p.x / 10_000));
  const probe = threadedProbe(() => worker, half, double, noFallback);
  assert.deepEqual((await probe.read())?.anchor, { x: 960, y: 40 });
  assert.deepEqual(await probe.luminance([{ x: 1000, y: 3 }], 1), [0.2]);
  assert.deepEqual(worker.requests[1], { op: "luminance", points: [{ x: 2000, y: 6 }], id: 2 });
});

test("the threaded probe falls back to the main thread when the worker dies", async () => {
  const worker = fakeWorker(() => null);
  worker.postMessage = function (request) { this.requests.push(request); };
  const local: ForegroundProbe = { read: async () => null, luminance: async points => points.map(() => 0.5) };
  const probe = threadedProbe(() => worker, half, double, () => local);
  const pending = probe.read();
  worker.emit("error", new Error("koffi missing"));
  await assert.rejects(pending, /koffi missing/);
  assert.deepEqual(await probe.luminance([{ x: 1, y: 1 }], 1), [0.5]);
  assert.deepEqual(await probe.luminance([{ x: 1, y: 1 }], 1), [0.5]);
  assert.equal(worker.requests.length, 1);
});
