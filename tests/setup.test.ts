import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { defaultInstallTarget, setup, type SetupDeps } from "../src/setup.js";
import { defaultStateDirectory } from "../src/state.js";

// Every effect is a recorded fake: setup never touches the real machine, relay or providers here.
function deps(overrides: Partial<SetupDeps> = {}) {
  const calls: string[] = []; const lines: string[] = [];
  const record = (name: string) => (..._args: unknown[]) => { calls.push(name); };
  const base: SetupDeps = {
    log: line => lines.push(line),
    confirm: async () => { calls.push("confirm"); return false; },
    detect: async probe => { calls.push(`detect:${probe}`); return [{ id: "claude", installed: true, ready: probe ? true : null, note: "found" }, { id: "codex", installed: false, ready: false, note: "not found" }]; },
    installTarget: () => "/home/u/.local/bin/meterkat", currentExecutable: () => "/home/u/Downloads/meterkat-companion-1.0.0-linux-x64",
    installExecutable: record("installExecutable"), installedVersion: () => undefined, registeredRelay: () => undefined,
    registerWithRelay: async relay => { calls.push(`register:${relay}`); },
    autostartEnabled: () => false, installAutostart: executable => { calls.push(`autostart:${executable}`); return "enabled"; },
    pair: async () => { calls.push("pair"); return { link: "aiusage://pair?code=x", file: "/state/pairing.html" }; },
    terminalQr: async () => "[qr]", openFile: file => { calls.push(`open:${file}`); return true; },
  };
  return { deps: { ...base, ...overrides }, calls, lines };
}

test("setup --dry-run only describes the plan: no probes, writes, relay calls or prompts", async () => {
  const { deps: d, calls, lines } = deps();
  await setup({ dryRun: true, relay: "https://meterkat-relay.fabian-duerkop.de", open: true }, d);
  assert.deepEqual(calls, ["detect:false"]);
  const text = lines.join("\n");
  assert.match(text, /Would install to \/home\/u\/.local\/bin\/meterkat/);
  assert.match(text, /Would register with https:\/\/meterkat-relay\.fabian-duerkop\.de \(anonymous, proof of work/);
  assert.match(text, /Would ask before enabling autostart/);
});

test("setup installs, registers and pairs, but enables autostart only with consent", async () => {
  const declined = deps();
  await setup({ dryRun: false, relay: "https://relay.example", open: true }, declined.deps);
  assert.deepEqual(declined.calls, ["detect:true", "installExecutable", "register:https://relay.example", "confirm", "pair", "open:/state/pairing.html"]);
  assert.ok(declined.lines.includes("[qr]"));
  const accepted = deps({ confirm: async () => true });
  await setup({ dryRun: false, relay: "https://relay.example", open: false }, accepted.deps);
  assert.ok(accepted.calls.includes("autostart:/home/u/.local/bin/meterkat"));
  assert.ok(!accepted.calls.some(c => c.startsWith("open:")));
});

test("setup reuses an existing registration and installation and honours --no-autostart", async () => {
  const { deps: d, calls } = deps({ registeredRelay: () => "https://relay.example", currentExecutable: () => "/home/u/.local/bin/meterkat" });
  await setup({ dryRun: false, autostart: false, open: true, relay: "https://other.example" }, d);
  assert.deepEqual(calls, ["detect:true", "pair", "open:/state/pairing.html"]);
});

test("unpackaged runs (bundle or sources) are used in place and autostart keeps the Node launcher", async () => {
  const { deps: d, calls } = deps({ installTarget: () => undefined });
  await setup({ dryRun: false, autostart: true, relay: "https://relay.example", open: false }, d);
  assert.ok(!calls.includes("installExecutable")); assert.ok(calls.includes("autostart:undefined"));
});

test("install locations and state directory keep pre-rename installations working", () => {
  assert.equal(defaultInstallTarget("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\U"), join("C:\\L", "Programs", "Meterkat", "meterkat.exe"));
  assert.equal(defaultInstallTarget("linux", {}, "/home/u"), join("/home/u", ".local", "bin", "meterkat"));
  const base = join("/home/u", ".local", "state");
  assert.equal(defaultStateDirectory({}, "/home/u", () => false), join(base, "meterkat"));
  assert.equal(defaultStateDirectory({}, "/home/u", p => p === join(base, "ai-usage")), join(base, "ai-usage"));
  assert.equal(defaultStateDirectory({}, "/home/u", () => true), join(base, "meterkat"));
});

test("setup never downgrades a newer installed copy unless forced", async () => {
  const newer = deps({ installedVersion: () => "99.0.0" });
  await setup({ dryRun: false, relay: "https://relay.example", autostart: false, open: false }, newer.deps);
  assert.ok(!newer.calls.includes("installExecutable"));
  assert.ok(newer.lines.some(l => l.includes("Keeping the newer installed 99.0.0")));
  const forced = deps({ installedVersion: () => "99.0.0" });
  await setup({ dryRun: false, relay: "https://relay.example", autostart: false, open: false, force: true }, forced.deps);
  assert.ok(forced.calls.includes("installExecutable"));
  const older = deps({ installedVersion: () => "0.0.0-alpha" });
  await setup({ dryRun: false, relay: "https://relay.example", autostart: false, open: false }, older.deps);
  assert.ok(older.calls.includes("installExecutable"));
});

test("registration uses anonymous v2 proof of work and never sends the admin token to a hosted relay", async t => {
  const { mkdtempSync, rmSync } = await import("node:fs"); const { tmpdir } = await import("node:os");
  const state = mkdtempSync(join(tmpdir(), "meterkat-register-")); t.after(() => rmSync(state, { recursive: true, force: true }));
  const previous = process.env.AI_USAGE_STATE_DIR; process.env.AI_USAGE_STATE_DIR = state;
  t.after(() => { if (previous === undefined) delete process.env.AI_USAGE_STATE_DIR; else process.env.AI_USAGE_STATE_DIR = previous; });
  const { registerWithRelay, HOSTED_RELAY, STAGING_RELAY, defaultRelay } = await import("../src/registration.js");
  const seen: { url: string; auth: string | null }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); const auth = new Headers(init?.headers).get("authorization"); seen.push({ url, auth });
    if (url.endsWith("/v2/challenge")) return Response.json({ challenge: "c", bits: 1 });
    if (url.endsWith("/v2/sources")) return Response.json({ sourceId: "src.mac", writerToken: "w" }, { status: 201 });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });
  for (const relay of [HOSTED_RELAY, STAGING_RELAY]) {
    seen.length = 0;
    const config = await registerWithRelay(relay, { adminToken: "admin-secret" });
    assert.equal((config as { protocol?: number }).protocol, 2);
    assert.deepEqual(seen.map(s => s.url), [`${relay}/v2/challenge`, `${relay}/v2/sources`]);
    assert.ok(seen.every(s => s.auth === null));
  }
  // A closed self-hosted relay still accepts the operator token explicitly passed by `register`.
  seen.length = 0; await registerWithRelay("https://relay.example", { adminToken: "admin-secret" });
  assert.deepEqual(seen, [{ url: "https://relay.example/v2/sources", auth: "Bearer admin-secret" }]);
  assert.equal(defaultRelay({}), HOSTED_RELAY);
  assert.equal(defaultRelay({ AI_USAGE_RELAY: STAGING_RELAY }), STAGING_RELAY);
});
