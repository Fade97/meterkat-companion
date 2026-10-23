import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { COMPANION_VERSION } from "./version.js";
import { compareVersions, parseVersion, sidePaths, swapExecutable } from "./update.js";

// Guided first-run setup. Every step that changes the machine is listed, and in --dry-run only
// listed: no files, no relay calls, no provider probes. Effects are injected so the flow is testable.
export type ProviderCheck = { id: string; installed: boolean; ready: boolean | null; note: string };
export type SetupOptions = { dryRun: boolean; relay?: string; autostart?: boolean; open: boolean; force?: boolean };
export type SetupDeps = {
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
  detect: (probe: boolean) => Promise<ProviderCheck[]>;
  /** Stable install location of the packaged executable, or undefined when running from a bundle or sources. */
  installTarget: () => string | undefined;
  currentExecutable: () => string;
  installExecutable: (target: string) => void;
  /** Version reported by an already installed copy, if any. */
  installedVersion: (target: string) => string | undefined;
  registeredRelay: () => string | undefined;
  registerWithRelay: (relay: string) => Promise<void>;
  autostartEnabled: (executable: string | undefined) => boolean;
  installAutostart: (executable: string | undefined) => string;
  pair: () => Promise<{ link: string; file: string }>;
  terminalQr: (link: string) => Promise<string>;
  openFile: (file: string) => boolean;
};

export async function setup(options: SetupOptions, deps: SetupDeps) {
  const { log } = deps; const dry = options.dryRun;
  log(`Meterkat companion ${COMPANION_VERSION} setup${dry ? " (dry run: nothing is changed)" : ""}`);
  const relay = deps.registeredRelay();
  if (!relay && !options.relay) throw new Error("Not registered yet: run setup --relay https://<relay-origin>");

  log("\n1. AI tools on this computer");
  const providers = await deps.detect(!dry);
  for (const p of providers) log(`   ${p.ready ? "✓" : p.installed ? "•" : "✗"} ${p.id}: ${p.note}`);
  if (!providers.some(p => p.installed)) log("   No supported AI tool found. Install and sign in to Claude Code or Codex, then run setup again.");

  log("\n2. Companion program");
  const target = deps.installTarget(); let executable: string | undefined;
  if (!target) log("   Running from a bundle or sources; using it in place.");
  else if (resolve(target) === resolve(deps.currentExecutable())) { executable = target; log(`   Installed at ${target}`); }
  else {
    executable = target;
    const installed = deps.installedVersion(target);
    // Never replace a newer installed copy (e.g. one that already updated itself) with an older download.
    if (installed && parseVersion(installed) && compareVersions(installed, COMPANION_VERSION) > 0 && !options.force) log(`   Keeping the newer installed ${installed} at ${target} (use --force to replace it with ${COMPANION_VERSION}).`);
    else if (dry) log(`   Would install to ${target}`);
    else { deps.installExecutable(target); log(`   Installed to ${target}`); }
  }

  log("\n3. Relay registration");
  if (relay) log(`   Already registered with ${relay}`);
  else if (dry) log(`   Would register with ${options.relay} (anonymous, proof of work; end-to-end encryption key stays on this computer)`);
  else { await deps.registerWithRelay(options.relay!); log(`   Registered with ${options.relay}`); }

  log("\n4. Start automatically at sign-in (optional)");
  if (options.autostart === false) log("   Skipped (--no-autostart).");
  else if (!dry && deps.autostartEnabled(executable)) log("   Already enabled.");
  else if (dry) log(`   Would ${options.autostart ? "enable autostart" : "ask before enabling autostart"}`);
  else if (options.autostart || await deps.confirm("   Start the companion automatically when you sign in? [y/N] ")) log(`   ${deps.installAutostart(executable)}`);
  else log(`   Not enabled. Start it yourself with: ${executable ? `"${executable}"` : "meterkat"} run`);

  log("\n5. Connect your phone");
  if (dry) { log("   Would create a single-use pairing code, show it as a QR code here and open the pairing page."); return; }
  const { link, file } = await deps.pair();
  log(await deps.terminalQr(link));
  log("   Scan with the Meterkat app on your own phone. The code contains your encryption key: don't share or screenshot it.");
  log(`   The same QR is on ${file}; it deletes itself after it expires.`);
  if (options.open && deps.openFile(file)) log("   Pairing page opened in your browser (expires in 5 minutes).");
}

export function defaultInstallTarget(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = homedir()) {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Programs", "Meterkat", "meterkat.exe");
  return join(home, ".local", "bin", "meterkat");
}

/** Copies the running executable to `target`; an existing (possibly running) copy is swapped, never overwritten in place. */
export function installExecutable(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  const { staged } = sidePaths(target);
  rmSync(staged, { force: true }); copyFileSync(source, staged, constants.COPYFILE_EXCL);
  if (!existsSync(target)) { renameSync(staged, target); return; }
  if (swapExecutable(target, staged, COMPANION_VERSION) !== "updated") throw new Error("Installed copy failed its start check; the previous one was kept");
}

export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform) {
  if (isAbsolute(name)) return existsSync(name) ? name : undefined;
  const extensions = platform === "win32" ? ["", ".exe", ".cmd"] : [""];
  for (const directory of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) { const file = join(directory, name + extension); if (existsSync(file)) return file; }
  }
  return undefined;
}

export async function askYesNo(question: string) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

export function openFile(file: string) {
  // argv only: the path is never interpreted by a shell.
  const [command, args] = process.platform === "win32" ? ["explorer.exe", [file]] : process.platform === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  try { const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }); child.on("error", () => undefined); child.unref(); return !!child.pid; } catch { return false; }
}
