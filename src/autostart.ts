import { spawnSync } from "node:child_process";
import { isSea } from "node:sea";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";
import { stateDirectory } from "./state.js";

// Opt-in, user-scoped autostart. Nothing here runs unless the user invokes an autostart command;
// tests inject `exec` and temporary directories so no real OS configuration is touched.
export const UNIT_NAME = "meterkat-companion.service";
export const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RUN_VALUE = "MeterkatCompanion";
// Entries written before the Meterkat rename. `install` replaces managed legacy entries, `remove` deletes them.
export const LEGACY_UNIT_NAME = "ai-usage-companion.service";
export const LEGACY_RUN_VALUE = "AIUsageCompanion";
// Only explicitly selected, non-secret settings are persisted; PATH is rebuilt deliberately below.
const FORWARDED_ENV = ["AI_USAGE_STATE_DIR", "AI_USAGE_CLAUDE_BIN", "AI_USAGE_CODEX_BIN", "AI_USAGE_NAME"] as const;
// Units without this first line (e.g. the operator-managed private pilot unit) are never replaced or removed.
export const MARKER = "# Managed by Meterkat autostart. Reinstall instead of editing.";
export const LEGACY_MARKER = "# Managed by ai-usage autostart. Reinstall instead of editing.";
const NATIVE_TOOLS = ["claude", "codex"];

export type Exec = (command: string, args: string[]) => { status: number | null; stdout: string };
// `scriptPath` is empty for the packaged single-file companion: `nodePath` is then the companion executable itself.
export type Context = { platform: NodeJS.Platform; nodePath: string; scriptPath: string; env: NodeJS.ProcessEnv; home: string; stateDir: string; exec: Exec };
export type Status = { installed: boolean; enabled: boolean; active: boolean | null; location: string; matches: boolean; problems: string[] };

export const realExec: Exec = (command, args) => {
  // argv only, never a shell: paths and values cannot be interpreted as commands.
  const result = spawnSync(command, args, { encoding: "utf8", shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  return { status: result.status, stdout: result.stdout ?? "" };
};
export function defaultContext(): Context {
  return { platform: process.platform, nodePath: process.execPath, scriptPath: isSea() ? "" : process.argv[1] ?? "", env: process.env, home: homedir(), stateDir: resolve(stateDirectory()), exec: realExec };
}
export const LAUNCH_SETTINGS = "autostart.json";

export function checkPath(label: string, value: string, platform: NodeJS.Platform = process.platform) {
  if (!value || !(platform === "win32" ? win32 : posix).isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  // Quotes and control characters cannot be represented safely in a unit file or Run command line.
  if (/["\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} contains unsupported characters`);
}
function checkTarget(ctx: Context) {
  if (!ctx.scriptPath) return checkPath("Companion executable", ctx.nodePath, ctx.platform);
  checkPath("Node executable", ctx.nodePath, ctx.platform); checkPath("Companion bundle", ctx.scriptPath, ctx.platform);
  if (!/\.c?js$/.test(ctx.scriptPath)) throw new Error("Autostart requires the built companion bundle (pnpm build:companion), not the TypeScript sources");
}

// systemd unit quoting: backslash-escape inside double quotes and double `%` specifiers everywhere.
// Only ExecStart= expands `$VAR`, so `$` is doubled there and must stay literal in Environment=.
export function systemdQuote(value: string, context: "exec" | "environment") {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("Value contains control characters");
  const quoted = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${context === "exec" ? quoted.replace(/\$/g, "$$$$") : quoted}"`;
}
export function unitPath(ctx: Pick<Context, "env" | "home">, name = UNIT_NAME) {
  const config = ctx.env.XDG_CONFIG_HOME && isAbsolute(ctx.env.XDG_CONFIG_HOME) ? ctx.env.XDG_CONFIG_HOME : join(ctx.home, ".config");
  return join(config, "systemd", "user", name);
}
// systemd user services do not inherit the login shell PATH. Build one from Node's directory, the configured
// native tool locations and the directories where `claude`/`codex` are currently found, plus system defaults.
export function servicePath(ctx: Context) {
  const directories = [posix.dirname(ctx.nodePath)];
  for (const name of ["AI_USAGE_CLAUDE_BIN", "AI_USAGE_CODEX_BIN"]) { const bin = ctx.env[name]; if (bin && posix.isAbsolute(bin)) directories.push(posix.dirname(bin)); }
  for (const directory of (ctx.env.PATH ?? "").split(":")) {
    if (posix.isAbsolute(directory) && NATIVE_TOOLS.some(tool => existsSync(posix.join(directory, tool)))) directories.push(directory);
  }
  directories.push(posix.join(ctx.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin");
  return [...new Set(directories.map(d => posix.normalize(d)))].filter(d => !d.includes(":")).join(":");
}
export const launcher = (ctx: Pick<Context, "nodePath" | "scriptPath">) => ctx.scriptPath ? [ctx.nodePath, ctx.scriptPath] : [ctx.nodePath];
export function systemdUnit(ctx: Context) {
  checkTarget(ctx);
  const environment = [`PATH=${servicePath(ctx)}`, ...FORWARDED_ENV.filter(name => ctx.env[name]).map(name => `${name}=${name === "AI_USAGE_STATE_DIR" ? ctx.stateDir : ctx.env[name]}`)].map(value => `Environment=${systemdQuote(value, "environment")}`);
  return [
    MARKER, "[Unit]", "Description=Meterkat companion", "Wants=network-online.target", "After=network-online.target", "",
    "[Service]", "Type=simple", `ExecStart=${launcher(ctx).map(part => systemdQuote(part, "exec")).join(" ")} run`, ...environment,
    "Environment=AI_USAGE_SUPERVISOR=systemd", "Restart=on-failure", "RestartSec=60", "UMask=0077", "NoNewPrivileges=yes", "",
    "[Install]", "WantedBy=default.target", "",
  ].join("\n");
}

// Windows: the Run entry starts a short-lived launcher which detaches a hidden `run` process. The sign-in
// environment lacks overrides set only in the installing shell, so allowlisted settings are persisted privately.
export function launchSettingsPath(ctx: Pick<Context, "stateDir">) { return join(ctx.stateDir, LAUNCH_SETTINGS); }
export function windowsCommand(ctx: Context) {
  checkTarget(ctx); const settings = launchSettingsPath(ctx); checkPath("Launch settings", settings, ctx.platform);
  return `${launcher(ctx).map(part => `"${part}"`).join(" ")} background "${settings}"`;
}
export function launchSettings(ctx: Pick<Context, "env" | "stateDir">) {
  // The resolved state directory is always pinned so a later default change cannot redirect the source.
  const settings: Record<string, string> = { AI_USAGE_STATE_DIR: ctx.stateDir };
  for (const name of FORWARDED_ENV) { const value = ctx.env[name]; if (value && name !== "AI_USAGE_STATE_DIR") settings[name] = value; }
  return settings;
}
// Restore persisted settings for `background`; unknown keys are ignored, so the file can never inject other variables.
export function launchEnvironment(file: string, base: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid launch settings");
  const env = { ...base };
  for (const name of FORWARDED_ENV) {
    const value = (parsed as Record<string, unknown>)[name];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new Error("Invalid launch settings");
    if (name === "AI_USAGE_STATE_DIR") checkPath(name, value, platform);
    else if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid launch settings");
    env[name] = value;
  }
  return env;
}

export function install(ctx: Context) {
  if (ctx.platform === "linux") {
    const file = unitPath(ctx); const content = systemdUnit(ctx); const legacy = unitPath(ctx, LEGACY_UNIT_NAME);
    assertManaged(file);
    // An unmanaged legacy unit (e.g. the private pilot) would run a second companion on the same state.
    if (existsSync(legacy) && !isManaged(legacy)) throw new Error(`${LEGACY_UNIT_NAME} exists but is not managed by autostart; remove it before installing ${UNIT_NAME}`);
    if (existsSync(legacy)) removeUnit(ctx, legacy, LEGACY_UNIT_NAME);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`; writeFileSync(temporary, content, { mode: 0o600 }); renameSync(temporary, file);
    run(ctx, "systemctl", ["--user", "daemon-reload"]);
    run(ctx, "systemctl", ["--user", "enable", UNIT_NAME]);
    // restart (not start) so a reinstall after moving Node or the bundle replaces a running old process.
    run(ctx, "systemctl", ["--user", "restart", UNIT_NAME]);
    return `Autostart enabled and companion (re)started with systemd user unit ${file}.`;
  }
  if (ctx.platform === "win32") {
    const command = windowsCommand(ctx); const settings = launchSettingsPath(ctx);
    mkdirSync(ctx.stateDir, { recursive: true, mode: 0o700 });
    const temporary = `${settings}.${process.pid}.tmp`; writeFileSync(temporary, JSON.stringify(launchSettings(ctx)), { mode: 0o600 }); renameSync(temporary, settings);
    run(ctx, "reg.exe", ["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", command, "/f"]);
    if (queryWindows(ctx, LEGACY_RUN_VALUE) !== undefined) run(ctx, "reg.exe", ["delete", RUN_KEY, "/v", LEGACY_RUN_VALUE, "/f"]);
    return "Autostart enabled for this Windows user from next sign-in. A companion already running keeps its previous settings until it is stopped; run the background command to start now.";
  }
  throw new Error(`Autostart is not supported on ${ctx.platform}`);
}

// Removal only touches the autostart entry: relay credentials, pairing and snapshots stay in the state directory.
export function remove(ctx: Context) {
  if (ctx.platform === "linux") {
    const units = [[unitPath(ctx), UNIT_NAME], [unitPath(ctx, LEGACY_UNIT_NAME), LEGACY_UNIT_NAME]] as const;
    // Unmanaged legacy units are left alone; an unmanaged current-name unit still fails loudly.
    const present = units.filter(([file], i) => existsSync(file) && (i === 0 || isManaged(file)));
    if (!present.length) return "Autostart is not installed. Companion state was kept.";
    for (const [file] of present) assertManaged(file);
    for (const [file, name] of present) removeUnit(ctx, file, name);
    return "Autostart removed. Companion state was kept.";
  }
  if (ctx.platform === "win32") {
    for (const name of [RUN_VALUE, LEGACY_RUN_VALUE]) if (queryWindows(ctx, name) !== undefined) run(ctx, "reg.exe", ["delete", RUN_KEY, "/v", name, "/f"]);
    rmSync(launchSettingsPath(ctx), { force: true });
    return "Autostart removed. A companion already running continues until sign-out; companion state was kept.";
  }
  throw new Error(`Autostart is not supported on ${ctx.platform}`);
}

export function status(ctx: Context): Status {
  const problems: string[] = [];
  if (!existsSync(ctx.nodePath)) problems.push(ctx.scriptPath ? "Node executable not found" : "Companion executable not found");
  if (ctx.scriptPath && !existsSync(ctx.scriptPath)) problems.push("Companion bundle not found");
  if (ctx.platform === "linux") {
    const file = unitPath(ctx); const installed = existsSync(file);
    let matches = false;
    try { matches = installed && readFileSync(file, "utf8") === systemdUnit(ctx); } catch { matches = false; }
    if (installed && !isManaged(file)) problems.push("Unit is not managed by Meterkat autostart and will not be changed");
    if (existsSync(unitPath(ctx, LEGACY_UNIT_NAME))) problems.push(`Legacy ${LEGACY_UNIT_NAME} found; rerun autostart install to migrate it`);
    else if (installed && !matches) problems.push("Unit differs from this Node and bundle; rerun autostart install");
    const enabled = ctx.exec("systemctl", ["--user", "is-enabled", UNIT_NAME]).stdout.trim() === "enabled";
    const active = ctx.exec("systemctl", ["--user", "is-active", UNIT_NAME]).stdout.trim() === "active";
    return { installed, enabled, active, location: file, matches, problems };
  }
  if (ctx.platform === "win32") {
    const value = queryWindows(ctx); let matches = false;
    try { matches = value === windowsCommand(ctx); } catch { matches = false; }
    if (value !== undefined && !matches) problems.push("Run entry differs from this Node and bundle; rerun autostart install");
    if (queryWindows(ctx, LEGACY_RUN_VALUE) !== undefined) problems.push(`Legacy Run entry ${LEGACY_RUN_VALUE} found; rerun autostart install to migrate it`);
    return { installed: value !== undefined, enabled: value !== undefined, active: null, location: `${RUN_KEY}\\${RUN_VALUE}`, matches, problems };
  }
  throw new Error(`Autostart is not supported on ${ctx.platform}`);
}

function isManaged(file: string) { const first = safeRead(file).split("\n")[0]; return first === MARKER || first === LEGACY_MARKER; }
function assertManaged(file: string) {
  if (existsSync(file) && !isManaged(file)) throw new Error(`${basename(file)} exists but is not managed by Meterkat autostart; it was left unchanged`);
}
// Keep the unit file if systemd could not disable it, so nothing is left running without a managed unit.
function removeUnit(ctx: Context, file: string, name: string) {
  run(ctx, "systemctl", ["--user", "disable", "--now", name]);
  rmSync(file, { force: true });
  run(ctx, "systemctl", ["--user", "daemon-reload"]);
}
function queryWindows(ctx: Context, name = RUN_VALUE) {
  const result = ctx.exec("reg.exe", ["query", RUN_KEY, "/v", name]);
  if (result.status !== 0) return undefined;
  const line = result.stdout.split(/\r?\n/).find(l => l.trim().startsWith(name + " "));
  return line?.replace(/^\s*\S+\s+REG_SZ\s+/, "").trim();
}
function run(ctx: Context, command: string, args: string[]) {
  const result = ctx.exec(command, args);
  // Report the command name only; arguments may contain local paths the user did not ask to print.
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? "not started"})`);
}

// Detach a hidden `run` process (Windows sign-in). A lock file prevents duplicates across sign-ins.
export function startBackground(stateDir: string, nodePath: string, scriptPath: string, spawnDetached: (log: number) => number | undefined, alive: (pid: number) => boolean, bootedAt: number) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lock = join(stateDir, "companion.pid");
  const previous = Number.parseInt(safeRead(lock), 10);
  // A lock from before the last boot is stale even if its process ID was reused since.
  let lockedAt = 0; try { lockedAt = statSync(lock).mtimeMs; } catch { lockedAt = 0; }
  if (Number.isInteger(previous) && previous > 0 && lockedAt > bootedAt && alive(previous)) return `Companion already running (process ${previous}).`;
  checkPath("Node executable", nodePath); if (scriptPath) checkPath("Companion bundle", scriptPath);
  const logFile = join(stateDir, "companion.log");
  // The log holds status lines only; restart it at sign-in once it exceeds 1 MB.
  let size = 0; try { size = statSync(logFile).size; } catch { size = 0; }
  const log = openSync(logFile, size > 1_000_000 ? "w" : "a", 0o600);
  const pid = spawnDetached(log);
  if (!pid) throw new Error("Companion could not be started");
  writeFileSync(lock, String(pid), { mode: 0o600 });
  return `Companion started in the background (process ${pid}).`;
}
function safeRead(file: string) { try { return readFileSync(file, "utf8"); } catch { return ""; } }
