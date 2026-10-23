// The island page. A spring moves the outline between its states (hidden, idle drop, usage pill, notice pill); the
// content follows the outline and enters with a short stagger. Announcements come from the main process.
import { duration, providerColor } from "../format.js";
import type { IslandApi, IslandShown, IslandUpdate } from "../ipc.js";
import { ISLAND_SIZES, islandPath, type IslandShapeKind } from "../island-shape.js";
import { PROVIDER_GLYPHS } from "../provider-glyphs.js";

declare global { interface Window { meterkatIsland: IslandApi } }

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const outline = $<SVGPathElement>("#outline"), box = $<HTMLDivElement>("#box");
const logo = $<SVGSVGElement>(".logo"), usage = $<HTMLDivElement>(".usage"), notice = $<HTMLDivElement>(".notice");
const fill = $<HTMLElement>(".fill"), was = $<HTMLElement>(".was"), pct = $<HTMLElement>(".pct");
const arc = $<SVGCircleElement>(".arc"), text = $<HTMLElement>(".text"), value = $<HTMLElement>(".value");
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// ---- Spring ----------------------------------------------------------------------------------------------------

type Shape = { top: number; w: number; h: number; fillet: number };
const KEYS = ["top", "w", "h", "fillet"] as const;
const current: Shape = { top: 0, w: 0, h: 0, fillet: 0 };
const velocity: Shape = { top: 0, w: 0, h: 0, fillet: 0 };
let target: Shape = { ...current };
let stiffness = 300, damping = 24, frame = 0, last = 0;

/** Slightly underdamped by default, so the drop overshoots a little like a liquid; critically damped for reduced motion. */
function springTo(next: Shape, k = 300, d = 24) {
  target = next;
  stiffness = k; damping = reduced.matches ? 2 * Math.sqrt(k) : d;
  if (!frame) { last = 0; frame = requestAnimationFrame(step); }
}

function step(time: number) {
  const dt = Math.min((time - (last || time)) / 1000, 1 / 30) || 1 / 60;
  last = time;
  let moving = false;
  for (const key of KEYS) {
    const v = velocity[key] + (-stiffness * (current[key] - target[key]) - damping * velocity[key]) * dt;
    velocity[key] = v; current[key] += v * dt;
    if (Math.abs(v) > 0.01 || Math.abs(current[key] - target[key]) > 0.01) moving = true;
  }
  if (!moving) { Object.assign(current, target); KEYS.forEach(key => { velocity[key] = 0; }); }
  draw();
  frame = moving ? requestAnimationFrame(step) : 0;
}

function draw() {
  const cx = window.innerWidth / 2, h = Math.max(current.h, 0), w = Math.max(current.w, h);
  outline.setAttribute("d", islandPath({ cx, top: current.top, w, h, fillet: Math.max(current.fillet, 0) }));
  box.style.left = `${cx - w / 2}px`; box.style.top = `${current.top}px`;
  box.style.width = `${w}px`; box.style.height = `${h}px`;
}

/** A small push to the drop's height: a liquid "bump" when the bar lands on its new value. */
function bump(amount: number) {
  if (reduced.matches) return;
  velocity.h += amount;
  if (!frame) { last = 0; frame = requestAnimationFrame(step); }
}

function shape(kind: IslandShapeKind, width?: number): Shape {
  const size = ISLAND_SIZES[kind];
  return { top: size.top, w: width ?? size.w, h: size.h, fillet: size.fillet };
}

// ---- Content ---------------------------------------------------------------------------------------------------

let shownId = 0, visible = false, timers: number[] = [];
const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)); };
const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

function setProvider(id: string) {
  document.body.style.setProperty("--provider", providerColor(id));
  const glyph = PROVIDER_GLYPHS[id] ?? "M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16Z";
  document.querySelectorAll<SVGPathElement>(".glyph path").forEach(path => path.setAttribute("d", glyph));
}

function countUp(from: number, to: number, delay: number, ms: number) {
  const start = performance.now() + delay;
  const ease = (x: number) => 1 - (1 - x) ** 3;
  const tick = (now: number) => {
    const x = Math.min(Math.max((now - start) / ms, 0), 1), v = from + (to - from) * ease(x);
    fill.style.width = `${v}%`; pct.textContent = `${Math.round(v)}%`;
    if (x < 1) requestAnimationFrame(tick);
    else { fill.classList.remove("landed"); void fill.getBoundingClientRect(); fill.classList.add("landed"); bump(90); }
  };
  requestAnimationFrame(tick);
}

const minutes = (ms: number) => duration(Math.ceil(Math.max(ms, 0) / 60_000) * 60_000);

function noticeWidth() {
  // Measure the natural width of the notice while it is still transparent.
  return Math.min(Math.max(Math.ceil(notice.getBoundingClientRect().width), 150), 360);
}

function show(event: IslandShown, now: number) {
  clearTimers();
  setProvider(event.provider);
  logo.classList.remove("on"); usage.classList.remove("on"); notice.classList.remove("on", "done", "urgent");
  if (event.kind === "usage") {
    was.style.left = `${event.from}%`; fill.style.width = `${event.from}%`; pct.textContent = `${Math.round(event.from)}%`;
    springTo(shape("usage"), 280, 22);
    later(90, () => usage.classList.add("on"));
    countUp(event.from, event.to, reduced.matches ? 150 : 520, reduced.matches ? 400 : 1100);
  } else {
    const remaining = event.kind === "reset-soon" ? event.resetsAt - now : 0;
    text.textContent = event.kind === "reset-soon" ? `${event.label} resets in ${minutes(remaining)}` : `${event.label} reset`;
    value.textContent = event.kind === "reset-soon" ? `${Math.round(event.usedPercent)}%` : "0%";
    notice.classList.toggle("done", event.kind === "reset-done");
    notice.classList.toggle("urgent", event.kind === "reset-soon" && remaining <= 5 * 60_000);
    // The ring shows the time left of the last hour; it closes completely once the window has reset.
    const left = event.kind === "reset-soon" ? Math.min(Math.max(remaining / 3_600_000, 0.04), 1) : 1;
    arc.style.transition = "none"; arc.style.strokeDashoffset = `${87.96}`; void arc.getBoundingClientRect(); arc.style.transition = "";
    later(30, () => { arc.style.strokeDashoffset = `${87.96 * (1 - left)}`; });
    springTo(shape("notice", noticeWidth()), 300, 23);
    later(90, () => notice.classList.add("on"));
  }
  later(event.holdMs, () => { if (shownId === event.id) collapse(); });
}

function collapse() {
  clearTimers();
  usage.classList.remove("on"); notice.classList.remove("on");
  if (!visible) return retract();
  later(160, () => { springTo(shape("idle"), 260, 20); logo.classList.add("on"); });
}

function retract() {
  clearTimers();
  logo.classList.remove("on"); usage.classList.remove("on"); notice.classList.remove("on");
  later(120, () => springTo(shape("hidden"), 240, 2 * Math.sqrt(240)));
}

function appear() {
  // Grows out of the screen edge with a little overshoot, then the mark fades in.
  springTo(shape("idle"), 220, 15);
  logo.classList.add("on");
}

function update(next: IslandUpdate) {
  document.body.classList.toggle("white", next.tone === "white");
  document.body.classList.toggle("ink", next.tone === "ink");
  const wasVisible = visible;
  visible = next.visible;
  if (!visible) { shownId = 0; if (wasVisible || current.h > 0) retract(); return; }
  if (next.event && next.event.id !== shownId) { shownId = next.event.id; show(next.event, next.now); return; }
  if (!next.event && shownId) { shownId = 0; collapse(); return; }
  if (!wasVisible && !shownId) appear();
}

draw();
window.meterkatIsland.onUpdate(update);
