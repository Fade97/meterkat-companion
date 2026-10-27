import test from "node:test";
import assert from "node:assert/strict";
import { captureClaude, fromClaudeStatusline, fromClaudeReport, fromCodexLimits, parseSnapshot, unavailable } from "../shared/snapshot.js";
import { accountFingerprint, companionName } from "../src/account.js";

const now = 1_800_000_000_000;
const reset = now / 1000 + 3600;
test("additional providers carry labeled meters without invented session windows", () => {
  const meter = { id: "gemini-pro", label: "Gemini Pro", usedPercent: 20, resetsAt: now + 3600000, accessToken: "not-forwarded" };
  const extra = { id: "antigravity", state: "ok", sampledAt: now, windows: {}, meters: [meter], session: "not-forwarded" };
  const data = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [unavailable("claude"), unavailable("codex"), extra] };
  const result = parseSnapshot(data, now);
  assert.equal(result.providers.length, 3);
  assert.deepEqual(result.providers[2]?.windows, {});
  assert.equal(result.providers[2]?.meters?.[0]?.label, "Gemini Pro");
  assert(!JSON.stringify(result).includes("not-forwarded"));
  assert.deepEqual(unavailable("antigravity", result.providers[2]).meters, result.providers[2]?.meters);
  assert.equal(parseSnapshot({ ...data, providers: [extra] }, now).providers.length, 1);
  assert.throws(() => parseSnapshot({ ...data, providers: [] }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: Array.from({ length: 13 }, (_, i) => unavailable(`provider-${i}`)) }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [{ ...extra, meters: [meter, meter] }] }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [{ ...extra, meters: [{ ...meter, label: "Invalid\\nlabel" }] }] }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [{ ...extra, id: "invalid/id" }] }, now));
});
test("Claude report keeps account-wide quotas separate from scoped model quotas", () => {
  const result = fromClaudeReport({ usage_report: { rate_limits: { limits: [
    { kind: "session", percent: 68, resets_at: new Date(reset * 1000).toISOString() },
    { kind: "weekly_all", percent: 42, resets_at: new Date((reset + 86400) * 1000).toISOString() },
    { kind: "weekly_scoped", percent: 99, resets_at: new Date((reset + 86400) * 1000).toISOString() }
  ] } } }, now);
  assert.equal(result.windows.fiveHour?.usedPercent, 68); assert.equal(result.windows.weekly?.usedPercent, 42);
  assert.equal(fromClaudeReport({}, now).state, "unavailable");
});
test("provider parsers whitelist data and never include session secrets", () => {
  const claude = fromClaudeStatusline({ rate_limits: { five_hour: { used_percentage: 68, resets_at: reset }, seven_day: { used_percentage: 42, resets_at: reset + 86_400 } }, accessToken: "secret", transcript_path: "/private/path" }, now);
  assert.equal(claude.windows.fiveHour?.usedPercent, 68);
  assert.equal(claude.windows.weekly?.resetsAt, (reset + 86_400) * 1000);
  assert(!JSON.stringify(claude).includes("secret")); assert(!JSON.stringify(claude).includes("private"));
});
test("Codex maps by duration instead of primary/secondary ordering", () => {
  const result = fromCodexLimits({ rateLimits: { primary: { usedPercent: 57, windowDurationMins: 10080, resetsAt: reset }, secondary: { usedPercent: 24, windowDurationMins: 300, resetsAt: reset } } }, now);
  assert.equal(result.windows.fiveHour?.usedPercent, 24); assert.equal(result.windows.weekly?.usedPercent, 57);
  assert.deepEqual(fromCodexLimits({ rateLimits: { primary: { usedPercent: 50, windowDurationMins: 15, resetsAt: reset } } }, now).windows, {});
});
test("missing/expired quota is unavailable, never invented zero", () => {
  assert.equal(fromClaudeStatusline({}, now).sampledAt, null);
  assert.deepEqual(fromClaudeStatusline({ rate_limits: { five_hour: { used_percentage: 90, resets_at: now / 1000 - 1 } } }, now).windows, {});
  assert.equal(fromCodexLimits({}, now).state, "unavailable");
});
test("replayed Claude status line cannot freshen sample time", () => {
  const input = { rate_limits: { five_hour: { used_percentage: 68, resets_at: reset } } };
  const first = captureClaude(input, undefined, now)!;
  assert.equal(captureClaude(input, first, now + 600_000)?.sampledAt, now);
  assert.equal(captureClaude({}, first, now + 700_000)?.sampledAt, now);
  assert.equal(captureClaude({ rate_limits: { five_hour: { used_percentage: 69, resets_at: reset } } }, first, now + 700_000)?.sampledAt, now + 700_000);
});
test("snapshot rejects invalid or duplicate providers and impossible sample times", () => {
  const data = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [unavailable("claude"), unavailable("codex")] };
  assert.equal(parseSnapshot(data, now).providers.length, 2);
  assert.throws(() => parseSnapshot({ ...data, sequence: 0 }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [unavailable("claude"), unavailable("claude")] }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [{ id: "claude", state: "ok", sampledAt: now + 1000, windows: { fiveHour: { usedPercent: 10, resetsAt: now + 10000 } } }, unavailable("codex")] }, now));
  const injected = parseSnapshot({ ...data, token: "secret", providers: data.providers.map(p => ({ ...p, secret: "hidden" })) }, now);
  assert(!JSON.stringify(injected).includes("secret"));
});

test("account fingerprints and the computer name pass the whitelist; anything else is refused (#68)", () => {
  const account = accountFingerprint("claude", "org-1", "a@example.test")!;
  const claude = { id: "claude", state: "ok", sampledAt: now, windows: { fiveHour: { usedPercent: 10, resetsAt: now + 3600000 } }, account };
  const data = { schemaVersion: 1, sequence: 1, generatedAt: now, name: "Vulcan", providers: [claude] };
  const result = parseSnapshot(data, now);
  assert.equal(result.name, "Vulcan"); assert.equal(result.providers[0]?.account, account);
  assert.equal(unavailable("claude", result.providers[0]).account, account, "a failed poll keeps the subscription it belongs to");
  assert.equal(parseSnapshot({ ...data, name: undefined }, now).name, undefined);
  assert.throws(() => parseSnapshot({ ...data, name: "bad\nname" }, now));
  assert.throws(() => parseSnapshot({ ...data, name: "x".repeat(33) }, now));
  assert.throws(() => parseSnapshot({ ...data, providers: [{ ...claude, account: "someone@example.test" }] }, now));
});

test("fingerprints match across computers for one account and differ for another", () => {
  assert.equal(accountFingerprint("codex", "acc-1", " A@Example.test "), accountFingerprint("codex", "acc-1", "a@example.test"));
  assert.notEqual(accountFingerprint("codex", "acc-1", "a@example.test"), accountFingerprint("codex", "acc-2", "a@example.test"));
  assert.notEqual(accountFingerprint("codex", "acc-1", "a@example.test"), accountFingerprint("codex", "acc-1", "b@example.test"));
  assert.notEqual(accountFingerprint("codex", "acc-1", "a@example.test"), accountFingerprint("claude", "acc-1", "a@example.test"));
  assert.equal(accountFingerprint("codex", undefined, "a@example.test"), undefined);
  assert.equal(accountFingerprint("codex", "", "a@example.test"), undefined);
});

test("the computer name comes from AI_USAGE_NAME or the short host name, in label characters", () => {
  assert.equal(companionName({}, "vulcan.langur-in.ts.net"), "vulcan");
  assert.equal(companionName({ AI_USAGE_NAME: " Work laptop " }, "host"), "Work laptop");
  assert.equal(companionName({ AI_USAGE_NAME: "Büro<PC>\n" }, "host"), "BüroPC");
  assert.equal(companionName({}, "")?.length ?? 0, 0);
  assert.equal(companionName({ AI_USAGE_NAME: "y".repeat(40) }, "host")?.length, 32);
});
