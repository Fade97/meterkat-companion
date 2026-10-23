import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { install, launchEnvironment, launchSettingsPath, remove, servicePath, status, startBackground, systemdQuote, MARKER, systemdUnit, unitPath, windowsCommand, RUN_KEY, RUN_VALUE, UNIT_NAME, LEGACY_MARKER, LEGACY_RUN_VALUE, LEGACY_UNIT_NAME, type Context, type Exec } from "../src/autostart.js";

// Every test uses a temporary home and a recording exec: no systemctl, reg.exe or real autostart is touched.
function fixture(t: test.TestContext, platform: NodeJS.Platform, replies: (command: string, args: string[]) => { status: number | null; stdout: string } = () => ({ status: 0, stdout: "" })) {
  const home = mkdtempSync(join(tmpdir(), "ai-usage-autostart-")); t.after(() => rmSync(home, { recursive: true, force: true }));
  const calls: string[][] = [];
  const exec: Exec = (command, args) => { calls.push([command, ...args]); return replies(command, args); };
  const linux = { nodePath: "/opt/node 22/bin/node", scriptPath: "/home/user/My Apps/ai-usage $HOME 100%/ai-usage.cjs" };
  const windows = { nodePath: "C:\\Program Files\\nodejs\\node.exe", scriptPath: "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\ai-usage\\ai-usage.cjs" };
  // An explicitly selected state directory with characters systemd would otherwise expand.
  const stateDir = join(home, "state $HOME 100%");
  const env = { PATH: "/usr/bin:/home/user/.local/bin", AI_USAGE_STATE_DIR: stateDir, RELAY_ADMIN_TOKEN: "admin-secret-value", HOME: home };
  const ctx: Context = { platform, ...(platform === "win32" ? windows : linux), env, home, stateDir, exec };
  return { ctx, calls, home };
}

test("systemd quoting neutralises quotes, backslashes, specifiers and variable expansion", () => {
  assert.equal(systemdQuote('a b"c\\d%e$f', "exec"), '"a b\\"c\\\\d%%e$$f"');
  // Environment= does not expand `$`: doubling it there would point at a different path.
  assert.equal(systemdQuote('a b"c\\d%e$f', "environment"), '"a b\\"c\\\\d%%e$f"');
  assert.throws(() => systemdQuote("line\nbreak", "exec"));
});

test("linux unit runs the bundle via absolute Node, forwards only non-secret settings", t => {
  const { ctx } = fixture(t, "linux");
  const unit = systemdUnit(ctx);
  assert.match(unit, /^ExecStart="\/opt\/node 22\/bin\/node" "\/home\/user\/My Apps\/ai-usage \$\$HOME 100%%\/ai-usage.cjs" run$/m);
  assert.equal(unit.split("\n")[0], MARKER);
  assert.match(unit, /^Environment="PATH=\/opt\/node 22\/bin:/m);
  assert.ok(unit.split("\n").includes(`Environment="AI_USAGE_STATE_DIR=${ctx.stateDir.replace(/\\/g, "\\\\").replace(/%/g, "%%")}"`));
  assert.doesNotMatch(unit, /^Environment=.*\$\$/m);
  assert.doesNotMatch(unit, /RELAY_ADMIN_TOKEN|admin-secret-value|HOME=|AI_USAGE_CLAUDE_BIN/);
  assert.match(unit, /^WantedBy=default.target$/m);
});

test("service PATH is deliberate: Node, configured tools, directories holding claude/codex, system defaults", { skip: process.platform === "win32" && "POSIX PATH discovery" }, t => {
  const { ctx, home } = fixture(t, "linux");
  const tools = join(home, "npm global 100%", "bin"); mkdirSync(tools, { recursive: true }); writeFileSync(join(tools, "codex"), "");
  const unrelated = join(home, "secrets-bin"); mkdirSync(unrelated);
  const env = { ...ctx.env, PATH: [unrelated, tools, "relative/bin", "/usr/bin"].join(":"), AI_USAGE_CLAUDE_BIN: "/srv/claude tools/claude" };
  const path = servicePath({ ...ctx, env }).split(":");
  assert.deepEqual(path, ["/opt/node 22/bin", "/srv/claude tools", tools, join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"]);
  const unit = systemdUnit({ ...ctx, env });
  assert.ok(unit.includes(`${tools.replace(/%/g, "%%")}:`));
  assert.ok(!unit.includes(unrelated));
  assert.match(unit, /^Environment="AI_USAGE_CLAUDE_BIN=\/srv\/claude tools\/claude"$/m);
});

test("state directory is pinned to its resolved path only when explicitly selected", t => {
  const { ctx } = fixture(t, "linux");
  const { AI_USAGE_STATE_DIR: _, ...env } = ctx.env;
  assert.doesNotMatch(systemdUnit({ ...ctx, env }), /AI_USAGE_STATE_DIR/);
  const relative = systemdUnit({ ...ctx, env: { ...ctx.env, AI_USAGE_STATE_DIR: "relative state" } });
  assert.ok(relative.includes(`Environment=${systemdQuote(`AI_USAGE_STATE_DIR=${ctx.stateDir}`, "environment")}`));
  assert.ok(!relative.includes("AI_USAGE_STATE_DIR=relative state"));
});

test("an unmanaged unit with the same name (e.g. the private pilot) is never replaced or removed", t => {
  const { ctx, calls } = fixture(t, "linux");
  const file = unitPath(ctx); mkdirSync(join(file, ".."), { recursive: true });
  const foreign = "[Service]\nExecStart=/usr/bin/node pilot\n"; writeFileSync(file, foreign);
  assert.throws(() => install(ctx), /not managed/);
  assert.throws(() => remove(ctx), /not managed/);
  assert.equal(readFileSync(file, "utf8"), foreign);
  assert.deepEqual(calls.filter(c => c[1] !== "--user" || !c[2]?.startsWith("is-")), []);
  assert.ok(status(ctx).problems.some(p => p.includes("not managed")));
});

test("linux install writes a private user unit and enables it with argv-only systemctl calls", t => {
  const { ctx, calls, home } = fixture(t, "linux");
  install(ctx);
  const file = unitPath(ctx);
  assert.ok(file.startsWith(home));
  assert.equal(readFileSync(file, "utf8"), systemdUnit(ctx));
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);
  // restart replaces a process still running from a previous Node or bundle location.
  assert.deepEqual(calls, [["systemctl", "--user", "daemon-reload"], ["systemctl", "--user", "enable", UNIT_NAME], ["systemctl", "--user", "restart", UNIT_NAME]]);
});

test("linux status reports enabled, active and drift after Node moves", t => {
  const { ctx } = fixture(t, "linux", (_c, args) => ({ status: 0, stdout: args[1] === "is-enabled" ? "enabled\n" : "active\n" }));
  install(ctx);
  const current = status(ctx);
  assert.equal(current.installed, true); assert.equal(current.enabled, true); assert.equal(current.active, true); assert.equal(current.matches, true);
  const moved = status({ ...ctx, nodePath: "/opt/node 24/bin/node" });
  assert.equal(moved.matches, false);
  assert.ok(moved.problems.some(p => p.includes("rerun autostart install")));
});

test("linux remove deletes only the unit and keeps pairing and source state", t => {
  const { ctx, calls } = fixture(t, "linux");
  const state = ctx.env.AI_USAGE_STATE_DIR!; mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "config.json"), "{}"); writeFileSync(join(state, "claude.json"), "{}");
  install(ctx); calls.length = 0;
  remove(ctx);
  assert.equal(existsSync(unitPath(ctx)), false);
  assert.ok(existsSync(join(state, "config.json")) && existsSync(join(state, "claude.json")));
  assert.deepEqual(calls, [["systemctl", "--user", "disable", "--now", UNIT_NAME], ["systemctl", "--user", "daemon-reload"]]);
  calls.length = 0;
  assert.match(remove(ctx), /not installed/);
  assert.deepEqual(calls, []);
});

test("linux remove keeps the unit when systemd cannot disable it", t => {
  let fail = false;
  const { ctx } = fixture(t, "linux", () => ({ status: fail ? 1 : 0, stdout: "" }));
  install(ctx); fail = true;
  assert.throws(() => remove(ctx), /systemctl failed/);
  assert.ok(existsSync(unitPath(ctx)));
});

test("install refuses TypeScript sources, relative and quote-containing paths", t => {
  const { ctx } = fixture(t, "linux");
  assert.throws(() => install({ ...ctx, scriptPath: "/repo/companion/cli.ts" }), /bundle/);
  assert.throws(() => install({ ...ctx, nodePath: "node" }), /absolute/);
  assert.throws(() => install({ ...ctx, scriptPath: '/tmp/a"b.cjs' }), /unsupported/);
  assert.throws(() => install({ ...ctx, platform: "darwin" }), /not supported/);
});

test("windows install registers a quoted HKCU Run command through reg.exe argv", t => {
  const { ctx, calls } = fixture(t, "win32");
  const command = windowsCommand(ctx);
  assert.equal(command, `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\ai-usage\\ai-usage.cjs" background "${launchSettingsPath(ctx)}"`);
  install(ctx);
  assert.deepEqual(calls, [["reg.exe", "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", command, "/f"], ["reg.exe", "query", RUN_KEY, "/v", LEGACY_RUN_VALUE]]);
  assert.doesNotMatch(readFileSync(launchSettingsPath(ctx), "utf8"), /admin-secret-value|RELAY_ADMIN_TOKEN|PATH/);
  assert.ok(!calls.flat().some(a => a.includes("admin-secret-value")));
});

test("windows sign-in restores the selected state directory and tool overrides from a fresh environment", t => {
  const { ctx } = fixture(t, "win32");
  const env = { ...ctx.env, AI_USAGE_CODEX_BIN: "C:\\Tools 100%\\codex.cmd" };
  install({ ...ctx, env });
  const fresh = { PATH: "C:\\Windows\\System32", LOCALAPPDATA: "C:\\Users\\Jane Doe\\AppData\\Local" };
  const restored = launchEnvironment(launchSettingsPath(ctx), fresh, "win32");
  assert.equal(restored.AI_USAGE_STATE_DIR, ctx.stateDir);
  assert.equal(restored.AI_USAGE_CODEX_BIN, "C:\\Tools 100%\\codex.cmd");
  assert.equal(restored.PATH, fresh.PATH);
  assert.equal(restored.RELAY_ADMIN_TOKEN, undefined);
  // Unknown keys in the settings file are ignored; malformed values are rejected.
  writeFileSync(launchSettingsPath(ctx), JSON.stringify({ AI_USAGE_STATE_DIR: ctx.stateDir, NODE_OPTIONS: "--require evil" }));
  assert.equal(launchEnvironment(launchSettingsPath(ctx), fresh, "win32").NODE_OPTIONS, undefined);
  writeFileSync(launchSettingsPath(ctx), JSON.stringify({ AI_USAGE_STATE_DIR: "relative" }));
  assert.throws(() => launchEnvironment(launchSettingsPath(ctx), fresh, "win32"), /absolute/);
});

test("windows status parses reg query output and remove keeps state", t => {
  let registered = true;
  const { ctx, calls } = fixture(t, "win32", (_c, args) => args[0] === "query"
    ? (registered ? { status: 0, stdout: `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    ${RUN_VALUE}    REG_SZ    ${windowsCommand(ctx)}\r\n\r\n` } : { status: 1, stdout: "" })
    : { status: 0, stdout: "" });
  const current = status(ctx);
  assert.equal(current.installed, true); assert.equal(current.matches, true); assert.equal(current.active, null);
  mkdirSync(ctx.stateDir, { recursive: true }); writeFileSync(join(ctx.stateDir, "config.json"), "{}"); writeFileSync(launchSettingsPath(ctx), "{}");
  remove(ctx);
  assert.deepEqual(calls.filter(c => c[1] === "delete"), [["reg.exe", "delete", RUN_KEY, "/v", RUN_VALUE, "/f"]]);
  assert.ok(existsSync(join(ctx.stateDir, "config.json")));
  assert.equal(existsSync(launchSettingsPath(ctx)), false);
  registered = false; calls.length = 0;
  remove(ctx);
  assert.deepEqual(calls, [["reg.exe", "query", RUN_KEY, "/v", RUN_VALUE], ["reg.exe", "query", RUN_KEY, "/v", LEGACY_RUN_VALUE]]);
  assert.equal(status(ctx).installed, false);
});

test("failed OS commands surface without echoing arguments", t => {
  const { ctx } = fixture(t, "linux", () => ({ status: 1, stdout: "" }));
  assert.throws(() => install(ctx), (error: Error) => error.message === "systemctl failed (1)");
});

test("background launcher starts once per boot and ignores stale locks", t => {
  const { home } = fixture(t, "linux");
  const state = join(home, "state"); const node = process.execPath; const script = join(home, "ai-usage.cjs");
  let spawned = 0; const spawn = () => { spawned += 1; return 4242; };
  startBackground(state, node, script, spawn, () => true, Date.now() - 60_000);
  assert.equal(spawned, 1);
  assert.equal(readFileSync(join(state, "companion.pid"), "utf8"), "4242");
  assert.match(startBackground(state, node, script, spawn, () => true, Date.now() - 60_000), /already running/);
  assert.equal(spawned, 1);
  // After a reboot the old process ID may belong to something else.
  const old = new Date(Date.now() - 3_600_000); utimesSync(join(state, "companion.pid"), old, old);
  startBackground(state, node, script, spawn, () => true, Date.now() - 60_000);
  assert.equal(spawned, 2);
  startBackground(state, node, script, spawn, () => false, Date.now() - 60_000);
  assert.equal(spawned, 3);
});

test("packaged single-file companion is its own launcher on both platforms", t => {
  const linux = fixture(t, "linux").ctx;
  const unit = systemdUnit({ ...linux, nodePath: "/home/user/.local/bin/meterkat", scriptPath: "" });
  assert.match(unit, /^ExecStart="\/home\/user\/.local\/bin\/meterkat" run$/m);
  assert.match(unit, /^Environment=AI_USAGE_SUPERVISOR=systemd$/m);
  const windows = fixture(t, "win32").ctx;
  const exe = "C:\\Users\\Jane Doe\\AppData\\Local\\Programs\\Meterkat\\meterkat.exe";
  assert.equal(windowsCommand({ ...windows, nodePath: exe, scriptPath: "" }), `"${exe}" background "${launchSettingsPath(windows)}"`);
  assert.throws(() => systemdUnit({ ...linux, nodePath: "meterkat", scriptPath: "" }), /absolute/);
});

test("linux install migrates a managed pre-rename unit and refuses beside an unmanaged one", t => {
  const { ctx, calls } = fixture(t, "linux");
  const legacy = unitPath(ctx, LEGACY_UNIT_NAME); mkdirSync(join(legacy, ".."), { recursive: true });
  writeFileSync(legacy, `${LEGACY_MARKER}\n[Unit]\n`);
  assert.ok(status(ctx).problems.some(p => p.includes(LEGACY_UNIT_NAME)));
  calls.length = 0; install(ctx);
  assert.equal(existsSync(legacy), false); assert.ok(existsSync(unitPath(ctx)));
  assert.deepEqual(calls.slice(0, 2), [["systemctl", "--user", "disable", "--now", LEGACY_UNIT_NAME], ["systemctl", "--user", "daemon-reload"]]);
  // An operator-managed legacy unit (private pilot) is never touched and blocks a second companion.
  writeFileSync(legacy, "[Unit]\nDescription=pilot\n"); calls.length = 0;
  assert.throws(() => install(ctx), /not managed/);
  remove(ctx);
  assert.ok(existsSync(legacy)); assert.equal(existsSync(unitPath(ctx)), false);
  assert.ok(!calls.flat().includes(LEGACY_UNIT_NAME));
});

test("windows install replaces the pre-rename Run entry", t => {
  const { ctx, calls } = fixture(t, "win32", (_c, args) => args[0] === "query" && args[3] === LEGACY_RUN_VALUE
    ? { status: 0, stdout: `\r\n    ${LEGACY_RUN_VALUE}    REG_SZ    "node.exe" "ai-usage.cjs" background\r\n` } : { status: 0, stdout: "" });
  assert.ok(status(ctx).problems.some(p => p.includes(LEGACY_RUN_VALUE)));
  calls.length = 0; install(ctx);
  assert.deepEqual(calls.at(-1), ["reg.exe", "delete", RUN_KEY, "/v", LEGACY_RUN_VALUE, "/f"]);
  assert.equal(calls.filter(c => c[1] === "delete" && c[4] === RUN_VALUE).length, 0);
});
