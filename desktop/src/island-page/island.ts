// The island page. A spring moves the outline between its states (hidden, idle drop, usage pill, notice pill, panel);
// the content follows the outline and enters with a short stagger. Announcements come from the main process; a click
// asks it to open or close the panel with every provider.
import { ago, bars, duration, percent, providerColor, providerGroups, providerName, shownPercent, type BarMode } from "../format.js";
import type { IslandApi, IslandShown, IslandUpdate, Snapshot } from "../ipc.js";
import { ISLAND_SIZES, islandPath, PANEL_MAX_HEIGHT, type HitArea, type IslandShapeKind } from "../island-shape.js";
import { PROVIDER_GLYPHS } from "../provider-glyphs.js";

declare global { interface Window { meterkatIsland: IslandApi } }

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const outline = $<SVGPathElement>("#outline"), box = $<HTMLDivElement>("#box");
const logo = $<SVGSVGElement>(".logo"), usage = $<HTMLDivElement>(".usage"), notice = $<HTMLDivElement>(".notice");
const fill = $<HTMLElement>(".fill"), was = $<HTMLElement>(".was"), pct = $<HTMLElement>(".pct");
const arc = $<SVGCircleElement>(".arc"), text = $<HTMLElement>(".text"), value = $<HTMLElement>(".value");
const panel = $<HTMLDivElement>(".panel");
const api = window.meterkatIsland;
const reduced = matchMedia("(prefers-reduced-motion: reduce)");

// ---- Spring ----------------------------------------------------------------------------------------------------

type Shape = { top: number; w: number; h: number; fillet: number; r: number };
const KEYS = ["top", "w", "h", "fillet", "r"] as const;
const current: Shape = { top: 0, w: 0, h: 0, fillet: 0, r: 0 };
const velocity: Shape = { top: 0, w: 0, h: 0, fillet: 0, r: 0 };
let target: Shape = { ...current };
let stiffness = 300, damping = 24, frame = 0, last = 0;

/** Slightly underdamped by default, so the drop overshoots a little like a liquid; critically damped for reduced motion. */
function springTo(next: Shape, k = 300, d = 24) {
  target = next;
  reportHitArea();
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
  const cx = window.innerWidth / 2, h = Math.max(current.h, 0), r = Math.min(Math.max(current.r, 0), h / 2), w = Math.max(current.w, 2 * r);
  outline.setAttribute("d", islandPath({ cx, top: current.top, w, h, fillet: Math.max(current.fillet, 0), radius: r }));
  box.style.left = `${cx - w / 2}px`; box.style.top = `${current.top}px`;
  box.style.width = `${w}px`; box.style.height = `${h}px`;
}

/** A small push to the drop's height: a liquid "bump" when the bar lands on its new value. */
function bump(amount: number) {
  if (reduced.matches) return;
  velocity.h += amount;
  if (!frame) { last = 0; frame = requestAnimationFrame(step); }
}

function shape(kind: IslandShapeKind, width?: number, height?: number): Shape {
  const size = ISLAND_SIZES[kind], h = height ?? size.h;
  return { top: size.top, w: width ?? size.w, h, fillet: size.fillet, r: size.radius ?? h / 2 };
}

/** Tells the main process where the shape is heading, so the pointer is taken there (a little generously). */
let reported = "";
function reportHitArea() {
  const h = target.h, w = Math.max(target.w, Math.min(target.r, h / 2) * 2), pad = 4;
  const area: HitArea | null = h < 1 ? null : { x: window.innerWidth / 2 - w / 2 - pad, y: 0, width: w + 2 * pad, height: target.top + h + pad };
  const key = JSON.stringify(area);
  if (key !== reported) { reported = key; api.hitArea(area); }
}

// ---- Content ---------------------------------------------------------------------------------------------------

let shownId = 0, visible = false, hover = false, expanded = false, timers: number[] = [];
let mode: BarMode = "used", snapshot: Snapshot | null = null;
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
  logo.classList.remove("on"); usage.classList.remove("on"); notice.classList.remove("on", "done", "urgent"); panel.classList.remove("on");
  if (event.kind === "usage") {
    // With "remaining" the bar drains: it starts at what was left and counts down.
    const from = shownPercent(event.from, mode), to = shownPercent(event.to, mode);
    was.style.left = `${from}%`; fill.style.width = `${from}%`; pct.textContent = `${Math.round(from)}%`;
    springTo(shape("usage"), 280, 22);
    later(90, () => usage.classList.add("on"));
    countUp(from, to, reduced.matches ? 150 : 520, reduced.matches ? 400 : 1100);
  } else {
    const remaining = event.kind === "reset-soon" ? event.resetsAt - now : 0;
    text.textContent = event.kind === "reset-soon" ? `${event.label} resets in ${minutes(remaining)}` : `${event.label} reset`;
    value.textContent = percent(shownPercent(event.kind === "reset-soon" ? event.usedPercent : 0, mode));
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

/** The resting drop; a little larger while the pointer is on it, as a hint that it can be clicked. */
const rest = () => shape(hover ? "hover" : "idle");

function collapse() {
  clearTimers();
  usage.classList.remove("on"); notice.classList.remove("on"); panel.classList.remove("on");
  if (!visible) return retract();
  later(160, () => { springTo(rest(), 260, 20); logo.classList.add("on"); });
}

function retract() {
  clearTimers();
  logo.classList.remove("on"); usage.classList.remove("on"); notice.classList.remove("on"); panel.classList.remove("on");
  later(120, () => springTo(shape("hidden"), 240, 2 * Math.sqrt(240)));
}

function appear() {
  // Grows out of the screen edge with a little overshoot, then the mark fades in.
  springTo(rest(), 220, 15);
  logo.classList.add("on");
}

/** Every two to four minutes the resting mark blinks, now and then twice; never while it is hidden or for reduced motion. */
function scheduleBlink() {
  window.setTimeout(() => {
    if (logo.classList.contains("on") && !document.hidden && !reduced.matches) {
      logo.classList.remove("blink", "twice"); void logo.getBoundingClientRect();
      logo.classList.add("blink"); logo.classList.toggle("twice", Math.random() < 0.25);
    }
    scheduleBlink();
  }, 120_000 + Math.random() * 120_000);
}
logo.addEventListener("animationend", () => logo.classList.remove("blink", "twice"));

// ---- Panel -----------------------------------------------------------------------------------------------------

const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const MARK = [...document.querySelectorAll<SVGPathElement>(".logo path")].map(path => path.getAttribute("d")).join(" ");

function panelHtml(now: number) {
  const meaning = mode === "remaining" ? "Remaining" : "Used";
  const head = `<div class="panel-head"><svg class="mark" viewBox="44 30 168 196" aria-hidden="true"><path fill-rule="evenodd" d="${MARK}"/></svg><span class="title">Meterkat</span><span class="meta">${meaning}${snapshot ? ` · ${esc(ago(snapshot.generatedAt, now))}` : ""}</span></div>`;
  if (!snapshot) return `${head}<div class="note muted">Waiting for the first sync…</div>`;
  const { shown, notSetUp } = providerGroups(snapshot);
  const providers = shown.map(p => {
    const rows = bars(p).map(b => {
      const value = shownPercent(b.usedPercent, mode);
      const reset = b.resetsAt <= now ? "reset due" : `in ${duration(b.resetsAt - now)}`;
      return `<div class="meter-row"><span class="label">${esc(b.label)}</span><span class="reset">${esc(reset)}</span><span class="num">${percent(value)}</span><div class="meter" role="meter" aria-label="${esc(b.label)} ${mode}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value)}"><i data-width="${value}"></i></div></div>`;
    }).join("");
    const state = p.state === "auth_required" ? "Sign-in needed" : !rows ? "No data" : p.state === "ok" ? "" : "Stale";
    const glyph = PROVIDER_GLYPHS[p.id];
    const mark = glyph ? `<svg class="pglyph" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${glyph}"/></svg>` : "";
    return `<section class="prov" data-color="${esc(providerColor(p.id))}"><div class="prov-head">${mark}<span>${esc(providerName(p.id))}</span>${state ? `<span class="state">${state}</span>` : ""}</div>${rows}</section>`;
  }).join("");
  const missing = notSetUp.length ? `<div class="note muted">Not set up: ${notSetUp.map(id => esc(providerName(id))).join(", ")}</div>` : "";
  return head + (providers || missing ? providers + missing : `<div class="note muted">No quota data yet.</div>`);
}

/** Renders the panel and springs the outline to its height; called on open and whenever the data changes. */
function renderPanel(now: number) {
  panel.innerHTML = panelHtml(now);
  // The CSP blocks style attributes; widths and colours are set through the CSSOM instead.
  for (const el of panel.querySelectorAll<HTMLElement>("[data-width]")) el.style.width = `${el.dataset.width}%`;
  for (const el of panel.querySelectorAll<HTMLElement>("[data-color]")) el.style.setProperty("--provider", el.dataset.color!);
  const height = Math.min(Math.ceil(panel.getBoundingClientRect().height), PANEL_MAX_HEIGHT);
  return shape("panel", undefined, height);
}

function open(now: number) {
  clearTimers();
  logo.classList.remove("on"); usage.classList.remove("on"); notice.classList.remove("on", "done", "urgent");
  springTo(renderPanel(now), 260, 24);
  later(60, () => panel.classList.add("on"));
}

// ---- Updates ---------------------------------------------------------------------------------------------------

function update(next: IslandUpdate) {
  document.body.classList.toggle("white", next.tone === "white");
  document.body.classList.toggle("ink", next.tone === "ink");
  document.body.classList.toggle("hover", next.hover);
  const wasVisible = visible, wasExpanded = expanded, wasHover = hover;
  visible = next.visible; hover = next.hover; expanded = next.visible && next.expanded; mode = next.mode;
  if (expanded) snapshot = next.snapshot;
  if (!visible) { shownId = 0; if (wasVisible || current.h > 0) retract(); return; }
  if (expanded) {
    shownId = 0;
    if (!wasExpanded) open(next.now); else springTo(renderPanel(next.now), 260, 24);
    return;
  }
  if (wasExpanded) { collapse(); return; }
  if (next.event && next.event.id !== shownId) { shownId = next.event.id; show(next.event, next.now); return; }
  if (!next.event && shownId) { shownId = 0; collapse(); return; }
  if (!wasVisible && !shownId) { appear(); return; }
  // Only the resting drop reacts to the pointer; a pill keeps its size.
  if (hover !== wasHover && !shownId) springTo(rest(), 420, 22);
}

// "in 2 h 10 min" and "5 min ago" in the open panel stay current.
setInterval(() => { if (expanded) springTo(renderPanel(Date.now()), 260, 24); }, 30_000);

// The window only takes the pointer while it is on the island, so every release here is meant for it. Not "click":
// the window cannot take focus, and while another app is in front Windows drops the press and delivers only the release.
document.addEventListener("pointerup", event => { if (event.button === 0) api.toggle(); });

draw();
scheduleBlink();
api.onUpdate(update);
