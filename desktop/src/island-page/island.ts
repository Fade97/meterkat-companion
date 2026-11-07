// The island page. A spring moves the outline between its states (hidden, idle drop, usage pill, notice pill, panel);
// the content follows the outline and enters with a short stagger. Announcements come from the main process; a click
// asks it to open or close the panel with every provider.
import { alsoAtRisk, lowBelowCue, bars, duration, headline, resetText, paceWarns, noPaceHint, fresh, level, paceUnknown, STALE_MS, tightest, chipLabel, headerAge, lowWhenLastSeen, tickHint, pace, paceGlyph, paceText, panelStatus, percent, providerColor, providerGroups, providerName, resetLine, shownPercent, tickPercent, unitWord, type BarMode } from "../format.js";
import type { IslandApi, IslandShown, IslandUpdate, Snapshot } from "../ipc.js";
import type { Tightest } from "../format.js";
import { ISLAND_SIZES, islandPath, PANEL_MAX_HEIGHT, type HitArea, type IslandShapeKind } from "../island-shape.js";
import { PROVIDER_GLYPHS } from "../provider-glyphs.js";
import { LOCKUP } from "../brand-lockup.js";
import { hideDots } from "../hide-dots.js";

declare global { interface Window { meterkatIsland: IslandApi } }

const $ = <T extends Element>(selector: string) => document.querySelector<T>(selector)!;
const outline = $<SVGPathElement>("#outline"), box = $<HTMLDivElement>("#box");
const logo = $<SVGSVGElement>(".logo"), usage = $<HTMLDivElement>(".usage"), notice = $<HTMLDivElement>(".notice");
const fill = $<HTMLElement>(".fill"), gain = $<HTMLElement>(".gain"), tick = $<HTMLElement>(".bar .tick"), win = $<HTMLElement>(".win");
const line2 = $<HTMLElement>(".usage .line2");
const pct = $<HTMLElement>(".pct .num"), pctUnit = $<HTMLElement>(".pct .unit"), alert = $<HTMLElement>(".pct .alert"), say = $<HTMLElement>(".pct .say");
const arc = $<SVGCircleElement>(".arc"), text = $<HTMLElement>(".notice .text");
const value = $<HTMLElement>(".value .num"), valueUnit = $<HTMLElement>(".value .unit");
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

/** Slightly underdamped, so the drop overshoots a little like a liquid. With reduced motion it jumps to the shape. */
function springTo(next: Shape, k = 300, d = 24) {
  target = next;
  reportHitArea();
  if (reduced.matches) {
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    Object.assign(current, target); KEYS.forEach(key => { velocity[key] = 0; });
    return draw();
  }
  stiffness = k; damping = d;
  if (!frame) { last = 0; frame = requestAnimationFrame(step); }
}
/** Delays that only stage motion (the stagger, the ring); none with reduced motion. */
const staged = (ms: number) => reduced.matches ? 0 : ms;

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

function countUp(from: number, to: number, delay: number, ms: number, landed: () => void) {
  // Reduced motion: the final value at once.
  if (reduced.matches) { fill.style.width = `${to}%`; pct.textContent = `${Math.round(to)}%`; gain.classList.add("fade"); return landed(); }
  const start = performance.now() + delay;
  const ease = (x: number) => 1 - (1 - x) ** 3;
  const tick = (now: number) => {
    const x = Math.min(Math.max((now - start) / ms, 0), 1), v = from + (to - from) * ease(x);
    fill.style.width = `${v}%`; pct.textContent = `${Math.round(v)}%`;
    if (x < 1) requestAnimationFrame(tick);
    else { fill.classList.remove("landed"); void fill.getBoundingClientRect(); fill.classList.add("landed"); gain.classList.add("fade"); bump(90); landed(); }
  };
  requestAnimationFrame(tick);
}

function noticeWidth() {
  // Measure the natural width of the notice while it is still transparent.
  return Math.min(Math.max(Math.ceil(notice.getBoundingClientRect().width), 150), 460);
}

function show(event: IslandShown, now: number) {
  clearTimers();
  setProvider(event.provider);
  showLogo(false); usage.classList.remove("on"); notice.classList.remove("on", "done", "urgent"); panel.classList.remove("on");
  if (event.kind === "usage") {
    // With "remaining" the bar drains: it starts at what was left and counts down.
    const from = shownPercent(event.from, mode), to = shownPercent(event.to, mode);
    fill.style.width = `${from}%`; pct.textContent = `${Math.round(from)}%`;
    // Provider and window by name: "Claude · 5-hour".
    win.textContent = `${providerName(event.provider)} · ${event.label}`; hideDots(win); pctUnit.textContent = unitWord(mode);
    // The same elapsed tick and verdict as every other bar; the jump itself shows as a lighter segment that fades.
    const bar = { label: event.label, usedPercent: event.to, resetsAt: event.resetsAt, windowMs: event.windowMs };
    // A queued event can wait a while; once its numbers are stale there is no verdict and no warning colour.
    const current = now - event.at <= STALE_MS;
    const at = tickPercent(bar, mode, now), verdict = current ? pace(bar, now) : null;
    tick.hidden = at === null; tick.style.left = `${at ?? 0}%`;
    usage.classList.remove("warn", "bad"); usage.classList.add(...[current ? level(bar, verdict) : ""].filter(Boolean));
    alert.hidden = !paceGlyph(verdict);
    say.classList.remove("in"); say.textContent = ""; usage.classList.remove("two"); line2.textContent = "";
    gain.style.transition = "none"; gain.classList.remove("fade");
    gain.style.left = `${Math.min(from, to)}%`; gain.style.width = `${Math.abs(to - from)}%`;
    void gain.getBoundingClientRect(); gain.style.transition = "";
    springTo(shape("usage"), 280, 22);
    later(staged(90), () => usage.classList.add("on"));
    // Once the bar has landed, the pill says more. Calm: one line, "45% used · resets in 2h 10m". A warning grows a
    // second line with the verdict and the reset: "Runs out in 2h 4m · resets in 2h 10m".
    const warning = verdict && paceWarns(verdict) ? paceText(verdict) : null, id = event.id;
    const reset = bar.resetsAt > now ? `resets in ${duration(bar.resetsAt - now)}` : "";
    usage.title = [`${providerName(event.provider)} ${event.label}: ${percent(to)} ${unitWord(mode)}`, warning, reset].filter(Boolean).join(" · ");
    say.classList.add("calm");
    countUp(from, to, 520, 1100, () => {
      if (shownId !== id) return;
      if (warning) {
        line2.innerHTML = `<span class="verdict">${esc(warning)}</span>${reset ? ` · ${esc(reset)}` : ""}`; hideDots(line2);
        usage.classList.add("two");
        springTo(shape("warning"), 300, 22);
      } else if (reset) {
        say.textContent = reset;
        springTo(shape("verdict"), 300, 22);
        say.classList.add("in");
      }
    });
  } else {
    const remaining = event.kind === "reset-soon" ? event.resetsAt - now : 0;
    // "Claude · 5-hour resets in 10m · 74% used"
    const name = `${providerName(event.provider)} · ${event.label}`;
    text.textContent = event.kind === "reset-soon" ? `${name} resets in ${duration(remaining)}` : `${name} has reset`; hideDots(text);
    value.textContent = percent(shownPercent(event.kind === "reset-soon" ? event.usedPercent : 0, mode)); valueUnit.textContent = unitWord(mode);
    notice.classList.toggle("done", event.kind === "reset-done");
    notice.classList.toggle("urgent", event.kind === "reset-soon" && remaining <= 5 * 60_000);
    // The ring shows the time left of the last hour; it closes completely once the window has reset.
    const left = event.kind === "reset-soon" ? Math.min(Math.max(remaining / 3_600_000, 0.04), 1) : 1;
    arc.style.transition = "none"; arc.style.strokeDashoffset = `${87.96}`; void arc.getBoundingClientRect(); arc.style.transition = "";
    later(staged(30), () => { arc.style.strokeDashoffset = `${87.96 * (1 - left)}`; });
    springTo(shape("notice", noticeWidth()), 300, 23);
    later(staged(90), () => notice.classList.add("on"));
  }
  later(event.holdMs, () => { if (shownId === event.id) collapse(); });
}

/** The resting drop; a little larger while the pointer is on it, as a hint that it can be clicked. */
const rest = () => shape(hover ? "hover" : "idle");

function collapse() {
  clearTimers();
  usage.classList.remove("on"); notice.classList.remove("on"); panel.classList.remove("on");
  if (!visible) return retract();
  later(staged(160), () => { springTo(rest(), 260, 20); showLogo(true); });
}

function retract() {
  clearTimers();
  showLogo(false); usage.classList.remove("on"); notice.classList.remove("on"); panel.classList.remove("on");
  later(staged(120), () => springTo(shape("hidden"), 240, 2 * Math.sqrt(240)));
}

function appear() {
  // Grows out of the screen edge with a little overshoot, then the mark fades in.
  springTo(rest(), 220, 15);
  showLogo(true);
}

/** The resting mark; only while it shows is it the island's accessible image (the open panel has the lockup). */
function showLogo(on: boolean) {
  logo.classList.toggle("on", on);
  if (on) logo.removeAttribute("aria-hidden"); else logo.setAttribute("aria-hidden", "true");
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

/**
 * The headline in two lines above the provider rows, the window's pattern: "▲ Runs out first · Claude Weekly" with the
 * number and its unit on the right, then "Runs out around Sat 4:56 AM · resets Sun 11:37 AM". The rows below carry the
 * detail: the headline's own row and every other at-risk row are highlighted there.
 */
function summaryHtml(now: number) {
  const tight = tightest(snapshot, now);
  if (!tight) return "";
  const h = headline(tight, mode, now, {}, headerAge(providerGroups(snapshot).shown, snapshot?.generatedAt ?? 0, now));
  const sep = `<span class="sep" aria-hidden="true"> · </span>`;
  const state = tight.lastKnown !== null ? "" : tight.pace?.state ?? "";
  const detail = `${h.lead ? `<span class="lead pace ${state}">${esc(h.lead)}</span>${sep}` : ""}<span class="rest">${esc(h.lead ? h.rest : h.rest.charAt(0).toUpperCase() + h.rest.slice(1))}</span>`;
  const name = `${h.name}${h.lead ? `, ${h.lead}` : ""}, ${h.rest}`;
  return `<div class="summary ${tight.lastKnown !== null ? "old" : level(tight.bar, tight.pace)}" data-color="${esc(providerColor(tight.provider.id))}" role="group" aria-label="${esc(name)}"><div class="line1" aria-hidden="true"><span class="reason${h.tone ? ` ${h.tone}` : ""}">${h.glyph ? "▲ " : ""}${esc(h.label)}</span>${sep}<span class="title"><span class="t">${esc(h.title)}</span></span><span class="num"><b>${esc(percent(shownPercent(tight.bar.usedPercent, mode)))}</b> ${esc(unitWord(mode))}</span></div><div class="line2" aria-hidden="true">${detail}</div></div>`;
}

function panelHtml(now: number) {
  // The same note as the window's header: "Updated just now" only while every shown provider is current, else the problem in amber.
  const status = snapshot ? panelStatus(snapshot, now) : null;
  const head = `<div class="panel-head"><div class="panel-top">${LOCKUP}${status ? `<span class="meta${status.warn ? " warn" : ""}">${esc(status.text)}</span>` : ""}</div>${summaryHtml(now)}</div>`;
  if (!snapshot) return `${head}<div class="note muted">Waiting for the first sync…</div>`;
  const { shown, notSetUp } = providerGroups(snapshot);
  // The headline's own row and every other at-risk row stand out in the list.
  const lead = tightest(snapshot, now), alsoRows = lead ? alsoAtRisk(snapshot, lead, now) : [];
  const providers = shown.map(p => {
    const rows = bars(p).map(b => {
      // Reset passed, next sample still due: no number.
      if (b.resetsAt <= now) return `<div class="meter-row old"><span class="label">${esc(b.label)}</span><span class="num">Updating</span><div class="meter" role="meter" aria-label="${esc(`${providerName(p.id)} ${b.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Updating after the reset"></div><span class="reset">Reset, waiting for the next sample</span></div>`;
      const value = shownPercent(b.usedPercent, mode), word = unitWord(mode);
      const verdict = fresh(p, now) ? pace(b, now) : null, tick = tickPercent(b, mode, now), reset = resetLine(b.resetsAt, now);
      // Every row says when it resets and, where there is one, its verdict: a muted "On pace" or the warning.
      const seen = lowWhenLastSeen(p, b, now);
      const paceWord = seen ? `<span class="pace seen">${esc(seen)}</span>` : verdict ? `<span class="pace ${verdict.state}"${verdict.state === "tight" ? ` title="${esc(paceText(verdict, true))}"` : ""}>${paceGlyph(verdict) ? `<span aria-hidden="true">▲ </span>` : ""}${esc(paceText(verdict))}</span>` : "";
      // Last-known (stale) data is the headline too, but its row carries no highlight: nothing is at risk, the "Last known" headline says what it is.
      const isLead = !!lead && fresh(p, now) && lead.provider === p && lead.bar.label === b.label, also = alsoRows.find(o => o.provider === p && o.bar.label === b.label), isAlso = !!also;
      // Every running-low row has the same style, tint and warning edge, the lead row included when it is low (a lead that is not low keeps the tint only); its own verdict ("Running low", "Limit reached")
      // already says why, so no "Also at risk" tag is stacked on top of it.
      const spoken = [`${percent(value)} ${word}`, reset.replace(" · ", ", "), verdict ? paceText(verdict, true) : "", seen ?? ""].filter(Boolean).join(", ");
      return `<div class="meter-row ${fresh(p, now) ? level(b, verdict) : "old"}${isLead ? " lead" : ""}${isLead && verdict && paceWarns(verdict) ? ` edge ${verdict.state}` : ""}${isAlso ? ` also ${also!.pace.state}` : ""}"${isAlso ? ` data-rank="${alsoRows.indexOf(also!)}"` : ""} title="${esc(reset)}"><span class="label">${esc(b.label)}</span><span class="num"><b>${percent(value)}</b> ${word}</span><div class="meter"${tick === null ? "" : ` title="${esc(tickHint(mode))}"`} role="meter" aria-label="${esc(`${providerName(p.id)} ${b.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value)}" aria-valuetext="${esc(spoken)}"><i data-width="${value}"></i>${tick === null ? "" : `<u data-left="${tick}"></u>`}</div><span class="reset">${esc(reset)}</span>${paceWord}</div>`;
    }).join("");
    const state = chipLabel(p, shown, snapshot?.generatedAt ?? 0, now) ?? (rows ? "" : "No data");
    // Quota buckets without a known window length: "No forecast", the whole sentence as tooltip and for screen readers.
    const noPace = rows && paceUnknown(p) ? `<span class="state" title="${noPaceHint}"><span aria-hidden="true">No forecast</span><span class="vh">${noPaceHint}</span></span>` : "";
    // Stale and sign-in needed as chips, as in the window.
    const chip = state ? `<span class="chip${p.state === "auth_required" ? " warn" : ""}">${state}</span>` : "";
    const glyph = PROVIDER_GLYPHS[p.id];
    const mark = glyph ? `<svg class="pglyph" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${glyph}"/></svg>` : "";
    return `<section class="prov" data-color="${esc(providerColor(p.id))}" data-name="${esc(providerName(p.id))}"><div class="prov-head">${mark}<span>${esc(providerName(p.id))}</span>${noPace || chip ? `<span class="tags">${noPace}${chip}</span>` : ""}</div>${rows}</section>`;
  }).join("");
  const missing = notSetUp.length ? `<div class="note muted">Not set up: ${notSetUp.map(id => esc(providerName(id))).join(", ")}</div>` : "";
  // The providers scroll below the fixed head when there are more than fit; the cue says how many are below.
  return `${head}<div class="plist">${providers || missing ? providers + missing : `<div class="note muted">No quota data yet.</div>`}</div><div class="more" aria-hidden="true" hidden></div>`;
}

/** Renders the panel and springs the outline to its height; called on open and whenever the data changes. */
/** Fades the bottom of an overflowing provider list and says what is still below: at-risk rows ("▲ Antigravity low ↓", "▲ 2 at risk below ↓") or else the provider count ("3 more ↓"). */
function updateMore() {
  const list = panel.querySelector<HTMLElement>(".plist"), more = panel.querySelector<HTMLElement>(".more");
  if (!list || !more) return;
  const bottom = list.getBoundingClientRect().bottom, below = list.scrollHeight - list.clientHeight - list.scrollTop > 2;
  const offscreen = [...list.querySelectorAll<HTMLElement>(".prov")].filter(p => p.getBoundingClientRect().top > bottom - 24);
  const hidden = offscreen.length;
  // At-risk rows below the fold: the cue names them (it counts rows, not providers) and carries the warning mark.
  // The most pressing first (the footer's order), so the cue names the same entry the window would.
  const lowRows = [...list.querySelectorAll<HTMLElement>(".meter-row.also")].filter(r => r.getBoundingClientRect().top > bottom - 24)
    .sort((a, b) => Number(a.dataset.rank) - Number(b.dataset.rank))
    .map(r => ({ provider: r.closest<HTMLElement>(".prov")?.dataset.name ?? "", state: r.classList.contains("limit") ? "limit" as const : r.classList.contains("fast") ? "fast" as const : "low" as const }));
  const low = lowBelowCue(lowRows);
  more.classList.toggle("warn", low !== null);
  // An overflowing list leaves room under it for the cue, so the cue never covers a row.
  panel.classList.toggle("overflowing", list.scrollHeight > list.clientHeight + 2);
  list.classList.toggle("faded", below);
  more.hidden = !below;
  more.textContent = low ?? (hidden ? `${hidden} more ↓` : "More ↓");
}

function renderPanel(now: number) {
  // A refresh keeps the list where it was scrolled to.
  const scrolled = panel.querySelector<HTMLElement>(".plist")?.scrollTop ?? 0;
  panel.innerHTML = panelHtml(now);
  const list = panel.querySelector<HTMLElement>(".plist");
  if (list) { list.scrollTop = scrolled; list.addEventListener("scroll", updateMore, { passive: true }); }
  updateMore();
  // The CSP blocks style attributes; widths and colours are set through the CSSOM instead.
  hideDots(panel);
  for (const el of panel.querySelectorAll<HTMLElement>("[data-width]")) el.style.width = `${el.dataset.width}%`;
  for (const el of panel.querySelectorAll<HTMLElement>("[data-left]")) el.style.left = `${el.dataset.left}%`;
  for (const el of panel.querySelectorAll<HTMLElement>("[data-color]")) el.style.setProperty("--provider", el.dataset.color!);
  const height = Math.min(Math.ceil(panel.getBoundingClientRect().height), PANEL_MAX_HEIGHT);
  return shape("panel", undefined, height);
}

function open(now: number) {
  clearTimers();
  showLogo(false); usage.classList.remove("on"); notice.classList.remove("on", "done", "urgent");
  springTo(renderPanel(now), 260, 24);
  later(staged(60), () => panel.classList.add("on"));
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

// "Resets in 2h 10m", the pace and "5m ago" in the open panel stay current.
setInterval(() => { if (expanded) springTo(renderPanel(Date.now()), 260, 24); }, 30_000);

// The window only takes the pointer while it is on the island, so every release here is meant for it. Not "click":
// the window cannot take focus, and while another app is in front Windows drops the press and delivers only the release.
document.addEventListener("pointerup", event => {
  if (event.button !== 0) return;
  const target = event.target as HTMLElement, list = target.closest<HTMLElement>(".plist");
  // The cue scrolls the list on; releasing the list's scrollbar is not a click on the island.
  if (target.closest(".more")) { panel.querySelector(".plist")?.scrollBy({ top: 160, behavior: reduced.matches ? "auto" : "smooth" }); return; }
  if (list && event.clientX - list.getBoundingClientRect().left >= list.clientWidth) return;
  api.toggle();
});

draw();
scheduleBlink();
api.onUpdate(update);
