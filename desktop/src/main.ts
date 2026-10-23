// Meterkat desktop: the companion as a tray app. The window collapses into the tray on close or minimise; the
// tray menu reopens it, syncs, pairs a phone or quits. Syncing, pairing and the relay calls reuse the CLI modules.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, Tray, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from "electron";
import { homedir, uptime } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import QRCode from "qrcode";
import { parseSnapshot, type Snapshot } from "../../shared/snapshot.js";
import { defaultContext, remove as removeCliAutostart, status as cliAutostartStatus } from "../../src/autostart.js";
import { collect } from "../../src/collect.js";
import { detectProviders } from "../../src/providers.js";
import { defaultRelay } from "../../src/registration.js";
import { isV2, pairingLinkV2, uploadV2, writerCall, type V2Config } from "../../src/relay-v2.js";
import { readState, relayUrl, stateDirectory, writeState, type Config } from "../../src/state.js";
import { automaticUpdates, checkForUpdate, compareVersions, setAutomatic, updateSettings, type Release } from "../../src/update.js";
import { COMPANION_VERSION } from "../../src/version.js";
import { unsupportedReason } from "./foreground.js";
import { trayLines, type BarMode } from "./format.js";
import { createIsland } from "./island.js";
import { CHANNEL, type AppState, type Device, type ExternalLink, type Pairing, type SyncMode, type View } from "./ipc.js";
import { autostartFile, HIDDEN_ARG, launchCommand, linuxAutostart, LOGIN_ITEM_NAME } from "./login-item.js";
import { cleanUp, installation, launch, prepare, spawnDetached, UPDATED_ARG, VERSION_ARG, type Prepared } from "./self-update.js";
import { backgroundPid, cliServiceRunning } from "./service.js";
import { loginShellPath, mergePath } from "./shell-path.js";

const SYNC_INTERVAL_MS = 60_000;
const MIN_SYNC_GAP_MS = 20_000;
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_RETRY_MS = 60 * 60 * 1000;
const PAIRING_MS = 300_000;
const LINKS: Record<Exclude<ExternalLink, "licenses">, string> = {
  releases: "https://github.com/Fade97/meterkat-companion/releases",
  source: "https://github.com/Fade97/meterkat-companion",
  terms: "https://meterkat.fabian-duerkop.de/terms",
  privacy: "https://meterkat.fabian-duerkop.de/privacy",
};
type DesktopSettings = { trayHintShown?: boolean; notifiedVersion?: string; updateCheckedAt?: number; updateLatest?: string; relaunchHidden?: boolean; island?: boolean; showRemaining?: boolean };

const assets = join(app.getAppPath(), "assets");
let win: BrowserWindow | null = null;
/** The window is shown or about to be (it appears only once its page is ready). */
let windowOpen = false;
let tray: Tray | null = null;
let quitting = false;
let syncTimer: NodeJS.Timeout | null = null;
let pairingTimer: NodeJS.Timeout | null = null;
let island: ReturnType<typeof createIsland> | null = null;
const settings = () => readState<DesktopSettings>("desktop.json") ?? {};
const saveSettings = (patch: DesktopSettings) => writeState("desktop.json", { ...settings(), ...patch });
const sync: AppState["sync"] = { mode: "app", running: false, lastSuccess: null, error: null };
const install = installation(process.env, process.platform, process.arch, process.execPath, app.isPackaged);
const update: AppState["update"] = { latest: null, newer: false, checkedAt: null, error: null, ...lastCheck(), install: install.kind === "manual" ? "manual" : "auto", automatic: true, downloading: false, ready: null };
let release: Release | null = null;
let lastAttempt = 0;
let prepared: Prepared | null = null;
let preparing: Promise<Prepared> | null = null;
let relaunch: ReturnType<typeof launch> | null = null;
let serviceInstalled = false;

/** The last check survives a restart, so a freshly updated app does not claim it never checked. */
function lastCheck() {
  const { updateLatest: latest, updateCheckedAt: checkedAt } = settings();
  try { return latest && checkedAt ? { latest, checkedAt, newer: compareVersions(latest, COMPANION_VERSION) > 0 } : {}; } catch { return {}; }
}

const config = () => readState<Config>("config.json");
function v2Config(): V2Config {
  const current = config();
  if (!current) throw new Error("Not registered yet");
  if (!isV2(current)) throw new Error("This source uses protocol v1; manage it with the CLI companion");
  return current;
}
function snapshot(): Snapshot | null {
  try { return parseSnapshot(readState("snapshot.json")); } catch { return null; }
}

// ---- Autostart -------------------------------------------------------------------------------------------------

function appAutostart() {
  const command = launchCommand(process.env, process.execPath, app.isPackaged, app.getAppPath());
  if (process.platform === "linux") {
    const entry = linuxAutostart(autostartFile(process.env, homedir()));
    return { supported: true, enabled: entry.enabled(), set: (on: boolean) => entry.set(on, command) };
  }
  if (process.platform === "win32") {
    // Electron quotes the path but joins the arguments as they are.
    const [path, ...args] = command.map((part, i) => i > 0 && part.includes(" ") ? `"${part}"` : part) as [string, ...string[]];
    // openAtLogin looks for a Run value named after the AppUserModelId; ours is named LOGIN_ITEM_NAME.
    const items = app.getLoginItemSettings({ path, args }).launchItems ?? [];
    const enabled = items.some(item => item.name === LOGIN_ITEM_NAME && item.scope === "user" && item.enabled);
    return { supported: true, enabled, set: (on: boolean) => app.setLoginItemSettings({ openAtLogin: on, path, args, name: LOGIN_ITEM_NAME }) };
  }
  return { supported: false, enabled: false, set: () => { throw new Error(`Autostart is not supported on ${process.platform}`); } };
}

/** CLI autostart and a running CLI service; a running service syncs, so the app does not upload as well. */
function refreshEnvironment() {
  try { serviceInstalled = ["linux", "win32"].includes(process.platform) && cliAutostartStatus(defaultContext()).installed; } catch { serviceInstalled = false; }
  const mode: SyncMode = cliServiceRunning(stateDirectory()) ? "service" : "app";
  if (mode !== sync.mode) { sync.mode = mode; sync.error = null; }
}

// ---- State -----------------------------------------------------------------------------------------------------

function state(): AppState {
  const current = config(); const data = snapshot(); const autostart = appAutostart();
  return {
    version: COMPANION_VERSION, platform: process.platform,
    registration: current ? { relay: current.relay, protocol: isV2(current) ? 2 : 1 } : null,
    snapshot: data,
    // The service writes snapshot.json before every upload; that is the app's only view of its progress.
    sync: sync.mode === "service" ? { ...sync, lastSuccess: data?.generatedAt ?? null } : { ...sync },
    autostart: { supported: autostart.supported, app: autostart.enabled, service: serviceInstalled },
    update: { ...update, automatic: automaticUpdates() },
    island: { enabled: islandEnabled(), unsupported: island?.unsupported ?? unsupportedReason(process.platform, process.env) },
    bars: barMode(),
  };
}

const barMode = (): BarMode => settings().showRemaining === true ? "remaining" : "used";
function setBarMode(mode: BarMode) {
  saveSettings({ showRemaining: mode === "remaining" });
  changed();
}

const islandEnabled = () => settings().island !== false;
function setIsland(enabled: boolean) {
  saveSettings({ island: enabled });
  island?.refresh(); changed();
}

function changed() {
  const current = state();
  if (win && !win.isDestroyed()) win.webContents.send(CHANNEL.stateChanged, current);
  buildTray(current);
  island?.refresh();
}

// ---- Sync ------------------------------------------------------------------------------------------------------

async function syncOnce() {
  if (sync.running || sync.mode !== "app" || !config()) return;
  // The relay accepts one snapshot per 20 s; a sync right after the last one has nothing new to send.
  if (sync.lastSuccess && Date.now() - sync.lastSuccess < MIN_SYNC_GAP_MS) return;
  sync.running = true; changed();
  try {
    const source = v2Config();
    await uploadV2(source, await collect());
    sync.lastSuccess = Date.now(); sync.error = null;
  } catch (error) {
    sync.error = error instanceof Error ? error.message : "Sync failed";
  } finally {
    sync.running = false; changed();
  }
}

async function tick() {
  if (syncTimer) clearTimeout(syncTimer);
  refreshEnvironment();
  if (sync.mode === "app") await syncOnce(); else changed();
  // A newer version known from before a restart is fetched again right away; failed checks retry hourly.
  const due = (settings().updateCheckedAt ?? 0) < Date.now() - UPDATE_INTERVAL_MS || (update.newer && !release);
  if (process.env.AI_USAGE_NO_UPDATE !== "1" && due && !preparing && Date.now() - lastAttempt > UPDATE_RETRY_MS) void checkUpdate(false);
  // A downloaded update restarts the app only while it sits in the tray; with the window open it waits.
  if (prepared && automaticUpdates() && !windowOpen && !sync.running) return restartToUpdate();
  syncTimer = setTimeout(() => void tick(), SYNC_INTERVAL_MS);
}

// ---- Updates ---------------------------------------------------------------------------------------------------

/** Daily check. With automatic updates on, a newer release is downloaded and verified in the background. */
async function checkUpdate(manual: boolean) {
  lastAttempt = Date.now();
  try {
    const result = await checkForUpdate(fetch, COMPANION_VERSION);
    release = result.release ?? null;
    Object.assign(update, { latest: release?.version ?? null, newer: result.newer, checkedAt: Date.now(), error: null });
    saveSettings({ updateCheckedAt: Date.now(), updateLatest: release?.version });
    if (!result.newer || !release) return;
    // A version that failed its start check is not retried automatically; a newer one is.
    if (update.install === "auto" && automaticUpdates() && updateSettings().skipped !== release.version) {
      await download(release);
      if (windowOpen) notifyOnce(release.version, `Meterkat ${release.version} is ready`, "It installs when you close the window, or choose Restart to update.", () => showWindow("settings"));
      else void tick();
    } else if (update.install === "auto") {
      notifyOnce(release.version, `Meterkat ${release.version} is available`, "Open the settings to update.", () => showWindow("settings"));
    } else {
      notifyOnce(release.version, `Meterkat ${release.version} is available`, "Open the download page from the tray menu or the settings.", () => void shell.openExternal(LINKS.releases));
    }
  } catch (error) {
    Object.assign(update, { checkedAt: Date.now(), error: error instanceof Error ? error.message : "Update check failed" });
    if (manual) throw error;
  } finally { changed(); }
}

function notifyOnce(version: string, title: string, body: string, click: () => void) {
  if (settings().notifiedVersion === version || !Notification.isSupported()) return;
  saveSettings({ notifiedVersion: version });
  const note = new Notification({ title, body });
  note.on("click", click); note.show();
}

/** Downloads and verifies a release once; an AppImage is already swapped in when this resolves. */
async function download(next: Release) {
  if (prepared && compareVersions(prepared.version, next.version) >= 0) return prepared;
  if (preparing) return preparing;
  update.downloading = true; update.error = null; changed();
  preparing = prepare(next, install, join(app.getPath("userData"), "updates"));
  try {
    prepared = await preparing; update.ready = prepared.version;
    return prepared;
  } finally { preparing = null; update.downloading = false; changed(); }
}

/** "Update now": downloads if needed (also a version skipped by automatic checks), then restarts. */
async function installUpdate() {
  try {
    if (!prepared) {
      if (!release || !update.newer) await checkUpdate(true);
      if (!release || !update.newer) return;
      await download(release);
    }
    restartToUpdate();
  } catch (error) {
    update.error = error instanceof Error ? error.message : "Update failed"; changed();
    throw error;
  }
}

/** Quits and starts the new version: the swapped AppImage, or the installer, which restarts the app itself. */
function restartToUpdate() {
  if (!prepared) return;
  const hidden = !windowOpen;
  // The installer starts the app without arguments; this decides whether it comes back hidden.
  if (prepared.kind === "nsis") saveSettings({ relaunchHidden: hidden });
  relaunch = launch(prepared, hidden, process.argv.slice(1));
  app.quit();
}

// ---- Registration, pairing, phones -----------------------------------------------------------------------------

function register(relay: string | null) {
  if (config()) throw new Error("Already registered");
  const origin = relay === null ? defaultRelay() : relayUrl(relay);
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(join(__dirname, "register-worker.cjs"), { workerData: { relay: origin } });
    worker.once("message", (result: { ok: boolean; error?: string }) => result.ok ? resolve() : reject(new Error(result.error)));
    worker.once("error", reject);
    worker.once("exit", code => { if (code !== 0) reject(new Error("Registration stopped unexpectedly")); });
  }).finally(() => { void tick(); });
}

async function startPairing(): Promise<Pairing> {
  const { link, expiresAt } = await pairingLinkV2(v2Config());
  const until = Math.min(Number(expiresAt) || Infinity, Date.now() + PAIRING_MS);
  const qr = await QRCode.toDataURL(link, { width: 320, margin: 2, errorCorrectionLevel: "M" });
  // The QR holds the source key: keep it out of screenshots and screen sharing where the OS supports that.
  win?.setContentProtection(true);
  if (pairingTimer) clearTimeout(pairingTimer);
  pairingTimer = setTimeout(stopPairing, until - Date.now());
  return { qr, expiresAt: until };
}

function stopPairing() {
  if (pairingTimer) { clearTimeout(pairingTimer); pairingTimer = null; }
  if (win && !win.isDestroyed()) win.setContentProtection(false);
}

async function devices(): Promise<Device[]> {
  const result = await writerCall(v2Config(), "/v2/devices", "GET") as { devices: Device[] };
  return result.devices.map(d => ({ id: String(d.id), pairedAt: Number(d.pairedAt) }));
}

async function revokeDevice(id: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid phone ID");
  await writerCall(v2Config(), `/v2/devices/${encodeURIComponent(id)}`, "DELETE");
}

async function revokeAll() {
  const options = { type: "warning" as const, buttons: ["Cancel", "Remove all phones"], defaultId: 0, cancelId: 0, title: "Remove all phones", message: "Remove every paired phone?", detail: "They stop receiving your quota until you connect them again." };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response !== 1) return false;
  await writerCall(v2Config(), "/v2/revoke", "POST");
  return true;
}

/** The app replaces the CLI service: its autostart is removed and its process stopped, then the app syncs. */
async function takeOver() {
  removeCliAutostart(defaultContext());
  if (process.platform === "win32") {
    const pid = backgroundPid(stateDirectory(), Date.now() - uptime() * 1000);
    if (pid) { try { process.kill(pid); } catch { /* already gone */ } }
  }
  const autostart = appAutostart();
  if (autostart.supported) autostart.set(true);
  await tick();
}

// ---- Window and tray -------------------------------------------------------------------------------------------

function createWindow(show: boolean) {
  win = new BrowserWindow({
    width: 460, height: 720, minWidth: 380, minHeight: 540, show: false, title: "Meterkat",
    backgroundColor: "#101318", icon: join(assets, "icon.png"), autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
  });
  win.removeMenu();
  win.on("close", event => { if (!quitting) { event.preventDefault(); collapse(); } });
  win.on("minimize", () => collapse());
  win.on("closed", () => { win = null; windowOpen = false; });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => event.preventDefault());
  void win.loadFile(join(__dirname, "renderer", "index.html"));
  windowOpen = show;
  if (show) win.once("ready-to-show", () => win?.show());
}

function showWindow(view?: View) {
  if (!win) createWindow(false);
  if (win!.isMinimized()) win!.restore();
  win!.show(); win!.focus(); windowOpen = true;
  if (view) win!.webContents.send(CHANNEL.navigate, view);
}

function collapse() {
  if (!win || win.isDestroyed()) return;
  stopPairing(); win.webContents.send(CHANNEL.navigate, "overview"); win.hide(); windowOpen = false;
  if (!settings().trayHintShown && Notification.isSupported()) {
    saveSettings({ trayHintShown: true });
    new Notification({ title: "Meterkat keeps running", body: "It syncs in the background. Open it from the tray icon, or choose Quit there." }).show();
  }
}

function buildTray(current: AppState) {
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(join(assets, "tray.png")));
    // Linux (AppIndicator) has no click events; the menu's first entry opens the window there.
    tray.on("click", () => win?.isVisible() ? collapse() : showWindow());
  }
  const lines = trayLines(current.snapshot, current.bars);
  tray.setToolTip(["Meterkat", ...lines].join("\n"));
  const registered = !!current.registration;
  const items: MenuItemConstructorOptions[] = [
    { label: "Open Meterkat", click: () => showWindow() },
    ...lines.map(label => ({ label, enabled: false })),
    { type: "separator" },
    { label: current.sync.running ? "Syncing…" : "Sync now", enabled: registered && current.sync.mode === "app" && !current.sync.running, click: () => void syncOnce() },
    { label: "Connect a phone…", enabled: current.registration?.protocol === 2, click: () => showWindow("phones") },
    { type: "separator" },
    ...(current.autostart.supported ? [{ label: "Start at sign-in", type: "checkbox" as const, checked: current.autostart.app, click: (item: Electron.MenuItem) => { try { appAutostart().set(item.checked); } finally { changed(); } } }] : []),
    ...(!current.island.unsupported ? [{ label: "Show island at the top edge", type: "checkbox" as const, checked: current.island.enabled, click: (item: Electron.MenuItem) => setIsland(item.checked) }] : []),
    ...updateItems(current.update),
    { type: "separator" },
    { label: "Quit Meterkat", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function updateItems(state: AppState["update"]): MenuItemConstructorOptions[] {
  if (state.ready) return [{ label: `Restart to update to ${state.ready}`, click: () => restartToUpdate() }];
  if (state.downloading) return [{ label: `Downloading Meterkat ${state.latest}…`, enabled: false }];
  if (!state.newer) return [];
  return state.install === "auto"
    ? [{ label: `Update to Meterkat ${state.latest}`, click: () => void installUpdate().catch(() => undefined) }]
    : [{ label: `Download Meterkat ${state.latest}`, click: () => void shell.openExternal(LINKS.releases) }];
}

// ---- IPC -------------------------------------------------------------------------------------------------------

function handle(channel: string, listener: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
    // Only the app's own page may call in; it never navigates elsewhere, but check anyway.
    if (!win || event.sender !== win.webContents || !event.senderFrame?.url.startsWith("file://")) throw new Error("Unexpected sender");
    return listener(...args);
  });
}

function registerIpc() {
  handle(CHANNEL.state, () => state());
  handle(CHANNEL.detect, () => detectProviders(true));
  handle(CHANNEL.register, (relay: unknown) => register(typeof relay === "string" ? relay : null));
  handle(CHANNEL.sync, () => syncOnce());
  handle(CHANNEL.startPairing, () => startPairing());
  handle(CHANNEL.stopPairing, () => stopPairing());
  handle(CHANNEL.devices, () => devices());
  handle(CHANNEL.revoke, (id: unknown) => revokeDevice(String(id)));
  handle(CHANNEL.revokeAll, () => revokeAll());
  handle(CHANNEL.autostart, (enabled: unknown) => { try { appAutostart().set(enabled === true); } finally { changed(); } });
  handle(CHANNEL.island, (enabled: unknown) => setIsland(enabled === true));
  handle(CHANNEL.barMode, (mode: unknown) => setBarMode(mode === "remaining" ? "remaining" : "used"));
  handle(CHANNEL.takeOver, () => takeOver());
  handle(CHANNEL.checkUpdate, () => checkUpdate(true));
  handle(CHANNEL.installUpdate, () => installUpdate());
  handle(CHANNEL.automaticUpdates, (enabled: unknown) => { try { setAutomatic(enabled === true); } finally { changed(); } });
  handle(CHANNEL.open, (link: unknown) => {
    if (link === "licenses") return shell.openPath(join(process.resourcesPath, "THIRD_PARTY_NOTICES.txt"));
    const url = LINKS[link as keyof typeof LINKS];
    if (!url) throw new Error("Unknown link");
    return shell.openExternal(url);
  });
  handle(CHANNEL.hide, () => collapse());
  handle(CHANNEL.quit, () => app.quit());
}

// ---- Start -----------------------------------------------------------------------------------------------------

if (process.argv.includes(VERSION_ARG)) {
  // Start check of a staged AppImage (self-update.ts): answer and leave before any window, tray or lock.
  process.stdout.write(`${COMPANION_VERSION}\n`); app.exit(0);
} else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.setName("Meterkat");
  if (process.platform === "win32") app.setAppUserModelId("de.fabian-duerkop.meterkat");
  app.on("second-instance", () => showWindow());
  app.on("before-quit", () => { quitting = true; });
  app.on("will-quit", () => {
    if (!relaunch) return;
    // The new instance must get the lock, or it would hand over to this exiting one and quit.
    app.releaseSingleInstanceLock();
    spawnDetached(relaunch, process.platform, homedir());
  });
  // Closing the window only hides it; the app lives in the tray until Quit.
  app.on("window-all-closed", () => undefined);
  void app.whenReady().then(() => {
    if (process.platform === "linux") process.env.PATH = mergePath(process.env.PATH, loginShellPath());
    Menu.setApplicationMenu(null);
    registerIpc();
    // Autostart starts hidden, and so does an update started from the tray; an unregistered companion always opens its setup.
    const hidden = process.argv.includes(HIDDEN_ARG) || (process.argv.includes(UPDATED_ARG) && settings().relaunchHidden === true);
    createWindow(!hidden || !config());
    // The installer may still be finishing when it starts the app, so its download goes a little later
    // (unless the next update is already on its way).
    setTimeout(() => { if (!prepared && !preparing) cleanUp(install, join(app.getPath("userData"), "updates")); }, 30_000);
    island = createIsland({
      snapshot, enabled: islandEnabled, mode: barMode, demo: process.env.METERKAT_ISLAND_DEMO === "1",
      preload: join(__dirname, "island-preload.cjs"), page: join(__dirname, "island", "island.html"),
    });
    island.start();
    buildTray(state());
    void tick();
  });
}
