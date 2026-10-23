#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { getAsset, isSea } from "node:sea";
import { existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import QRCode from "qrcode";
import { captureClaude, type ProviderUsage } from "../shared/snapshot.js";
import { collect } from "./collect.js";
import { defaultContext, install, launchEnvironment, remove, startBackground, status } from "./autostart.js";
import { probeAntigravityUsage } from "./antigravity.js";
import { readState, writeState, removeState, stateDirectory, relayUrl, type Config } from "./state.js";
import { isV2, pairingLinkV2, rotateKey, uploadV2, writerCall } from "./relay-v2.js";
import { COMPANION_VERSION } from "./version.js";
import { automaticUpdates, CHECK_INTERVAL_MS, checkForUpdate, realRunner, recoverInterruptedSwap, rollback, setAutomatic, skipVersion, update, updateSettings } from "./update.js";
import { defaultRelay, registerWithRelay } from "./registration.js";
import { askYesNo, defaultInstallTarget, findExecutable, installExecutable, openFile, setup, type ProviderCheck } from "./setup.js";
import { providerReaders } from "./collect.js";
import { codexCommand } from "./codex.js";
import { antigravityCommand } from "./antigravity.js";
import { confirmDestructive, destructiveArguments, isDestructive, terminalConfirmIo } from "./confirm.js";

async function request(config: Pick<Config, "relay" | "writerToken">, path: string, method: string, value?: unknown) {
  const response = await fetch(`${relayUrl(config.relay)}${path}`, { method, headers: { Authorization: `Bearer ${config.writerToken}`, "Content-Type": "application/json" }, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
  return response.json() as Promise<any>;
}
/** The v2 pairing page holds the permanent source key; remove it once its code has expired. */
function expirePairingPage() {
  const file = join(stateDirectory(), "pairing.html");
  try { if (Date.now() - statSync(file).mtimeMs > 300_000) rmSync(file, { force: true }); } catch { /* no page */ }
}
/** Creates a single-use pairing code and the private local pairing page; v2 links carry the source key. */
async function createPairing(config: Config, pairingRelay: string) {
  // v2 links carry the source key in the fragment; the code alone is not enough to read data.
  const pair = isV2(config) ? await pairingLinkV2(config, pairingRelay) : await request(config, "/v1/pairing", "POST");
  const link = isV2(config) ? (pair as { link: string }).link : `aiusage://pair?relay=${encodeURIComponent(pairingRelay)}&code=${encodeURIComponent(pair.code)}`;
  const safe = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  const manual = isV2(config)
    ? `<p>Scan the QR with the Meterkat app on your own phone. It contains your encryption key: don't share or screenshot it. This page deletes itself after it expires.</p>`
    : `<p><code>${safe(pair.code)}</code></p>`;
  const file = join(stateDirectory(), "pairing.html");
  const qr = await QRCode.toDataURL(link, { width: 320, margin: 2 });
  writeFileSync(file, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pair Meterkat</title><style>body{font:18px system-ui;background:#12151b;color:#f2f4f8;max-width:520px;margin:32px auto;padding:24px}img{border-radius:16px;max-width:100%;height:auto}code{font-size:24px;user-select:all}a{color:#6ea8fe}.open{display:block;background:#6ea8fe;color:#101318;padding:16px;border-radius:12px;text-align:center;text-decoration:none;font-weight:600}</style><h1>Connect your phone</h1><p>Tap the button on your phone, then tap Connect in Meterkat. You can also scan the QR with your phone camera or use the details below.</p><p><a class="open" href="${safe(link)}">Open Meterkat</a></p><img alt="Pairing QR code" src="${qr}">${manual}<p>Relay: ${safe(pairingRelay)}</p><p>Single use · expires in 5 minutes</p></html>`, { mode: 0o600 });
  return { link, file };
}
// Packaged builds are their own launcher (argv[1] repeats the executable); bundles run as `node <bundle>`.
const launcher = () => isSea() ? [] : [process.argv[1] ?? ""];
// Presence comes from PATH (no side effects); readiness from the same native quota read `inspect` uses.
async function detectProviders(probe: boolean): Promise<ProviderCheck[]> {
  const commands: Record<string, () => string | undefined> = {
    claude: () => findExecutable(process.env.AI_USAGE_CLAUDE_BIN ?? "claude"),
    codex: () => { try { const c = codexCommand(); return c.args[0] ?? findExecutable(c.command); } catch { return undefined; } },
    antigravity: () => findExecutable(antigravityCommand().command),
  };
  const ids = [...new Set([...providerReaders.map(r => r.id), ...Object.keys(commands)])];
  return Promise.all(ids.map(async id => {
    const installed = !!commands[id]?.();
    const reader = providerReaders.find(r => r.id === id);
    if (!reader) return { id, installed, ready: null, note: installed ? "found; quota collection is not supported yet" : "not found" };
    if (!installed) return { id, installed, ready: false, note: "not found on PATH (set AI_USAGE_" + id.toUpperCase() + "_BIN if installed elsewhere)" };
    if (!probe) return { id, installed, ready: null, note: "found; sign-in is checked during setup" };
    try { const usage = await reader.read(); return { id, installed, ready: usage.state === "ok", note: usage.state === "ok" ? "signed in, quota readable" : "found, but it reported no quota data; run setup again, and check sign-in if this persists" }; }
    catch (error) { return { id, installed, ready: false, note: error instanceof Error ? error.message : "quota unavailable" }; }
  }));
}
// Automatic updates apply only to packaged builds. The new binary takes over on the next start: systemd
// restarts the unit after the exit below (Restart=on-failure), a Windows sign-in launcher starts a detached replacement.
async function maybeUpdate() {
  if (!isSea() || !automaticUpdates() || Date.now() - (updateSettings().lastCheck ?? 0) < CHECK_INTERVAL_MS) return;
  // Recorded before the request so an unreachable GitHub is retried daily, not on every sync.
  writeState("update.json", { ...updateSettings(), lastCheck: Date.now() });
  try {
    const result = await update(process.execPath, { automatic: true }); console.log(result.message);
    if (result.status !== "updated") return;
    if (process.env.AI_USAGE_SUPERVISOR === "systemd") process.exit(75);
    if (process.env.AI_USAGE_SUPERVISOR === "background") {
      const log = openSync(join(stateDirectory(), "companion.log"), "a", 0o600);
      const child = spawn(process.execPath, ["run"], { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: process.env });
      child.unref(); if (child.pid) writeFileSync(join(stateDirectory(), "companion.pid"), String(child.pid), { mode: 0o600 });
      process.exit(0);
    }
    console.log("Restart the companion to use the new version.");
  } catch { console.error("Update check unavailable; retrying later."); }
}
function autostartContext(executable: string | undefined) {
  const ctx = defaultContext();
  return executable ? { ...ctx, nodePath: executable, scriptPath: "" } : ctx;
}
function spawnSyncSafe(file: string, args: string[]) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function flag(args: string[], name: string) { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; if (!value || value.startsWith("--")) throw new Error(`${name} needs a value`); return value; }
const RELAY_TERMS = "The hosted relay (meterkat-relay.fabian-duerkop.de) is a separate free service under its terms of use: https://meterkat.fabian-duerkop.de/terms";
const USAGE = "Commands: licenses, setup [--relay <origin>] [--dry-run] [--autostart|--no-autostart] [--no-open] [--force], version, update [check|status|enable|disable|rollback] [--prerelease], register <relay> [--v1], capture-claude, inspect, probe-antigravity, pair [phone-relay-origin], once, run, background, revoke [device-id], devices, rotate-key [--yes], delete [--yes], autostart install|remove|status";
async function main() {
  const [command, argument] = process.argv.slice(2);
  if (!command || ["--help", "-h", "help"].includes(command) || process.argv.slice(3).some(a => a === "--help" || a === "-h")) { console.log(USAGE); return; }
  // delete/rotate-key accept only --yes; anything else (a typo, a help flag) is refused before anything runs.
  if (isDestructive(command)) destructiveArguments(command, process.argv.slice(3));
  if (isSea()) { try { recoverInterruptedSwap(process.execPath); } catch { /* best effort; never blocks a command */ } }
  if (command === "version" || command === "--version") { console.log(COMPANION_VERSION); return; }
  if (command === "licenses") {
    // Packaged builds embed the companion's MIT licence and the notices for Node.js and every bundled package (scripts/package.ts).
    console.log(isSea() ? `${getAsset("LICENSE", "utf8").trim()}\n\n${RELAY_TERMS}\n\n# Third-party notices\n\n${getAsset("THIRD_PARTY_NOTICES.txt", "utf8")}` : `The Meterkat companion is open source under the MIT licence (LICENSE).\n${RELAY_TERMS}\nThird-party notices are generated when packaging: pnpm package`); return;
  }
  if (command === "update") {
    const options = process.argv.slice(3); const prerelease = options.includes("--prerelease") || undefined;
    const action = options.find(o => !o.startsWith("--"));
    if (options.some(o => o.startsWith("--") && o !== "--prerelease")) throw new Error("Usage: update [check|status|enable|disable|rollback] [--prerelease]");
    if (action === "enable" || action === "disable") { setAutomatic(action === "enable"); console.log(`Automatic updates ${action}d.`); return; }
    if (action === "status") { const s = updateSettings(); console.log(JSON.stringify({ version: COMPANION_VERSION, packaged: isSea(), automatic: automaticUpdates(), lastCheck: s.lastCheck ? new Date(s.lastCheck).toISOString() : null, skipped: s.skipped ?? null }, null, 2)); return; }
    if (action === "check") { const { release, newer } = await checkForUpdate(undefined, undefined, prerelease); console.log(newer ? `Companion ${release!.version} is available (installed ${COMPANION_VERSION}).` : `Companion ${COMPANION_VERSION} is up to date.`); return; }
    if (!isSea()) throw new Error("Self-update is available for the packaged companion only; rebuild the bundle instead");
    if (action === "rollback") { console.log(rollback(process.execPath)); skipVersion(COMPANION_VERSION); return; }
    if (action) throw new Error("Usage: update [check|status|enable|disable|rollback] [--prerelease]");
    const result = await update(process.execPath, { prerelease }); console.log(result.message);
    if (result.status === "updated") console.log("Restart the companion (or sign out and in) to use the new version.");
    if (result.status === "rolled-back") process.exitCode = 1;
    return;
  }
  if (command === "setup") {
    const args = process.argv.slice(3);
    const known = new Set(["--dry-run", "--relay", "--autostart", "--no-autostart", "--no-open", "--force"]);
    for (const [i, a] of args.entries()) if (!known.has(a) && args[i - 1] !== "--relay") throw new Error(`Unknown setup option ${a}`);
    const sea = isSea();
    await setup({ dryRun: args.includes("--dry-run"), relay: relayUrl(flag(args, "--relay") ?? defaultRelay()), autostart: args.includes("--no-autostart") ? false : args.includes("--autostart") ? true : undefined, open: !args.includes("--no-open"), force: args.includes("--force") }, {
      log: line => console.log(line), confirm: askYesNo, detect: detectProviders,
      installTarget: () => sea ? defaultInstallTarget() : undefined, currentExecutable: () => process.execPath,
      installExecutable: target => installExecutable(process.execPath, target),
      installedVersion: target => { if (!existsSync(target)) return undefined; const r = realRunner(target, ["version"]); return r.status === 0 ? r.stdout.trim() : undefined; },
      registeredRelay: () => readState<Config>("config.json")?.relay,
      // Setup only uses anonymous v2 registration; operator tokens belong to the explicit `register` command.
      registerWithRelay: async relay => { await registerWithRelay(relay, { onProofOfWork: () => console.log("   Registering (proof of work, a few seconds)…") }); },
      autostartEnabled: executable => { const ctx = autostartContext(executable); const s = status(ctx); return s.installed && s.matches; },
      installAutostart: executable => {
        const message = install(autostartContext(executable));
        // Windows autostart applies from the next sign-in; start the installed companion now as well.
        if (process.platform !== "win32" || !executable) return message;
        const started = spawnSyncSafe(executable, ["background"]);
        return started ? `Autostart enabled from next sign-in. ${started}` : message;
      },
      pair: async () => { const config = readState<Config>("config.json"); if (!config) throw new Error("Run register first"); return createPairing(config, config.relay); },
      terminalQr: link => QRCode.toString(link, { type: "terminal", small: true }), openFile,
    });
    return;
  }
  if (command === "capture-claude") {
    // May receive entire status-line input: persist only the allowlisted quota fields.
    const input = readFileSync(0, "utf8");
    if (Buffer.byteLength(input) > 1_000_000) throw new Error("Status input too large");
    const exported = captureClaude(JSON.parse(input), readState<ProviderUsage>("claude.json"));
    // An empty update must not erase the time and value of the last actual observation.
    if (exported?.sampledAt) writeState("claude.json", exported);
    return;
  }
  if (command === "inspect") {
    const snapshot = await collect();
    // Diagnostics report availability only; account usage remains in private runtime state.
    console.log(JSON.stringify(snapshot.providers.map(p => ({ provider: p.id, state: p.state, windows: Object.keys(p.windows), meters: (p.meters ?? []).length, sampleAvailable: p.sampledAt !== null })), null, 2));
    return;
  }
  if (command === "probe-antigravity") {
    // Structure-only capability check for Antigravity; prints no quota values and sends nothing to the relay.
    console.log(JSON.stringify(await probeAntigravityUsage(), null, 2)); return;
  }
  if (command === "register") {
    if (!argument) throw new Error("Provide the relay origin");
    const relay = relayUrl(argument);
    // v1: operator-provisioned pilot. v2: proof of work, or the admin token on a closed self-hosted relay.
    await registerWithRelay(relay, { v1: process.argv.includes("--v1"), adminToken: process.env.RELAY_ADMIN_TOKEN || undefined, onProofOfWork: () => console.log("Registering with the relay (proof of work, a few seconds)…") });
    console.log("Companion registered. Run pair to connect your phone."); return;
  }
  if (command === "autostart") {
    const ctx = defaultContext();
    if (argument === "status") { console.log(JSON.stringify(status(ctx), null, 2)); return; }
    if (argument === "remove") { console.log(remove(ctx)); return; }
    if (argument === "install") {
      // A unit without a registered source would only restart and fail every minute.
      if (!readState<Config>("config.json")) throw new Error("Run register first");
      console.log(install(ctx)); return;
    }
    throw new Error("Usage: autostart install|remove|status");
  }
  if (command === "background") {
    // Settings persisted by `autostart install` replace the sign-in environment's state and tool overrides.
    if (argument) Object.assign(process.env, launchEnvironment(argument, process.env));
    const script = launcher()[0] ?? "";
    console.log(startBackground(stateDirectory(), process.execPath, script, log => {
      const child = spawn(process.execPath, [...launcher(), "run"], { detached: true, stdio: ["ignore", log, log], windowsHide: true, env: { ...process.env, AI_USAGE_SUPERVISOR: "background" } });
      child.unref(); return child.pid;
    }, pid => { try { process.kill(pid, 0); return true; } catch { return false; } }, Date.now() - uptime() * 1000));
    return;
  }
  expirePairingPage();
  const config = readState<Config>("config.json");
  if (!config) throw new Error("Run register first");
  if (command === "pair") {
    // A private pilot may reach its relay over loopback while phones use an HTTPS proxy.
    const pairingRelay = argument ? relayUrl(argument) : config.relay;
    const { file } = await createPairing(config, pairingRelay);
    console.log(`Pairing page saved to ${file} (expires in 5 minutes).`); return;
  }
  if (command === "revoke") {
    if (isV2(config) && argument) { const result = await writerCall(config, `/v2/devices/${encodeURIComponent(argument)}`, "DELETE"); console.log(result.revoked ? "Phone revoked." : "No such phone."); return; }
    await (isV2(config) ? writerCall(config, "/v2/revoke", "POST") : request(config, "/v1/revoke", "POST"));
    console.log("All paired phones revoked."); return;
  }
  if (command === "devices") {
    if (!isV2(config)) throw new Error("Listing phones requires protocol v2");
    console.log(JSON.stringify((await writerCall(config, "/v2/devices", "GET")).devices.map((d: { id: string; pairedAt: number }) => ({ id: d.id, pairedAt: new Date(d.pairedAt).toISOString() })), null, 2)); return;
  }
  if (command === "rotate-key") {
    if (!isV2(config)) throw new Error("Key rotation requires protocol v2");
    await confirmDestructive(command, process.argv.slice(3), terminalConfirmIo());
    removeState("pairing.html");
    await rotateKey(config, next => writeState("config.json", next));
    console.log("Encryption key rotated and all phones revoked. Run pair to connect your phones again."); return;
  }
  if (command === "delete") {
    if (!isV2(config)) throw new Error("Use the operator route to delete protocol v1 sources (docs/relay-lifecycle.md)");
    await confirmDestructive(command, process.argv.slice(3), terminalConfirmIo());
    const result = await writerCall(config, "/v2/source", "DELETE");
    for (const name of ["config.json", "snapshot.json", "pairing.html"]) removeState(name);
    console.log(`Relay source deleted (${result.devices} phone(s) revoked). Local credentials and key removed.`); return;
  }
  if (command === "once" || command === "run") {
    const sync = async () => {
      expirePairingPage();
      const snapshot = await collect();
      await (isV2(config) ? uploadV2(config, snapshot) : request(config, "/v1/snapshot", "PUT", snapshot));
      console.log(`Snapshot sent. ${snapshot.providers.filter(p => p.state === "ok").length}/${snapshot.providers.length} providers have quota data.`);
    };
    if (command === "once") return sync();
    while (true) {
      try { await sync(); } catch { console.error("Sync unavailable; retrying in 60 seconds."); }
      // After an interrupted Windows swap only this still-running instance can put its executable back.
      if (isSea()) { try { if (recoverInterruptedSwap(process.execPath)) console.log("Restored the companion executable after an interrupted update."); } catch { /* retry next round */ } }
      await maybeUpdate();
      await new Promise(resolve => setTimeout(resolve, 60_000));
    }
  }
  throw new Error(USAGE);
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Companion failed"); process.exitCode = 1; });
