import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backoffMs, childEnvironment, describeShape, fromAntigravityUsage, looksLikeAuthPrompt, parseVersion, probeAntigravityUsage, readAntigravityUsage, supportsPrintUsage } from "../src/antigravity.js";
import { collect, providerReaders } from "../src/collect.js";
import { parseSnapshot, type ProviderUsage } from "../shared/snapshot.js";

const stub = join(import.meta.dirname, "fixtures", "antigravity-stub.js");
async function withStub<T>(env: Record<string, string>, body: (log: string, directory: string) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "agy-stub-")); const log = join(directory, "calls.log");
  const saved = { ...process.env };
  Object.assign(process.env, { AI_USAGE_ANTIGRAVITY_BIN: stub, AGY_STUB_LOG: log, AI_USAGE_STATE_DIR: join(directory, "state") }, env);
  try { return await body(log, directory); } finally { process.env = saved; rmSync(directory, { recursive: true, force: true }); }
}
const calls = (log: string) => { try { return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as string[]); } catch { return []; } };

test("Antigravity is registered as an optional reader after Claude and Codex", () => {
  assert.deepEqual(providerReaders.map(reader => [reader.id, !!reader.optional]), [["claude", false], ["codex", false], ["antigravity", true]]);
});
test("print-mode /usage is only allowed from the documented CLI version", () => {
  assert.deepEqual(parseVersion("1.4.5\n"), [1, 4, 5]);
  assert.deepEqual(parseVersion("Antigravity CLI v1.12.0 (build 4f2a, 2026-10-01)\n"), [1, 12, 0]);
  assert.deepEqual(parseVersion("agy version 2.0.3-beta.1"), [2, 0, 3]);
  assert.equal(parseVersion("Authentication required"), undefined);
  assert.equal(parseVersion("dev build 10.4"), undefined);
  assert.equal(supportsPrintUsage([1, 1, 10]), false);
  assert.equal(supportsPrintUsage([1, 1, 11]), true);
  assert.equal(supportsPrintUsage([2, 0, 0]), true);
  assert.equal(supportsPrintUsage(undefined), false);
});
test("shape summary masks dynamic keys and never contains values", () => {
  const sentinel = { "person@example.test": { "secret-token-value": "2026-10-22T07:00:00Z" }, quota: { "model-xyz": { remaining_fraction: 0.4242, reset_time: "2026-10-22T07:00:00Z", note: "private-text" } }, response: "a\tb\nc\td", list: [{ id: "opaque-id-123" }] };
  const output = JSON.stringify(describeShape(sentinel));
  for (const leaked of ["person@example.test", "secret-token-value", "model-xyz", "0.4242", "2026-10-22", "private-text", "opaque-id-123", "note"]) assert(!output.includes(leaked), leaked);
  assert.match(output, /remaining_fraction":"number<0\.\.1>"/);
  assert.match(output, /reset_time":"string<datetime>"/);
  assert.match(output, /string<tsv rows=2 cols=2>/);
  assert.equal(JSON.stringify(describeShape(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i])))).includes("\"omittedKeys\":8"), true);
});
test("old or missing CLIs are never run in print mode", async () => {
  await withStub({ AGY_STUB_VERSION: "1.1.10" }, async log => {
    const result = await probeAntigravityUsage();
    assert.equal(result.ran, false); assert.equal(result.printUsageSupported, false);
    assert.deepEqual(calls(log), [["--version"]]);
  });
  await withStub({ AI_USAGE_ANTIGRAVITY_BIN: join(tmpdir(), "missing-agy-binary") }, async () => {
    assert.deepEqual(await probeAntigravityUsage(), { installed: false, version: null, printUsageSupported: false, ran: false });
  });
});
test("signed-out runtime reports a zero-inference error envelope without its message", async () => {
  await withStub({}, async log => {
    const result = await probeAntigravityUsage();
    assert.equal(result.outcome, "error_envelope"); assert.equal(result.status, "ERROR"); assert.equal(result.zeroInference, true);
    assert(!JSON.stringify(result).includes("authentication failed"));
    assert.deepEqual(calls(log)[1], ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"]);
  });
});
test("a CLI waiting for sign-in is killed at the probe timeout", async () => {
  await withStub({ AGY_STUB_HANG: "1" }, async () => {
    const result = await probeAntigravityUsage(500);
    assert.equal(result.outcome, "timeout");
  });
});

const reset = Date.parse("2026-10-25T12:00:00Z"); const sampledAt = reset - 86_400_000;
const bucket = (fields: Record<string, unknown>) => ({ id: "alpha-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.25, reset_time: "2026-10-25T12:00:00Z", ...fields });
const envelope = (groups: unknown[], status = "SUCCESS") => ({ status, num_turns: 0, usage: { total_tokens: 0 }, command: { name: "usage", data: { groups } } });

test("each /usage bucket becomes a meter labeled by its group and payload window", () => {
  const result = fromAntigravityUsage(envelope([
    { name: "Alpha Models", buckets: [bucket({})] },
    { name: "Beta and Gamma models", buckets: [bucket({ id: "3p-weekly", remaining_fraction: 1 })] },
  ]), sampledAt);
  assert.deepEqual(result, { id: "antigravity", state: "ok", sampledAt, windows: {}, meters: [
    { id: "alpha-weekly", label: "Alpha Models (weekly)", usedPercent: 75, resetsAt: reset },
    { id: "q-3p-weekly", label: "Beta and Gamma models (weekly)", usedPercent: 0, resetsAt: reset },
  ] });
  // The relay/phone parser accepts the result unchanged.
  parseSnapshot({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [result] }, sampledAt);
});
test("unknown, expired or malformed buckets are left out instead of guessed", () => {
  const result = fromAntigravityUsage(envelope([{ name: "Alpha", buckets: [
    bucket({ remaining_fraction: undefined }), bucket({ remaining_fraction: "0.5" }), bucket({ remaining_fraction: 1.2 }), bucket({ remaining_fraction: -0.1 }),
    bucket({ reset_time: "2026-10-24T00:00:00Z" }), bucket({ reset_time: "soon" }), bucket({ reset_time: undefined }),
  ] }, { name: "No buckets" }, null]), sampledAt);
  assert.deepEqual(result, { id: "antigravity", state: "unavailable", sampledAt: null, windows: {} });
  assert.equal(fromAntigravityUsage(envelope([{ name: "Alpha", buckets: [bucket({})] }], "ERROR"), sampledAt).state, "unavailable");
  assert.equal(fromAntigravityUsage({ status: "SUCCESS", response: "Alpha\tWeekly\t25%\t2026-10-25T12:00:00Z" }, sampledAt).state, "unavailable");
});
test("labels and IDs stay within the snapshot limits", () => {
  const groups = Array.from({ length: 8 }, (_, i) => ({ name: `Group <${i}> with a very long name — and symbols ✓`, buckets: [bucket({ id: i === 1 ? "alpha-weekly" : `B ${i}/x`, window: "rolling_5h_window_extra" })] }));
  const result = fromAntigravityUsage(envelope(groups), sampledAt);
  assert.equal(result.meters?.length, 6);
  for (const meter of result.meters!) { assert.match(meter.id, /^[a-z][a-z0-9_-]{0,31}$/); assert.match(meter.label, /^[\p{L}\p{N} _().:+/-]{1,32}$/u); }
  assert.equal(new Set(result.meters!.map(meter => meter.id)).size, 6);
  parseSnapshot({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [result] }, sampledAt);
});
test("the reader runs the zero-turn print command and returns synthetic meters", async () => {
  await withStub({ AGY_STUB_MODE: "usage" }, async log => {
    const result = await readAntigravityUsage();
    assert.equal(result.state, "ok");
    assert.deepEqual(result.meters?.map(meter => [meter.id, meter.label, meter.usedPercent]), [["alpha-weekly", "Alpha Models (weekly)", 25], ["q-9z-weekly", "Beta and Gamma models (weekly)", 0]]);
    assert.deepEqual(calls(log), [["--version"], ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"]]);
  });
});
test("a sign-in prompt stops the CLI at once, reports auth_required and backs off", async () => {
  await withStub({ AGY_STUB_MODE: "auth" }, async log => {
    let clock = 1_000_000; const now = () => clock;
    const started = Date.now();
    assert.equal((await readAntigravityUsage(10_000, now)).state, "auth_required");
    assert(Date.now() - started < 8_000, "auth prompt must not wait for the timeout");
    assert.equal((await readAntigravityUsage(10_000, now)).state, "auth_required");
    assert.equal(calls(log).length, 2, "no CLI start while backing off");
    clock += 5 * 60_000;
    await readAntigravityUsage(10_000, now);
    assert.equal(calls(log).length, 4);
    clock += 5 * 60_000; await readAntigravityUsage(10_000, now);
    assert.equal(calls(log).length, 4, "second failure doubles the wait");
    process.env.AGY_STUB_MODE = "usage"; clock += 5 * 60_000;
    assert.equal((await readAntigravityUsage(10_000, now)).state, "ok");
    assert.equal((await readAntigravityUsage(10_000, now)).state, "ok", "success clears the backoff");
  });
});
test("a run that reports turns or tokens is not trusted", async () => {
  await withStub({ AGY_STUB_MODE: "inference" }, async () => {
    assert.equal((await readAntigravityUsage()).state, "unavailable");
  });
});
test("missing or outdated CLIs throw and are never run in print mode", async () => {
  await withStub({ AGY_STUB_VERSION: "1.1.10", AGY_STUB_MODE: "usage" }, async log => {
    await assert.rejects(readAntigravityUsage(), /older than 1\.1\.11/);
    assert.deepEqual(calls(log), [["--version"]]);
  });
  await withStub({ AI_USAGE_ANTIGRAVITY_BIN: join(tmpdir(), "missing-agy-binary") }, async () => {
    await assert.rejects(readAntigravityUsage(), /not found/);
  });
});

const ok = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: Date.now() - 1000, windows: { weekly: { usedPercent: 10, resetsAt: Date.now() + 86_400_000 } } });
test("collect omits Antigravity until it has produced data, then keeps it stale or signed out", async () => {
  await withStub({}, async () => {
    const base = [{ id: "claude", read: async () => ok("claude") }, { id: "codex", read: async () => ok("codex") }];
    let next: () => Promise<ProviderUsage> = async () => ({ id: "antigravity", state: "auth_required", sampledAt: null, windows: {} });
    const readers = [...base, { id: "antigravity", optional: true, read: () => next() }];
    assert.deepEqual((await collect(readers)).providers.map(p => p.id), ["claude", "codex"]);
    next = async () => { throw new Error("Antigravity CLI not found"); };
    assert.deepEqual((await collect(readers)).providers.map(p => p.id), ["claude", "codex"]);
    const fresh = fromAntigravityUsage(envelope([{ name: "Alpha", buckets: [bucket({ reset_time: new Date(Date.now() + 86_400_000).toISOString() })] }]), Date.now() - 500);
    next = async () => fresh;
    const seen = (await collect(readers)).providers.find(p => p.id === "antigravity");
    assert.equal(seen?.state, "ok");
    next = async () => ({ id: "antigravity", state: "auth_required", sampledAt: null, windows: {} });
    const signedOut = (await collect(readers)).providers.find(p => p.id === "antigravity");
    assert.deepEqual(signedOut, { ...fresh, state: "auth_required" }, "keeps the last observation and its age");
    next = async () => ({ id: "antigravity", state: "unavailable", sampledAt: null, windows: {} });
    assert.equal((await collect(readers)).providers.find(p => p.id === "antigravity")?.state, "unavailable");
    next = async () => { throw new Error("Antigravity CLI not found"); };
    assert.deepEqual((await collect(readers)).providers.map(p => p.id), ["claude", "codex"], "an uninstalled CLI drops the provider");
  });
});
test("probe reports a sign-in prompt without its URL", async () => {
  await withStub({ AGY_STUB_MODE: "auth" }, async () => {
    const result = await probeAntigravityUsage(10_000);
    assert.equal(result.outcome, "auth_required");
    assert(!JSON.stringify(result).includes("accounts.google.com"));
  });
});

test("unrecognised version output is reported as such and never runs print mode", async () => {
  await withStub({ AGY_STUB_VERSION: "agy dev build", AGY_STUB_MODE: "usage" }, async log => {
    await assert.rejects(readAntigravityUsage(), /version unrecognised/);
    assert.deepEqual(calls(log), [["--version"]]);
  });
  await withStub({ AGY_STUB_VERSION: "Antigravity CLI 1.4.5 (linux-x64)", AGY_STUB_MODE: "usage" }, async () => {
    assert.equal((await readAntigravityUsage()).state, "ok");
  });
});
test("a CLI version that ran a model turn is latched until the version changes", async t => {
  const logged = t.mock.method(console, "error", () => {});
  await withStub({ AGY_STUB_MODE: "inference" }, async (log, directory) => {
    let clock = 1_000_000; const now = () => clock;
    assert.equal((await readAntigravityUsage(10_000, now)).state, "unavailable");
    const saved = JSON.parse(readFileSync(join(directory, "state", "antigravity.json"), "utf8"));
    assert.equal(saved.inferenceSeenVersion, "1.4.5");
    assert.equal(logged.mock.callCount(), 1);
    const line = String(logged.mock.calls[0]!.arguments[0]);
    assert.match(line, /1\.4\.5.*paused until the CLI version changes/);
    assert(!/1234|Alpha|75/.test(line), "the log line carries no payload values");
    process.env.AGY_STUB_MODE = "usage";
    for (let i = 0; i < 3; i++) { clock += 25 * 3_600_000; assert.equal((await readAntigravityUsage(10_000, now)).state, "unavailable"); }
    assert.equal(calls(log).filter(args => args[0] === "-p").length, 1, "the latched version is never run in print mode again");
    assert.equal((await probeAntigravityUsage()).outcome, "inference_latched");
    assert.equal(logged.mock.callCount(), 1, "one log line, not one per sync");
    process.env.AGY_STUB_VERSION = "1.4.6";
    assert.equal((await readAntigravityUsage(10_000, now)).state, "ok", "a new CLI version clears the latch");
    assert.equal(JSON.parse(readFileSync(join(directory, "state", "antigravity.json"), "utf8")).inferenceSeenVersion, undefined);
  });
});
test("the CLI runs in an empty temporary directory without a display or browser", async () => {
  assert.deepEqual(childEnvironment({ PATH: "/bin", HOME: "/h", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", BROWSER: "firefox" }, "linux"), { PATH: "/bin", HOME: "/h", BROWSER: "true" });
  assert.deepEqual(childEnvironment({ PATH: "C:\\bin", BROWSER: "x" }, "win32"), { PATH: "C:\\bin" });
  await withStub({ AGY_STUB_MODE: "usage", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" }, async (_log, directory) => {
    const envLog = join(directory, "env.log"); process.env.AGY_STUB_ENV_LOG = envLog;
    assert.equal((await readAntigravityUsage()).state, "ok");
    const seen = readFileSync(envLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(seen.length, 2);
    for (const entry of seen) {
      assert.deepEqual([entry.display, entry.wayland], [false, false]);
      if (process.platform !== "win32") assert.equal(entry.browser, "true");
      assert.notEqual(entry.cwd, process.cwd());
      assert.match(entry.cwd, /meterkat-agy-/);
      assert.equal(existsSync(entry.cwd), false, "the temporary directory is removed");
    }
  });
});
test("auth detection needs the Google OAuth URL or an explicit prompt, across chunk boundaries", async () => {
  assert.equal(looksLikeAuthPrompt("Please visit https://accounts.google.com/o/oauth2/v2/auth?client_id=x"), true);
  assert.equal(looksLikeAuthPrompt("Enter the authorization code:"), true);
  assert.equal(looksLikeAuthPrompt("Please sign in to continue"), true);
  for (const harmless of ["Use /logout or login again to switch accounts.", "OAuth token cache refreshed", "Signed in as a synthetic user", "see https://accounts.google.com for account settings"]) assert.equal(looksLikeAuthPrompt(harmless), false, harmless);
  await withStub({ AGY_STUB_MODE: "noise" }, async () => {
    assert.equal((await readAntigravityUsage()).state, "ok", "a harmless login word does not end a good run");
  });
  await withStub({ AGY_STUB_MODE: "auth-split" }, async () => {
    const started = Date.now();
    assert.equal((await readAntigravityUsage(10_000)).state, "auth_required");
    assert(Date.now() - started < 8_000);
  });
});
test("auth backoff doubles up to 24 hours, other failures up to 60 minutes", () => {
  assert.deepEqual([1, 2, 5, 6, 20].map(n => backoffMs(n, false) / 60_000), [5, 10, 60, 60, 60]);
  assert.deepEqual([1, 5, 9, 10, 20].map(n => backoffMs(n, true) / 60_000), [5, 80, 1280, 1440, 1440]);
});
test("a stuck child cannot hang collection: timeout and kill resolve even without close", { skip: process.platform === "win32" }, async () => {
  for (const [mode, timeout] of [["hang", 500], ["auth", 10_000]] as const) {
    await withStub({ AGY_STUB_ORPHAN: "", ...(mode === "hang" ? { AGY_STUB_HANG: "1" } : { AGY_STUB_MODE: "auth" }) }, async (_log, directory) => {
      const pidFile = join(directory, "orphan.pid"); process.env.AGY_STUB_ORPHAN = pidFile;
      const started = Date.now();
      try {
        const result = await probeAntigravityUsage(timeout);
        assert.equal(result.outcome, mode === "hang" ? "timeout" : "auth_required");
        assert(Date.now() - started < 8_000, `${mode}: resolved within the grace period`);
        assert(existsSync(pidFile), "an orphan held the pipes open");
      } finally {
        if (existsSync(pidFile)) try { process.kill(Number(readFileSync(pidFile, "utf8"))); } catch { /* Gone. */ }
      }
    });
  }
});
test("labels are cut by code points and duplicates are told apart by bucket name", () => {
  const astral = "\u{1D49C}".repeat(40); // MATHEMATICAL SCRIPT CAPITAL A: a letter outside the BMP.
  const result = fromAntigravityUsage(envelope([
    { name: astral, buckets: [bucket({ id: "a" })] },
    { name: "Alpha", buckets: [bucket({ id: "b", name: "Weekly Limit" }), bucket({ id: "c", name: "Daily Limit" }), bucket({ id: "d", name: "Weekly Limit" })] },
    { name: "Alpha", buckets: [bucket({ id: "e", name: "" })] },
  ]), sampledAt);
  const labels = result.meters!.map(meter => meter.label);
  assert.equal(labels[0], "\u{1D49C}".repeat(23) + " (weekly)");
  assert.deepEqual(labels.slice(1), ["Alpha (weekly)", "Alpha Daily Limit (weekly)", "Alpha Weekly Limit (weekly)", "Alpha 2 (weekly)"]);
  assert.equal(new Set(labels).size, labels.length);
  for (const label of labels) assert.equal(label.isWellFormed(), true);
  parseSnapshot({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [result] }, sampledAt);
});
