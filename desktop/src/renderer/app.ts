// The window: setup wizard until the companion is registered, then Overview, Phones and Settings.
// All data comes through window.meterkat (preload.ts); the page has no Node or network access of its own.
import { ago, bars, percent, providerColor, providerGroups, providerMark, providerName, resetText } from "../format.js";
import type { AppState, Device, MeterkatApi, Pairing, ProviderCheck, View } from "../ipc.js";

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
// Settings
let updateBusy = false;
let settingsError: string | null = null;

// ---- Status line ----------------------------------------------------------------------------------------------

function renderStatus() {
  const el = $("#status"); const { sync, registration } = state;
  let kind = ""; let text = "";
  if (!registration) text = "Not set up";
  else if (sync.running) { kind = "busy"; text = "Syncing…"; }
  else if (sync.error) { kind = "bad"; text = "Sync failed"; }
  else if (sync.lastSuccess) { kind = "ok"; text = `Synced ${ago(sync.lastSuccess)}`; }
  else text = "Waiting for first sync";
  el.className = `status ${kind}`;
  el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
}

// ---- Overview -------------------------------------------------------------------------------------------------

function overview() {
  const { snapshot, sync } = state;
  const { shown, notSetUp } = providerGroups(snapshot);
  const cards = shown.map(p => {
    const badge = p.state === "ok" ? `<span class="badge ok">Live</span>` : p.state === "auth_required" ? `<span class="badge warn">Sign-in needed</span>` : `<span class="badge">Unavailable</span>`;
    const rows = bars(p).map(b => {
      return `<div class="bar"><span class="bar-label">${esc(b.label)}</span><span class="bar-value">${percent(b.usedPercent)}</span><div class="track" role="meter" aria-label="${esc(b.label)} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(b.usedPercent)}"><div class="fill" data-width="${Math.min(100, Math.max(0, b.usedPercent))}"></div></div><span class="bar-reset">${esc(resetText(b.resetsAt))}</span></div>`;
    }).join("");
    const observed = p.sampledAt ? `Observed ${ago(p.sampledAt)}` : "No quota observed yet";
    return `<section class="card" data-color="${esc(providerColor(p.id))}"><div class="card-head"><strong class="provider">${providerMark(p.id)}${esc(providerName(p.id))}</strong>${badge}</div>${rows || `<p class="muted small">No quota data. Check that ${esc(providerName(p.id))} is installed and signed in.</p>`}<div class="observed">${esc(observed)}</div></section>`;
  }).join("");
  const missing = notSetUp.length ? `<div class="list">${notSetUp.map(id => `<div class="list-item compact not-set-up" data-color="${esc(providerColor(id))}"><span class="provider">${providerMark(id)}${esc(providerName(id))}</span><span class="muted small">Not set up</span></div>`).join("")}</div>` : "";
  const waiting = sync.mode === "service" ? "Waiting for the background companion…" : "Reading your AI tools…";
  const body = (cards || missing) ? cards + missing : `<div class="empty"><span class="spinner"></span><p class="gap">${waiting}</p></div>`;
  const footer = sync.mode === "service"
    ? `<p class="muted small gap">The CLI companion syncs in the background on this computer; this window shows its data. You can let the app take over in Settings.</p>`
    : `<div class="sync-bar"><span class="muted small">${sync.error ? `<span class="error">${esc(sync.error)}</span>` : "Syncs every minute while Meterkat runs, also from the tray."}</span><button class="btn" data-action="sync" ${sync.running ? "disabled" : ""}>${sync.running ? `<span class="spinner"></span>` : "Sync now"}</button></div>`;
  return `<h2>Your quota</h2>${body}${footer}`;
}

// ---- Phones ---------------------------------------------------------------------------------------------------

function pairingPanel(intro: string) {
  if (connected) return `<section class="card center"><p class="success">Phone connected</p><p class="muted small">It receives your quota from the next sync.</p></section>`;
  if (!pairing) return `<section class="card"><p>${intro}</p>${pairingError ? `<p class="error small">${esc(pairingError)}</p>` : ""}<button class="btn primary block" data-action="pair">Show pairing code</button></section>`;
  const left = Math.max(0, pairing.expiresAt - Date.now());
  const time = `${Math.floor(left / 60_000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  return `<section class="card center">
    <img class="qr" src="${esc(pairing.qr)}" alt="Pairing QR code">
    <p>Scan with the Meterkat app on <strong>your own</strong> phone.</p>
    <p class="muted small">The code contains your encryption key: don't share it or take a screenshot. Single use, expires in <span class="countdown" id="countdown">${time}</span>.</p>
    <button class="btn" data-action="cancel-pair">Cancel</button>
  </section>`;
}

function phonesView() {
  if (state.registration?.protocol !== 2) return `<div class="notice">This companion uses the older relay protocol. Manage its phones with the CLI.</div>`;
  const list = phones === null
    ? `<div class="list"><div class="list-item muted">${phonesError ? `<span class="error">${esc(phonesError)}</span>` : `<span><span class="spinner"></span> Loading…</span>`}</div></div>`
    : phones.length === 0 ? `<div class="list"><div class="list-item muted">No phone connected yet.</div></div>`
    : `<div class="list">${phones.map(d => `<div class="list-item"><div><div>Phone <span class="muted">${esc(d.id.slice(0, 8))}</span></div><div class="muted small">Paired ${esc(new Date(d.pairedAt).toLocaleDateString(undefined, { dateStyle: "medium" }))}</div></div><button class="btn" data-action="revoke" data-id="${esc(d.id)}">Remove</button></div>`).join("")}</div>`;
  return `<h2>Connect a phone</h2>${pairingPanel("Install Meterkat on your Android phone, then show a pairing code here and scan it with the app.")}
    <h2>Paired phones</h2>${list}
    ${phones?.length ? `<div class="actions"><button class="btn danger" data-action="revoke-all">Remove all phones</button></div>` : ""}`;
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

function settingsView() {
  const { autostart, update, registration } = state;
  const running = state.sync.mode === "service";
  const serviceText = autostart.service ? `The CLI companion is also set up to start at sign-in${running ? " and is syncing right now" : ""}.` : "The CLI companion is syncing in the background right now.";
  const service = autostart.service || running ? `<div class="notice"><p>${serviceText} Two companions would send the same data twice.</p><button class="btn" data-action="take-over">Let the app sync instead</button></div>` : "";
  const start = autostart.supported ? `<div class="card row"><div><div>Start at sign-in</div><div class="muted small">Opens hidden in the tray and keeps your phone up to date.</div></div>${toggle("autostart", autostart.app, "Start at sign-in")}</div>` : "";
  const latest = update.newer ? `Meterkat ${esc(update.latest)} is available.` : update.latest ? "You have the latest version." : update.error ? `<span class="error">${esc(update.error)}</span>` : "Not checked yet.";
  return `<h2>Startup</h2>${service}${start}
    <h2>Updates</h2>
    <div class="card"><div class="row"><div><div>Version ${esc(state.version)}</div><div class="muted small">${latest}</div></div>
      ${update.newer ? `<button class="btn primary" data-action="download">Download</button>` : `<button class="btn" data-action="check-update" ${updateBusy ? "disabled" : ""}>${updateBusy ? `<span class="spinner"></span>` : "Check now"}</button>`}</div></div>
    <h2>Relay</h2>
    <div class="card"><div class="small selectable">${esc(registration?.relay ?? "Not registered")}</div><div class="muted small">End-to-end encrypted: the relay only ever sees ciphertext. The key stays on this computer and your paired phones.</div></div>
    ${settingsError ? `<p class="error small">${esc(settingsError)}</p>` : ""}
    <div class="actions"><button class="link small" data-link="source">Source code</button><span class="muted">·</span><button class="link small" data-link="terms">Terms</button><span class="muted">·</span><button class="link small" data-link="privacy">Privacy</button><span class="muted">·</span><button class="link small" data-link="licenses">Licences</button></div>
    <h2>Meterkat</h2>
    <p class="muted small">Closing this window keeps Meterkat running in the tray.</p>
    <button class="btn danger" data-action="quit">Quit Meterkat</button>`;
}

// ---- Setup wizard ---------------------------------------------------------------------------------------------

const STEPS: Step[] = ["tools", "relay", "autostart", "pair"];
function setupView() {
  const dots = `<div class="steps" aria-hidden="true">${STEPS.map((s, i) => `<i class="${i <= STEPS.indexOf(step) ? "done" : ""}"></i>`).join("")}</div>`;
  if (step === "tools") {
    const rows = checks === null
      ? `<div class="check"><span class="spinner"></span><span>Looking for Claude Code, Codex and Antigravity…</span></div>`
      : checks.map(c => `<div class="check"><span class="icon ${c.ready ? "ok" : c.installed ? "warn" : "no"}">${c.ready ? "✓" : c.installed ? "!" : "–"}</span><div><div class="provider" data-color="${esc(providerColor(c.id))}">${providerMark(c.id)}${esc(providerName(c.id))}</div><div class="muted small">${esc(c.note)}</div></div></div>`).join("");
    const none = checks && !checks.some(c => c.installed) ? `<p class="muted small gap">No supported AI tool found. Install and sign in to Claude Code or Codex; Meterkat picks them up on its next sync.</p>` : "";
    return `${dots}<h1>Welcome to Meterkat</h1><p class="muted">Meterkat reads the quota your AI tools report and sends it, end-to-end encrypted, to the Meterkat app on your phone. Your sign-ins stay with the tools.</p>
      <h2>AI tools on this computer</h2><div class="list">${rows}</div>${none}
      <div class="actions"><button class="btn primary block" data-action="to-relay" ${checks === null ? "disabled" : ""}>Continue</button></div>`;
  }
  if (step === "relay") {
    return `${dots}<h1>Connect to the relay</h1><p class="muted">Your phone fetches encrypted snapshots from a relay. Registration is anonymous; the encryption key never leaves this computer and your phones.</p>
      <div class="list">
        <label class="option"><input type="radio" name="relay" value="hosted" ${customRelay ? "" : "checked"} data-action="relay-choice"><div><div>Meterkat relay (free)</div><div class="muted small">Under its <button class="link" data-link="terms">terms of use</button> and <button class="link" data-link="privacy">privacy policy</button>.</div></div></label>
        <label class="option"><input type="radio" name="relay" value="custom" ${customRelay ? "checked" : ""} data-action="relay-choice"><div class="grow"><div>Your own relay</div><div class="muted small">Any relay that speaks protocol v2.</div>${customRelay ? `<input class="field" id="relay-url" type="url" placeholder="https://relay.example.com" autocomplete="off" spellcheck="false">` : ""}</div></label>
      </div>
      ${setupError ? `<p class="error small gap">${esc(setupError)}</p>` : ""}
      <div class="actions"><button class="btn primary block" data-action="register" ${registering ? "disabled" : ""}>${registering ? `<span class="spinner"></span> Registering (a few seconds)…` : "Register"}</button></div>`;
  }
  if (step === "autostart") {
    return `${dots}<h1>Keep it running</h1><p class="muted">Meterkat lives in the tray and syncs every minute. Start it when you sign in so your phone stays current.</p>
      ${state.autostart.supported ? `<div class="card row"><div><div>Start at sign-in</div><div class="muted small">Opens hidden in the tray.</div></div>${toggle("setup-autostart", setupAutostart, "Start at sign-in")}</div>` : ""}
      ${setupError ? `<p class="error small">${esc(setupError)}</p>` : ""}
      <div class="actions"><button class="btn primary block" data-action="to-pair">Continue</button></div>`;
  }
  return `${dots}<h1>Connect your phone</h1>${pairingPanel("Install Meterkat on your Android phone, then scan the pairing code with the app.")}
    <div class="actions"><button class="btn ${connected ? "primary" : ""} block" data-action="finish">${connected ? "Done" : "Skip for now"}</button></div>`;
}

// ---- Rendering and events -------------------------------------------------------------------------------------

function render() {
  renderStatus();
  const inSetup = !state.registration || !setupDone;
  $("#tabs").hidden = inSetup;
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) button.setAttribute("aria-current", button.dataset.tab === view ? "page" : "false");
  const relayInput = document.querySelector<HTMLInputElement>("#relay-url")?.value;
  $("#view").innerHTML = inSetup ? setupView() : view === "phones" ? phonesView() : view === "settings" ? settingsView() : overview();
  // The CSP blocks style attributes; widths are set through the CSSOM instead.
  for (const fill of document.querySelectorAll<HTMLElement>(".fill[data-width]")) fill.style.width = `${fill.dataset.width}%`;
  for (const el of document.querySelectorAll<HTMLElement>("[data-color]")) el.style.setProperty("--provider", el.dataset.color!);
  const restored = document.querySelector<HTMLInputElement>("#relay-url");
  if (restored && relayInput !== undefined) restored.value = relayInput;
}
function navigate(next: View) {
  if (next !== "phones" && pairing) { pairing = null; void api.stopPairing(); }
  view = next; connected = false; settingsError = null;
  if (next === "phones") { phones = null; void loadPhones(); }
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
      case "revoke": try { await api.revokeDevice(target.dataset.id!); } catch (error) { phonesError = message(error); } await loadPhones(); break;
      case "revoke-all": try { if (await api.revokeAll()) await loadPhones(); } catch (error) { phonesError = message(error); render(); } break;
      case "take-over": try { await api.takeOver(); } catch (error) { settingsError = message(error); render(); } break;
      case "check-update": updateBusy = true; render(); try { await api.checkUpdate(); } catch { /* shown from state */ } updateBusy = false; render(); break;
      case "download": await api.open("releases"); break;
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

document.addEventListener("change", event => {
  const target = event.target as HTMLInputElement;
  if (target.dataset.action === "relay-choice") { customRelay = target.value === "custom"; setupError = null; render(); document.querySelector<HTMLInputElement>("#relay-url")?.focus(); }
  if (target.dataset.action === "setup-autostart") setupAutostart = target.checked;
  if (target.dataset.action === "autostart") void api.setAutostart(target.checked).catch(error => { settingsError = message(error); render(); });
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
// Relative times ("2 min ago", "resets in …") in the overview.
setInterval(() => { if (state?.registration && setupDone && view === "overview") render(); }, 30_000);

void (async () => {
  state = await api.state();
  if (!state.registration) {
    setupDone = false; render();
    checks = await api.detectProviders().catch(() => []);
  }
  render();
})();
