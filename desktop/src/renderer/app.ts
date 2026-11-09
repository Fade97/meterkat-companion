// The window: setup wizard until the companion is registered, then Overview, Phones and Settings.
// All data comes through window.meterkat (preload.ts); the page has no Node or network access of its own.
import { ago, alsoAtRisk, alsoLine, alsoMore, bars, resetText, fresh, headline, level, noPaceHint, paceUnknown, syncProblem, staleLabel, chipLabel, islandAnchorHelp, ISLAND_ANCHORS, staleSummary, headerStatus, headerAge, lowWhenLastSeen, tickHint, tickLegend, tickRead, pace, paceGlyph, paceText, percent, providerColor, providerGroups, providerMark, providerName, resetClock, resetLine, shownPercent, tickPercent, tightest, unitWord, forecastChart, forecastText, type Bar, type Pace, type Tightest } from "../format.js";
import type { ProviderUsage } from "../../../shared/snapshot.js";
import { LOCKUP, SYMBOL_MARK } from "../brand-lockup.js";
import { radioStep } from "../radio-keys.js";
import { hideDots } from "../hide-dots.js";
import type { AppState, BarMode, Device, IslandAnchor, MeterkatApi, Pairing, ProviderCheck, UpdateChannel, View, WindowForecast } from "../ipc.js";

declare global { interface Window { meterkat: MeterkatApi } }
const api = window.meterkat;
const $ = <T extends HTMLElement>(selector: string) => document.querySelector(selector) as T;
const esc = (value: unknown) => String(value).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

let state: AppState;
let view: View = "overview";
// Phones view
let pairing: Pairing | null = null;
let pairedCount: number | null = null;
let phones: Device[] | null = null;
let phonesError: string | null = null;
let connected = false;
let pairingError: string | null = null;
/** "Copied" on the copy button for a moment after a click. */
let linkCopied = false;
// Setup wizard
type Step = "tools" | "relay" | "autostart" | "pair";
let step: Step = "tools";
let checks: ProviderCheck[] | null = null;
let customRelay = false;
let registering = false;
let setupError: string | null = null;
let setupAutostart = true;
/** False from the first registration step until the wizard's last step is finished or skipped. */
let setupDone = true;
// Forecast view: the result and the snapshot it was made from
let forecastData: WindowForecast[] | null = null;
let forecastFor: number | null = null;
let forecastError: string | null = null;
// Settings
let updateBusy = false;
let settingsError: string | null = null;

// ---- Status line ----------------------------------------------------------------------------------------------

let statusKey = "";
function renderStatus() {
  const { sync, registration } = state;
  let kind = ""; let text = "";
  if (!registration) text = "Not set up";
  else if (sync.running) { kind = "busy"; text = "Syncing…"; }
  // The age of the data is said once, in the banner below.
  else if (sync.error) { kind = "bad"; text = "Sync failed"; }
  else if (sync.lastSuccess) {
    // Green only while everything is current: a stale provider or one that needs sign-in turns the dot amber, so it never contradicts the text.
    const shown = providerGroups(state.snapshot).shown;
    kind = staleSummary(shown) ? "warn" : "ok"; text = headerStatus(shown, sync.lastSuccess);
  }
  else text = "Waiting for first sync";
  // Rewritten only on change, so screen readers hear each new status once.
  if (statusKey !== kind + text) {
    statusKey = kind + text;
    const el = $("#status");
    el.className = `status ${kind}`;
    // Ellipsis as a safety net (German, large text): the full text is the tooltip and the accessible name.
    el.innerHTML = `<span class="dot" aria-hidden="true"></span><span class="status-text" title="${esc(text)}">${esc(text)}</span>`;
    hideDots(el);
  }
  const button = $<HTMLButtonElement>("#sync");
  button.hidden = !registration || !setupDone || sync.mode === "service";
  button.disabled = sync.running;
}

// ---- Overview -------------------------------------------------------------------------------------------------

/** The pace word under a bar: muted "On pace", ▲ and the warning colour when it runs out early, red at the limit. */
const paceWord = (p: Pace | null, long = false) => p ? `<span class="pace ${p.state}"${p.state === "tight" ? ` title="${esc(paceText(p, true))}"` : ""}>${paceGlyph(p) ? `<span aria-hidden="true">▲ </span>` : ""}${esc(paceText(p, long))}</span>` : "";

function quotaRow(provider: ProviderUsage, b: Bar, now: number) {
  // The window has reset and the next sample is still due: no number, as on Android.
  if (b.resetsAt <= now) return `<div class="quota old">
    <span class="quota-label">${esc(b.label)}</span><span class="quota-value">Updating</span>
    <div class="track" role="meter" aria-label="${esc(`${providerName(provider.id)} ${b.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuetext="Updating after the reset"></div>
    <span class="quota-reset">Reset, waiting for the next sample</span>
  </div>`;
  const value = shownPercent(b.usedPercent, state.bars), word = unitWord(state.bars);
  // No forecast from old data: stale and sign-in-needed rows show level and reset only.
  const p = fresh(provider, now) ? pace(b, now) : null, tick = tickPercent(b, state.bars, now), reset = resetLine(b.resetsAt, now);
  // A stale or sign-in row that was low when last seen says so, muted, where a current row says "On pace".
  const seen = lowWhenLastSeen(provider, b, now);
  const spoken = [`${percent(value)} ${word}`, reset.replace(" · ", ", "), p ? paceText(p, true) : "", seen ?? ""].filter(Boolean).join(", ");
  return `<div class="quota ${fresh(provider, now) ? level(b, p) : "old"}">
    <span class="quota-label">${esc(b.label)}</span><span class="quota-value"><b>${percent(value)}</b> ${word}</span>
    <div class="track"${tick === null ? "" : ` title="${esc(tickHint(state.bars))}"`} role="meter" aria-label="${esc(`${providerName(provider.id)} ${b.label}`)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(value)}" aria-valuetext="${esc(spoken)}"><div class="fill" data-width="${value}"></div>${tick === null ? "" : `<i class="tick" data-left="${tick}"></i>`}</div>
    <span class="quota-reset">${esc(reset)}</span>${seen ? `<span class="pace seen">${esc(seen)}</span>` : paceWord(p)}
  </div>`;
}

/**
 * "Also at risk: Antigravity · Claude models ▲ 88% used · resets in 50m": the most pressing of the other windows that are low,
 * at their limit or forecast to run out ("Claude · Weekly ▲ runs out in 1d 21h"); several: "+N more", named in its tooltip.
 */
function also(tight: Tightest, now: number) {
  const rows = alsoAtRisk(state.snapshot, tight, now);
  if (rows.length === 0) return "";
  const line = alsoLine(rows, state.bars, now);
  // The dot and "+N more" belong to the last entry's nowrap span: the line breaks before the ▲ rather than strand a dot. "+N more" is a
  // button (it scrolls to the card of the next entry), so it stays out of the aria-hidden text; the group names the entries shown.
  const entries = line.entries.map(e => `<span aria-hidden="true">${esc(e.name)} </span><span class="nowrap"><span aria-hidden="true"><span class="pace ${e.state}">▲ ${esc(e.alert.slice(2))}</span>${e.rest ? ` · ${esc(e.rest)}` : ""}${line.more ? " · " : ""}</span>${line.more ? `<button class="also-more" data-action="show-risk" data-target="${esc(line.next ?? "")}" title="${esc(line.hidden)}" aria-label="${esc(line.moreName)}">${alsoMore(line.more)}</button>` : ""}</span>`);
  return `<div class="summary-also" role="group" aria-label="${esc(line.more ? line.spokenShown : line.spoken)}"><span aria-hidden="true">${line.label}: </span>${entries.join(" · ")}</div>`;
}

function summary(now: number, key = "") {
  const tight = tightest(state.snapshot, now);
  if (!tight) return "";
  // Reason on its own line (▲ and colour only for current warnings), provider and window with the number, the detail.
  const shownProviders = providerGroups(state.snapshot).shown, { sync } = state;
  const h = headline(tight, state.bars, now, {}, sync.lastSuccess && !sync.error && !sync.running ? headerAge(shownProviders, sync.lastSuccess, now) : null), value = shownPercent(tight.bar.usedPercent, state.bars);
  const toneClass = h.tone ? ` ${h.tone}` : "";
  return `<section class="summary ${tight.lastKnown !== null ? "old" : level(tight.bar, tight.pace)}" data-color="${esc(providerColor(tight.provider.id))}" aria-label="${esc(h.name)}">
    <div class="summary-reason${toneClass}">${h.glyph ? `<span aria-hidden="true">▲ </span>` : ""}${esc(h.label)}</div>
    <div class="summary-title">${providerMark(tight.provider.id)}<span>${esc(h.title)}</span></div>
    <div class="summary-value"><b>${percent(value)}</b> ${unitWord(state.bars)}</div>
    <div class="summary-verdict">${h.lead ? `<span class="pace ${tight.pace?.state ?? ""}">${esc(h.lead)}</span><span class="muted"> · </span>` : ""}<span class="muted">${esc(h.lead ? h.rest : h.rest.charAt(0).toUpperCase() + h.rest.slice(1))}</span></div>
    ${also(tight, now)}${key}
  </section>`;
}

function overview() {
  const { snapshot, sync } = state, now = Date.now();
  const { shown, notSetUp } = providerGroups(snapshot);
  const cards = shown.map(p => {
    // With a failed sync the banner already says how old the data is; the chips just say "Stale". The header's own age (all stale, all the same age) is not repeated on the chips either.
    const stale = sync.error && p.state !== "auth_required" ? staleLabel(p, now)?.replace(/ · .*$/, "") ?? null : chipLabel(p, shown, sync.lastSuccess ?? 0, now);
    const chip = stale ? `<span class="chip${p.state === "auth_required" ? " warn" : ""}">${esc(stale)}</span>` : "";
    const rows = bars(p).map(b => quotaRow(p, b, now)).join("");
    // Quota buckets without a known window length: a short "No forecast" in the head, the whole sentence as its tooltip
    // and for screen readers.
    const noPace = paceUnknown(p) ? `<span class="no-pace" title="${noPaceHint}"><span aria-hidden="true">No forecast</span><span class="visually-hidden">${noPaceHint}</span></span>` : "";
    const head = noPace || chip ? `<span class="card-tags">${noPace}${chip}</span>` : "";
    const empty = p.state === "auth_required" ? `Sign in to ${esc(providerName(p.id))} on this computer to see its quota.` : `No quota data. Check that ${esc(providerName(p.id))} is installed and signed in.`;
    return `<section class="card" data-provider="${esc(p.id)}" data-color="${esc(providerColor(p.id))}"><div class="card-head"><h3 class="provider">${providerMark(p.id)}${esc(providerName(p.id))}</h3>${head}</div>${rows || `<p class="muted small">${empty}</p>`}</section>`;
  }).join("");
  const missing = notSetUp.length ? `<div class="list">${notSetUp.map(id => `<div class="list-item compact not-set-up" data-color="${esc(providerColor(id))}"><span class="provider">${providerMark(id)}${esc(providerName(id))}</span><span class="muted small">Not set up</span></div>`).join("")}</div>` : "";
  const waiting = sync.mode === "service" ? "Waiting for the background companion…" : "Reading your AI tools…";
  // A quiet key for the elapsed mark at the bottom of the headline card (as on Android), only when a bar has one.
  // "Got it" moves it to Settings › Display for good (also out of the island panel).
  const legend = cards.includes('class="tick"') && !state.keyDismissed ? `<div class="legend"><span class="legend-bar" aria-hidden="true"><i></i></span><span class="grow" title="${esc(tickHint(state.bars))}">${esc(tickLegend(state.bars))}</span><button class="btn pill key-dismiss" data-action="dismiss-key">Got it</button></div>` : "";
  const body = (cards || missing) ? summary(now, legend) + cards + missing : `<div class="empty"><span class="spinner"></span><p class="gap">${waiting}</p></div>`;
  // The problem in words; the technical detail is in the tooltip and read out after it.
  const error = sync.error && sync.mode !== "service"
    ? `<div class="banner small" role="alert" title="${esc(sync.error)}"><p class="error">${esc(syncProblem(sync.error, state.registration?.relay ?? null, snapshot?.generatedAt ?? null, now))}</p><span class="visually-hidden">Details: ${esc(sync.error)}</span></div>` : "";
  const footer = sync.mode === "service" ? `<p class="muted small gap">The CLI companion syncs in the background; this window shows its data. Settings can let the app take over.</p>` : "";
  return `<h2 class="visually-hidden">Your quota</h2>${error}${body}${footer}`;
}

// ---- Forecast -------------------------------------------------------------------------------------------------

/** The "Used" / "Left" switch, also in Settings › Display. */
const modeSwitch = () => segmented("Show quota as", (["used", "remaining"] as BarMode[]).map(m => radio(state.bars === m, `data-action="bar-mode" data-mode="${m}"`, m === "used" ? "Used" : "Left")).join(""));

/** Where each current window is heading, learned from this computer's history: one card per provider, a row with chart per window. */
function forecastView() {
  const now = Date.now(), { shown } = providerGroups(state.snapshot);
  const head = `<div class="section-head"><h2>Forecast</h2>${modeSwitch()}</div><p class="muted small fc-intro">Learned from the readings this computer has taken: when you usually use each quota and how busy you are right now. The history stays on this computer.</p>`;
  if (forecastError) return `${head}<p class="banner error small" role="alert">${esc(forecastError)}</p>`;
  if (forecastData === null) return `${head}<div class="empty"><span class="spinner"></span><p class="gap">Working out the forecast…</p></div>`;
  const cards = shown.filter(p => bars(p).some(b => b.resetsAt > now)).map(p => {
    const rows = !fresh(p, now) ? `<p class="muted small">No forecast from old readings.</p>` : forecastData!.filter(r => r.provider === p.id).map(r => {
      const label = r.windowId === "fiveHour" ? "5-hour" : r.windowId === "weekly" ? "Weekly" : p.meters?.find(m => m.id === r.windowId)?.label ?? r.windowId;
      if (!r.forecast) return `<div class="fc-row"><span class="quota-label">${esc(label)}</span><p class="muted small">No forecast yet: this computer needs a few readings of this quota first.</p></div>`;
      const t = forecastText(r.forecast, state.bars, now);
      return `<div class="fc-row ${t.tone}" role="group" aria-label="${esc(`${providerName(p.id)} ${label}: ${t.spoken}`)}">
        <div class="quota"><span class="quota-label">${esc(label)}</span><span class="quota-value"><b>${percent(t.value)}</b> ${unitWord(state.bars)}</span></div>
        <div class="fc-verdict${t.tone ? ` pace ${t.tone === "bad" ? "limit" : "fast"}` : ""}">${t.tone === "warn" ? `<span aria-hidden="true">▲ </span>` : ""}${esc(t.verdict)}</div>
        ${t.range ? `<div class="muted small fc-range">${esc(t.range)}</div>` : ""}
        ${forecastChart(r.forecast, r.actual, r.windowStart, state.bars)}
        <div class="muted small fc-basis">${esc(t.basis)}</div>
      </div>`;
    }).join("");
    return `<section class="card" data-provider="${esc(p.id)}" data-color="${esc(providerColor(p.id))}"><div class="card-head"><h3 class="provider">${providerMark(p.id)}${esc(providerName(p.id))}</h3></div>${rows}</section>`;
  }).join("");
  return head + (cards || `<p class="muted small">No current readings to forecast from.</p>`);
}

/** Asks the main process again when the snapshot changed since the last forecast. */
async function loadForecast() {
  const at = state.snapshot?.generatedAt ?? null;
  if (forecastData !== null && forecastFor === at) return;
  forecastFor = at;
  try { forecastData = await api.forecast(); forecastError = null; } catch (error) { forecastError = message(error); }
  if (view === "forecast") render();
}

// ---- Phones ---------------------------------------------------------------------------------------------------

function pairingPanel(intro: string) {
  if (connected) return `<section class="card center"><p class="success">Phone connected</p><p class="muted small">It receives your quota from the next sync.</p></section>`;
  if (!pairing) return `<section class="card"><p class="lead">${intro}</p>${pairingError ? `<p class="error small">${esc(pairingError)}</p>` : ""}<button class="btn primary block" data-action="pair">Show pairing code</button></section>`;
  const left = Math.max(0, pairing.expiresAt - Date.now());
  const time = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  return `<section class="card center">
    <img class="qr" src="${esc(pairing.qr)}" alt="Pairing QR code">
    <p>Scan with the Meterkat app on <strong>your own</strong> phone, or copy the link and paste it in the app.</p>
    <p class="muted small">The code contains your encryption key: don't share it or take a screenshot. Single use, expires in <span class="countdown" id="countdown">${time}</span>.</p>
    <div class="pair-buttons"><button class="btn" data-action="copy-pair">${linkCopied ? "Copied" : "Copy link"}</button><button class="btn" data-action="cancel-pair">Cancel</button></div>
  </section>`;
}

const PHONE_ICON = `<svg class="phone-icon" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18.5h3"/></svg>`;
/** "Phone 2" by pairing order, when it was paired (date and time) and a short ID; the newest of several is "Latest". */
function phoneItem(d: Device, number: number, latest: boolean) {
  const paired = new Date(d.pairedAt), id = d.id.slice(0, 8), name = `Phone ${number}`;
  const year = paired.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } as const : {};
  const day = paired.toLocaleDateString(undefined, { day: "numeric", month: "short", ...year });
  const time = paired.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `<div class="list-item">${PHONE_ICON}<div class="grow"><div class="item-title">${name}${latest ? ` <span class="chip small-chip">Latest</span>` : ""}</div><div class="item-sub">Paired ${esc(day)}, ${esc(time)} · ID <span class="mono">${esc(id)}</span></div></div><button class="btn small" data-action="revoke" data-id="${esc(d.id)}" aria-label="${esc(`Remove ${name}, paired ${day}`)}">Remove</button></div>`;
}

// What pairing means, in three short rows under the phones (what travels, who can read it, how to stop it).
const ICON = (d: string) => `<svg class="how-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`;
const HOW_IT_WORKS = `<div class="list how">${[
  [ICON("M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z"), "End-to-end encrypted", "The relay only passes on ciphertext it can't read."],
  [ICON("M4 19h16M7 16V11M12 16V6M17 16v-3"), "What your phones get", "Percentages, reset times and status per provider, with this computer's name."],
  [ICON("M6 6l12 12M18 6L6 18"), "Remove a phone", "It stops receiving your quota."],
].map(([icon, title, text]) => `<div class="list-item">${icon}<div class="grow"><div class="item-title">${title}</div><div class="item-sub">${text}</div></div></div>`).join("")}</div>`;

function phonesView() {
  if (state.registration?.protocol !== 2) return `<div class="notice">This companion uses the older relay protocol. Manage its phones with the CLI.</div>`;
  const list = phones === null
    ? `<div class="list"><div class="list-item muted">${phonesError ? `<span class="error">${esc(phonesError)}</span>` : `<span><span class="spinner"></span> Loading…</span>`}</div></div>`
    : phones.length === 0 ? `<div class="list"><div class="list-item muted">No phone connected yet.</div></div>`
    : `<div class="list">${[...phones].sort((a, b) => a.pairedAt - b.pairedAt).map((d, i, all) => phoneItem(d, i + 1, all.length > 1 && i === all.length - 1)).join("")}
</div>`;
  return `<h2>Connect a phone</h2>${pairingPanel("Install Meterkat on your Android phone, then show a pairing code here and scan it with the app.")}
    <div class="section-head"><h2>Paired phones</h2>${phones && phones.length > 1 ? `<button class="link danger-link" data-action="revoke-all">Remove all</button>` : ""}</div>${list}${phonesError && phones ? `<p class="error small gap">${esc(phonesError)}</p>` : ""}
    <h2>How it works</h2>${HOW_IT_WORKS}`;
}

async function loadPhones() {
  try { phones = await api.devices(); phonesError = null; } catch (error) { phonesError = message(error); phones = null; }
  if (pairing && pairedCount !== null && phones && phones.length > pairedCount) { connected = true; pairing = null; void api.stopPairing(); }
  render();
}

// ---- Settings -------------------------------------------------------------------------------------------------

function toggle(action: string, checked: boolean, label: string) {
  return `<label class="switch"><input type="checkbox" data-action="${action}" ${checked ? "checked" : ""} aria-label="${esc(label)}"><span></span></label>`;
}
/** One row of a grouped list: title, at most one short subtitle, and a control on the right. */
const item = (title: string, subtitle = "", control = "", subtitleId = "") =>
  `<div class="list-item"><div class="grow"><div class="item-title">${title}</div>${subtitle ? `<div class="item-sub"${subtitleId ? ` id="${subtitleId}"` : ""}>${subtitle}</div>` : ""}</div>${control}</div>`;
const group = (title: string, rows: string[], before = "") => rows.length || before ? `<h2>${title}</h2>${before}${rows.length ? `<div class="list">${rows.join("")}</div>` : ""}` : "";
/** A segment: only the selected one is in the tab order (roving tabindex); arrows move between them (keydown below). */
const radio = (checked: boolean, data: string, label: string) =>
  `<button class="${checked ? "on" : ""}" ${data} role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}">${label}</button>`;
const segmented = (label: string, buttons: string, describedBy = "") => `<div class="segmented" role="radiogroup" aria-label="${esc(label)}"${describedBy ? ` aria-describedby="${describedBy}"` : ""}>${buttons}</div>`;
const link = (to: string, label: string) => `<button class="list-item action" data-link="${to}"><span>${label}</span><span class="chevron" aria-hidden="true">›</span></button>`;

function settingsView() {
  const { autostart, update, registration } = state;
  const anchor = (value: IslandAnchor, label: string) => radio(state.island.anchor === value, `data-action="island-anchor" data-anchor="${value}"`, label);
  const mode = (value: BarMode, label: string) => radio(state.bars === value, `data-action="bar-mode" data-mode="${value}"`, label);
  const running = state.sync.mode === "service";
  const serviceText = autostart.service ? `The CLI companion also starts at sign-in${running ? " and is syncing now" : ""}.` : "The CLI companion is syncing in the background.";
  const service = autostart.service || running ? `<div class="notice"><p>${serviceText} Two companions would send the same data twice.</p><button class="btn small" data-action="take-over">Let the app sync instead</button></div>` : "";
  const latest = update.ready ? `${esc(update.ready)} is ready to install`
    : update.downloading ? `Downloading ${esc(update.latest)}…`
    : update.error ? `<span class="error">${esc(update.error)}</span>`
    : update.newer ? `${esc(update.latest)} is available` : update.latest ? "Up to date" : "Not checked yet";
  const updateButton = update.ready ? `<button class="btn primary small" data-action="install-update">Restart to update</button>`
    : update.downloading || updateBusy ? `<button class="btn small" disabled><span class="spinner"></span>${update.downloading ? "Downloading…" : "Checking…"}</button>`
    : update.newer && update.install === "auto" ? `<button class="btn primary small" data-action="install-update">Update now</button>`
    : update.newer ? `<button class="btn primary small" data-action="download">Download</button>`
    : `<button class="btn small" data-action="check-update">Check now</button>`;
  const channel = (value: UpdateChannel, label: string) => `<option value="${value}" ${update.channel === value ? "selected" : ""}>${label}</option>`;
  const island = state.island.unsupported ? [item("Island", esc(state.island.unsupported))] : [
    item("Show the island", "Opens when usage jumps or a quota resets", toggle("island", state.island.enabled, "Show the island")),
    ...state.island.enabled ? [item("Position", islandAnchorHelp(state.island.anchor), segmented("Island position", anchor("screen", ISLAND_ANCHORS.screen) + anchor("window", ISLAND_ANCHORS.window), "island-position-help"), "island-position-help")] : [],
  ];
  return `${settingsError ? `<p class="banner error small" role="alert">${esc(settingsError)}</p>` : ""}
    ${group("Startup", autostart.supported ? [item("Start at sign-in", "Opens hidden in the tray", toggle("autostart", autostart.app, "Start at sign-in"))] : [], service)}
    ${group("Display", [
      item("Show quota as", "Window, island and tray", segmented("Show quota as", mode("used", "Used") + mode("remaining", "Left"))),
      `<div class="list-item key-row" title="${esc(tickHint(state.bars))}"><span class="legend-bar large" aria-hidden="true"><i></i></span><div class="grow"><div class="item-title">${esc(tickLegend(state.bars))}</div><div class="item-sub">${esc(tickRead(state.bars))}</div></div></div>`,
    ])}
    ${group("Island", island)}
    ${group("Updates", [
      item(`Meterkat ${esc(state.version)}`, latest, updateButton),
      // Compact rows; the details are in the tooltips.
      `<div class="list-item compact" title="Beta gets new features first">${`<div class="grow item-title">Channel</div>`}<select class="select" data-action="update-channel" aria-label="Update channel">${channel("stable", "Stable")}${channel("beta", "Beta")}</select></div>`,
      ...update.install === "auto" ? [`<div class="list-item compact" title="Signed releases only; Meterkat restarts by itself while it is in the tray"><div class="grow item-title">Install automatically</div>${toggle("automatic-updates", update.automatic, "Install updates automatically")}</div>`] : [],
    ])}
    ${group("About", [
      item("Relay", `<span class="selectable">${esc(registration?.relay ?? "Not registered")}</span>`),
      link("source", "Source code"), link("terms", "Terms of use"), link("privacy", "Privacy"), link("licenses", "Licences"),
      `<button class="list-item action danger" data-action="quit">Quit Meterkat</button>`,
    ])}
    <p class="muted small footnote">Closing this window keeps Meterkat running in the tray.</p>`;
}

// ---- Setup wizard ---------------------------------------------------------------------------------------------

const STEPS: Step[] = ["tools", "relay", "autostart", "pair"];
function setupView() {
  const at = STEPS.indexOf(step);
  const dots = `<div class="steps" aria-hidden="true">${STEPS.map((s, i) => `<i class="${i <= at ? "done" : ""}"></i>`).join("")}</div>`;
  const stepOf = `${SYMBOL_MARK}<p class="step-of">Step ${at + 1} of ${STEPS.length}</p>`;
  if (step === "tools") {
    const rows = checks === null
      ? `<div class="check"><span class="spinner"></span><span>Looking for Claude Code, Codex and Antigravity…</span></div>`
      : checks.map(c => `<div class="check"><span class="icon ${c.ready ? "ok" : c.installed ? "warn" : "no"}">${c.ready ? "✓" : c.installed ? "!" : "–"}</span><div><div class="provider" data-color="${esc(providerColor(c.id))}">${providerMark(c.id)}${esc(providerName(c.id))}</div><div class="muted small">${esc(c.note)}</div></div></div>`).join("");
    const none = checks && !checks.some(c => c.installed) ? `<p class="muted small gap">No supported AI tool found. Install and sign in to Claude Code or Codex; Meterkat picks them up on its next sync.</p>` : "";
    return `${dots}<div class="setup-body">${stepOf}<h1>Welcome to Meterkat</h1><p class="lead">Meterkat reads the quota your AI tools report and sends it, end-to-end encrypted, to the Meterkat app on your phone. Your sign-ins stay with the tools.</p>
      <h2>AI tools on this computer</h2><div class="list">${rows}</div>${none}
      </div><div class="actions"><button class="btn primary block" data-action="to-relay" ${checks === null ? "disabled" : ""}>Continue</button></div>`;
  }
  if (step === "relay") {
    return `${dots}<div class="setup-body">${stepOf}<h1>Connect to the relay</h1><p class="lead">Your phone fetches encrypted snapshots from a relay. Registration is anonymous; the encryption key never leaves this computer and your phones.</p>
      <div class="list">
        <label class="option"><input type="radio" name="relay" value="hosted" ${customRelay ? "" : "checked"} data-action="relay-choice"><div><div>Meterkat relay (free)</div><div class="muted small">Under its <button class="link" data-link="terms">terms of use</button> and <button class="link" data-link="privacy">privacy policy</button>.</div></div></label>
        <label class="option"><input type="radio" name="relay" value="custom" ${customRelay ? "checked" : ""} data-action="relay-choice"><div class="grow"><div>Your own relay</div><div class="muted small">Any relay that speaks protocol v2.</div>${customRelay ? `<input class="field" id="relay-url" type="url" placeholder="https://relay.example.com" autocomplete="off" spellcheck="false">` : ""}</div></label>
      </div>
      ${setupError ? `<p class="error small gap">${esc(setupError)}</p>` : ""}
      </div><div class="actions"><button class="btn primary block" data-action="register" ${registering ? "disabled" : ""}>${registering ? `<span class="spinner"></span> Registering (a few seconds)…` : "Register"}</button></div>`;
  }
  if (step === "autostart") {
    return `${dots}<div class="setup-body">${stepOf}<h1>Keep it running</h1><p class="lead">Meterkat lives in the tray and syncs every minute. Start it when you sign in so your phone stays current.</p>
      ${state.autostart.supported ? `<div class="list">${item("Start at sign-in", "Opens hidden in the tray", toggle("setup-autostart", setupAutostart, "Start at sign-in"))}</div>` : ""}
      ${setupError ? `<p class="error small">${esc(setupError)}</p>` : ""}
      </div><div class="actions"><button class="btn primary block" data-action="to-pair">Continue</button></div>`;
  }
  return `${dots}<div class="setup-body">${stepOf}<h1>Connect your phone</h1>${pairingPanel("Install Meterkat on your Android phone, then scan the pairing code with the app.")}
    </div><div class="actions"><button class="btn ${connected ? "primary" : ""} block" data-action="finish">${connected ? "Done" : "Skip for now"}</button></div>`;
}

// ---- Rendering and events -------------------------------------------------------------------------------------

/** The focused control as a selector and position, so a re-render can give the focus back. */
function focusKey(): { selector: string; index: number } | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !$("#view").contains(el)) return null;
  if (el.id) return { selector: `#${CSS.escape(el.id)}`, index: 0 };
  const attrs = ["action", "tab", "link", "id", "mode", "anchor"].map(key => el.dataset[key] === undefined ? "" : `[data-${key}="${CSS.escape(el.dataset[key]!)}"]`).join("");
  if (!attrs) return null;
  const selector = el.tagName.toLowerCase() + attrs;
  return { selector, index: [...document.querySelectorAll(selector)].indexOf(el) };
}

function render() {
  renderStatus();
  // State updates rebuild the view; keyboard focus stays on the same control (a toggle, a segment, a button).
  const focused = focusKey();
  const inSetup = !state.registration || !setupDone;
  $("#tabs").hidden = inSetup;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.setAttribute("aria-current", button.dataset.tab === view ? "page" : "false");
  const relayInput = document.querySelector<HTMLInputElement>("#relay-url")?.value;
  // The wizard keeps its actions at the bottom of the window.
  $("#view").classList.toggle("setup", inSetup);
  $("#view").innerHTML = inSetup ? setupView() : view === "phones" ? phonesView() : view === "settings" ? settingsView() : view === "forecast" ? forecastView() : overview();
  hideDots($("#view"));
  // The CSP blocks style attributes; widths are set through the CSSOM instead.
  for (const fill of document.querySelectorAll<HTMLElement>(".fill[data-width]")) fill.style.width = `${fill.dataset.width}%`;
  for (const tick of document.querySelectorAll<HTMLElement>(".tick[data-left]")) tick.style.left = `${tick.dataset.left}%`;
  for (const el of document.querySelectorAll<HTMLElement>("[data-color]")) el.style.setProperty("--provider", el.dataset.color!);
  const restored = document.querySelector<HTMLInputElement>("#relay-url");
  if (restored && relayInput !== undefined) restored.value = relayInput;
  if (focused) document.querySelectorAll<HTMLElement>(focused.selector)[Math.max(focused.index, 0)]?.focus({ preventScroll: true });
  moreBelow();
}
/** Shows the fade above the tab bar while there is more to scroll to. */
function moreBelow() {
  const main = $("#view");
  document.body.classList.toggle("more-below", main.scrollTop + main.clientHeight < main.scrollHeight - 2);
}
$("#view").addEventListener("scroll", moreBelow, { passive: true });
addEventListener("resize", moreBelow);
function navigate(next: View) {
  if (next !== "phones" && pairing) { pairing = null; void api.stopPairing(); }
  view = next; connected = false; settingsError = null;
  if (next === "phones") { phones = null; void loadPhones(); }
  if (next === "forecast") void loadForecast();
  render();
}

async function startPairing() {
  try {
    connected = false; pairingError = null;
    const current = await api.devices().catch(() => null);
    pairedCount = current?.length ?? 0;
    pairing = await api.startPairing();
  } catch (error) { pairingError = message(error); }
  render();
}

/** "+N more" in the headline card: scrolls to the card of the next at-risk provider and outlines it for a moment. */
let flashTimer = 0;
function showCard(provider: string) {
  const card = [...document.querySelectorAll<HTMLElement>(".card[data-provider]")].find(c => c.dataset.provider === provider);
  if (!card) return;
  card.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  document.querySelectorAll(".card.flash").forEach(c => c.classList.remove("flash"));
  card.classList.add("flash");
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => card.classList.remove("flash"), 1800);
}

document.addEventListener("click", event => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action], [data-tab], [data-link]");
  if (!target) return;
  if (target.dataset.tab) return navigate(target.dataset.tab as View);
  if (target.dataset.link) { event.preventDefault(); void api.open(target.dataset.link as Parameters<MeterkatApi["open"]>[0]); return; }
  const action = target.dataset.action;
  if (target instanceof HTMLInputElement && target.type === "checkbox") return; // handled on change
  void (async () => {
    switch (action) {
      case "sync": await api.syncNow(); break;
      case "pair": await startPairing(); break;
      case "cancel-pair": pairing = null; await api.stopPairing(); render(); break;
      case "copy-pair":
        try { await api.copyPairingLink(); linkCopied = true; render(); setTimeout(() => { linkCopied = false; if (pairing) render(); }, 2000); }
        catch (error) { pairingError = message(error); pairing = null; render(); }
        break;
      case "revoke": try { await api.revokeDevice(target.dataset.id!); } catch (error) { phonesError = message(error); } await loadPhones(); break;
      case "revoke-all": try { if (await api.revokeAll()) await loadPhones(); } catch (error) { phonesError = message(error); render(); } break;
      case "take-over": try { await api.takeOver(); } catch (error) { settingsError = message(error); render(); } break;
      case "check-update": updateBusy = true; render(); try { await api.checkUpdate(); } catch { /* shown from state */ } updateBusy = false; render(); break;
      case "install-update": updateBusy = true; render(); try { await api.installUpdate(); } catch { /* shown from state */ } updateBusy = false; render(); break;
      case "download": await api.open("releases"); break;
      case "island-anchor": try { await api.setIslandAnchor(target.dataset.anchor === "window" ? "window" : "screen"); } catch (error) { settingsError = message(error); render(); } break;
      case "show-risk": showCard(target.dataset.target ?? ""); break;
      case "dismiss-key": try { await api.dismissKey(); } catch (error) { settingsError = message(error); render(); } break;
      case "bar-mode": try { await api.setBarMode(target.dataset.mode === "remaining" ? "remaining" : "used"); } catch (error) { settingsError = message(error); render(); } break;
      case "quit": api.quit(); break;
      case "to-relay": step = "relay"; render(); break;
      case "register": await register(); break;
      case "to-pair":
        setupError = null;
        try { if (state.autostart.supported) await api.setAutostart(setupAutostart); step = "pair"; } catch (error) { setupError = message(error); }
        render(); if (step === "pair") await startPairing();
        break;
      case "finish": if (pairing) { pairing = null; await api.stopPairing(); } setupDone = true; connected = false; step = "tools"; view = "overview"; render(); break;
    }
  })();
});

// Segmented controls: arrows (and Home/End) select the next segment and keep the focus on it, as in a radio group.
document.addEventListener("keydown", event => {
  const current = (event.target as HTMLElement).closest<HTMLElement>("[role=radio]");
  const radios = [...current?.closest("[role=radiogroup]")?.querySelectorAll<HTMLElement>("[role=radio]") ?? []];
  const next = current ? radioStep(radios.indexOf(current), radios.length, event.key) : null;
  if (next === null || !radios[next]) return;
  event.preventDefault();
  radios[next].focus();
  if (radios[next] !== current) radios[next].click();
});

document.addEventListener("change", event => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.action === "relay-choice") { customRelay = target.value === "custom"; setupError = null; render(); document.querySelector<HTMLInputElement>("#relay-url")?.focus(); }
  if (target.dataset.action === "setup-autostart") setupAutostart = target.checked;
  if (target.dataset.action === "update-channel") void api.setUpdateChannel(target.value === "beta" ? "beta" : "stable").catch(error => { settingsError = message(error); render(); });
  if (target.dataset.action === "automatic-updates") void api.setAutomaticUpdates(target.checked).catch(error => { settingsError = message(error); render(); });
  if (target.dataset.action === "autostart") void api.setAutostart(target.checked).catch(error => { settingsError = message(error); render(); });
  if (target.dataset.action === "island") void api.setIsland(target.checked).catch(error => { settingsError = message(error); render(); });
});

async function register() {
  const relay = customRelay ? document.querySelector<HTMLInputElement>("#relay-url")?.value.trim() ?? "" : null;
  if (customRelay && !relay) { setupError = "Enter the relay address, e.g. https://relay.example.com"; render(); return; }
  registering = true; setupError = null; setupDone = false; render();
  try { await api.register(relay); step = "autostart"; }
  catch (error) { setupError = message(error); setupDone = true; }
  registering = false; render();
}

api.onState(next => {
  state = next;
  // Re-rendering would reset the relay field and the QR countdown; the setup and phones views update themselves.
  const inSetup = !state.registration || !setupDone;
  if (inSetup || view === "phones") renderStatus(); else render();
  if (view === "forecast") void loadForecast();
});
// Sent when the window collapses into the tray, too: the main process has ended any pairing by then.
api.onNavigate(next => {
  pairing = null;
  if (state.registration && setupDone) navigate(next); else render();
});

setInterval(() => {
  if (!state) return;
  renderStatus();
  if (pairing) {
    const el = document.querySelector("#countdown");
    if (pairing.expiresAt <= Date.now()) { pairing = null; render(); }
    else if (el) { const left = pairing.expiresAt - Date.now(); el.textContent = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`; }
  }
}, 1000);
// While a code is shown, look for the new phone every few seconds.
setInterval(() => { if (pairing) void loadPhones(); }, 4000);
// Relative times ("2m ago", "Resets in …") and pace in the overview.
setInterval(() => { if (state?.registration && setupDone && view === "overview") render(); }, 30_000);

$("#brand").innerHTML = LOCKUP;
void (async () => {
  state = await api.state();
  if (!state.registration) {
    setupDone = false; render();
    checks = await api.detectProviders().catch(() => []);
  }
  render();
})();
