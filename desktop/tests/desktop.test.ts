import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderUsage, Snapshot } from "../../shared/snapshot.js";
import { ago, bars, duration, providerColor, providerGroups, resetText, trayLines } from "../src/format.js";
import { autostartFile, desktopEntry, execLine, launchCommand, linuxAutostart } from "../src/login-item.js";
import { backgroundPid, cliServiceRunning, unitStateDirectory } from "../src/service.js";
import { loginShellPath, mergePath } from "../src/shell-path.js";

const now = 1_800_000_000_000;
const claude: ProviderUsage = { id: "claude", state: "ok", sampledAt: now, windows: { fiveHour: { usedPercent: 42.4, resetsAt: now + 3_600_000 }, weekly: { usedPercent: 81, resetsAt: now + 5 * 86_400_000 } } };
const antigravity: ProviderUsage = { id: "antigravity", state: "unavailable", sampledAt: now - 60_000, windows: {}, meters: [{ id: "gemini", label: "Gemini Pro", usedPercent: 10, resetsAt: now + 1000 }] };

test("bars list windows first, then quota buckets", () => {
  assert.deepEqual(bars(claude).map(b => b.label), ["5-hour", "Weekly"]);
  assert.deepEqual(bars(antigravity).map(b => [b.label, b.usedPercent]), [["Gemini Pro", 10]]);
});

test("durations and relative times", () => {
  assert.equal(duration(45 * 60_000), "45 min");
  assert.equal(duration(192 * 60_000), "3 h 12 min");
  assert.equal(duration(52 * 3_600_000), "2 d 4 h");
  assert.equal(duration(-5), "0 min");
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 120_000, now), "2 min ago");
  assert.equal(resetText(now - 1, now), "reset due");
  assert.equal(resetText(now + 3_600_000, now), "resets in 1 h");
});

test("tray lines show the highest used share and stale or sign-in states", () => {
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [claude, antigravity, { id: "codex", state: "auth_required", sampledAt: null, windows: {} }] };
  assert.deepEqual(trayLines(snapshot), ["Claude: 81% used", "Antigravity: 10% used (stale)", "Codex: sign-in needed"]);
  assert.deepEqual(trayLines(null), []);
});

test("providers that never reported quota are grouped as not set up", () => {
  const codexMissing: ProviderUsage = { id: "codex", state: "unavailable", sampledAt: null, windows: {} };
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [claude, codexMissing] };
  const groups = providerGroups(snapshot);
  assert.deepEqual(groups.shown.map(p => p.id), ["claude"]);
  // Antigravity is optional and absent from the snapshot until it reports data.
  assert.deepEqual(groups.notSetUp, ["codex", "antigravity"]);
  // Stale data and sign-in needed stay cards.
  const signIn: ProviderUsage = { id: "codex", state: "auth_required", sampledAt: null, windows: {} };
  assert.deepEqual(providerGroups({ ...snapshot, providers: [claude, antigravity, signIn] }), { shown: [claude, antigravity, signIn], notSetUp: [] });
  assert.deepEqual(providerGroups(null), { shown: [], notSetUp: [] });
  assert.deepEqual(trayLines(snapshot), ["Claude: 81% used", "Codex: not set up", "Antigravity: not set up"]);
});

test("bars use the provider colours from the Android app", () => {
  assert.deepEqual(["claude", "codex", "antigravity", "other"].map(providerColor), ["#D97757", "#6EA8FE", "#34C77B", "#94A3B8"]);
});

test("login command points at the AppImage, the packaged executable or Electron with the app folder", () => {
  assert.deepEqual(launchCommand({ APPIMAGE: "/home/u/Meterkat.AppImage" }, "/tmp/.mount_x/meterkat", true, "/app"), ["/home/u/Meterkat.AppImage", "--hidden"]);
  assert.deepEqual(launchCommand({}, "C:\\Meterkat\\Meterkat.exe", true, "/app"), ["C:\\Meterkat\\Meterkat.exe", "--hidden"]);
  assert.deepEqual(launchCommand({}, "/usr/bin/electron", false, "/src/desktop"), ["/usr/bin/electron", "/src/desktop", "--hidden"]);
});

test("desktop entry quotes and escapes every argument", () => {
  assert.equal(execLine(["/home/a b/Meter$kat \"x\" 100%.AppImage", "--hidden"]), '"/home/a b/Meter\\$kat \\"x\\" 100%%.AppImage" "--hidden"');
  assert.throws(() => execLine(["/bad\npath"]));
  assert.match(desktopEntry(["/x"]), /^Exec="\/x"$/m);
  assert.equal(autostartFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/u"), join("/cfg", "autostart", "meterkat-desktop.desktop"));
  assert.equal(autostartFile({ XDG_CONFIG_HOME: "relative" }, "/home/u"), join("/home/u", ".config", "autostart", "meterkat-desktop.desktop"));
});

test("Linux autostart only removes its own entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-autostart-"));
  const file = join(dir, "autostart", "meterkat-desktop.desktop");
  const entry = linuxAutostart(file);
  assert.equal(entry.enabled(), false);
  entry.set(true, ["/x/Meterkat.AppImage", "--hidden"]);
  assert.equal(entry.enabled(), true);
  entry.set(false, []);
  assert.equal(existsSync(file), false);
  writeFileSync(file, "[Desktop Entry]\nExec=/someone/else\n");
  entry.set(false, []);
  assert.equal(readFileSync(file, "utf8"), "[Desktop Entry]\nExec=/someone/else\n");
});

test("a CLI service counts only when it is active for the same state directory", () => {
  const exec = (state: string, active = "active") => (_: string, args: string[]) => ({ status: 0, stdout: args.includes("is-active") ? active : `PATH=/bin AI_USAGE_STATE_DIR=${state} AI_USAGE_SUPERVISOR=systemd` });
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/meterkat")), true);
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/other")), false);
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/meterkat", "inactive")), false);
  assert.equal(unitStateDirectory('PATH=/bin "AI_USAGE_STATE_DIR=/a b/state" X=1'), "/a b/state");
});

test("the Windows background process counts only with a lock from this boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-service-"));
  writeFileSync(join(dir, "companion.pid"), "4242");
  assert.equal(backgroundPid(dir, 0), 4242);
  assert.equal(backgroundPid(dir, Date.now() + 60_000), undefined);
  assert.equal(cliServiceRunning(dir, "win32", undefined, pid => pid === 4242, 0), true);
  assert.equal(cliServiceRunning(dir, "win32", undefined, () => false, 0), false);
});

test("login shell PATH is read between markers and merged after the current one", () => {
  const run = (_: string, args: string[]) => ({ status: 0, stdout: `motd noise\n__METERKAT_PATH__/home/u/.local/bin:/usr/bin__METERKAT_PATH__${args.length}` });
  assert.equal(loginShellPath({ SHELL: "/bin/zsh" }, run), "/home/u/.local/bin:/usr/bin");
  assert.equal(loginShellPath({ SHELL: "zsh" }, run), undefined);
  assert.equal(loginShellPath({}, run), undefined);
  if (process.platform !== "win32") assert.equal(mergePath("/usr/bin:/bin", "/home/u/.local/bin:/usr/bin:relative"), "/usr/bin:/bin:/home/u/.local/bin");
});
