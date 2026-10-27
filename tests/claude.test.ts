import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeUsage, resetClaudeAccountCache } from "../src/claude.js";
import { accountFingerprint } from "../src/account.js";

const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
const report = (limits: unknown) => JSON.stringify({ type: "assistant", usage_report: { rate_limits: limits } });
// Each call prints the next reply in order; the last reply repeats.
// `auth status --json` answers with [auth] and is not counted as a usage call.
const signedIn = { loggedIn: true, authMethod: "claude.ai", orgId: "11111111-2222-4333-8444-555555555555", email: "Someone@Example.test", subscriptionType: "max" };
async function withClaude(replies: string[], body: (calls: () => number) => Promise<void>, auth: unknown = signedIn) {
  resetClaudeAccountCache();
  const directory = mkdtempSync(join(tmpdir(), "claude-stub-")); const log = join(directory, "calls.log"); const bin = join(directory, "claude");
  writeFileSync(bin, `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
if (process.argv[2] === "auth") { console.log(${JSON.stringify(JSON.stringify(auth))}); process.exit(0); }
appendFileSync(${JSON.stringify(log)}, "x");
const replies = ${JSON.stringify(replies)};
console.log(replies[Math.min(readFileSync(${JSON.stringify(log)}, "utf8").length, replies.length) - 1]);
`);
  chmodSync(bin, 0o755);
  const saved = process.env.AI_USAGE_CLAUDE_BIN; process.env.AI_USAGE_CLAUDE_BIN = bin;
  try { await body(() => readFileSync(log, "utf8").length); }
  finally { if (saved === undefined) delete process.env.AI_USAGE_CLAUDE_BIN; else process.env.AI_USAGE_CLAUDE_BIN = saved; rmSync(directory, { recursive: true, force: true }); }
}
const skip = process.platform === "win32" && "stub relies on a shebang";

test("a report without rate limits is retried once", { skip }, () => withClaude([report(null), report({ limits: [{ kind: "session", percent: 16, resets_at: resetsAt }] })], async calls => {
  const usage = await readClaudeUsage();
  assert.equal(usage.state, "ok"); assert.equal(usage.windows.fiveHour?.usedPercent, 16); assert.equal(calls(), 2);
}));
test("a readable report is not requested twice", { skip }, () => withClaude([report({ limits: [{ kind: "weekly_all", percent: 37, resets_at: resetsAt }] })], async calls => {
  assert.equal((await readClaudeUsage()).state, "ok"); assert.equal(calls(), 1);
}));
test("rate limits missing twice stay unavailable", { skip }, () => withClaude([report(null)], async calls => {
  assert.equal((await readClaudeUsage()).state, "unavailable"); assert.equal(calls(), 2);
}));

test("a readable report carries the account fingerprint, never the e-mail or organization", { skip }, () => withClaude([report({ limits: [{ kind: "session", percent: 5, resets_at: resetsAt }] })], async () => {
  const usage = await readClaudeUsage();
  assert.equal(usage.account, accountFingerprint("claude", signedIn.orgId, "someone@example.test"));
  assert.match(usage.account!, /^[A-Za-z0-9_-]{22}$/);
  assert(!JSON.stringify(usage).includes("xample") && !JSON.stringify(usage).includes(signedIn.orgId));
}));
test("signed out or unreadable auth status means no fingerprint, not a failed read", { skip }, async () => {
  for (const auth of [{ loggedIn: false }, "not json"]) await withClaude([report({ limits: [{ kind: "session", percent: 5, resets_at: resetsAt }] })], async () => {
    const usage = await readClaudeUsage();
    assert.equal(usage.state, "ok"); assert.equal(usage.account, undefined);
  }, auth);
});
