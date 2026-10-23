import { readFileSync, statSync } from "node:fs";
import { uptime } from "node:os";
import { join, resolve } from "node:path";
import { LEGACY_UNIT_NAME, UNIT_NAME, realExec, type Exec } from "../../src/autostart.js";
import { defaultStateDirectory } from "../../src/state.js";

// Whether a CLI companion is already syncing this state directory: an active systemd user unit for the same
// directory on Linux, the detached `background` process (companion.pid, written by startBackground) on Windows.
export function cliServiceRunning(stateDir: string, platform: NodeJS.Platform = process.platform, exec: Exec = realExec, alive = processAlive, bootedAt = Date.now() - uptime() * 1000) {
  if (platform === "linux") {
    return [UNIT_NAME, LEGACY_UNIT_NAME].some(unit => {
      if (exec("systemctl", ["--user", "is-active", unit]).stdout.trim() !== "active") return false;
      const environment = exec("systemctl", ["--user", "show", "--property=Environment", "--value", unit]).stdout;
      return resolve(unitStateDirectory(environment)) === resolve(stateDir);
    });
  }
  if (platform === "win32") {
    const pid = backgroundPid(stateDir, bootedAt);
    return pid !== undefined && alive(pid);
  }
  return false;
}

/** The recorded background process, if its lock is from this boot (a PID from before a reboot may be reused). */
export function backgroundPid(stateDir: string, bootedAt: number) {
  const lock = join(stateDir, "companion.pid");
  try {
    if (statSync(lock).mtimeMs <= bootedAt) return undefined;
    const pid = Number.parseInt(readFileSync(lock, "utf8"), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch { return undefined; }
}

/** EPERM: the process exists but belongs to another session or integrity level. */
export function processAlive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } }

/** The state directory a unit runs with: its AI_USAGE_STATE_DIR, otherwise the default for this user. */
export function unitStateDirectory(environment: string) {
  const match = /(?:^|\s)"AI_USAGE_STATE_DIR=([^"]*)"/.exec(environment) ?? /(?:^|\s)AI_USAGE_STATE_DIR=(\S+)/.exec(environment);
  if (match) return match[1]!;
  const { AI_USAGE_STATE_DIR: _ignored, ...env } = process.env;
  return defaultStateDirectory(env);
}
