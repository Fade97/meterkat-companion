import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeUsage } from "../src/claude.js";

const resetsAt = new Date(Date.now() + 3_600_000).toISOString();
const report = (limits: unknown) => JSON.stringify({ type: "assistant", usage_report: { rate_limits: limits } });
// Each call prints the next reply in order; the last reply repeats.
async function withClaude(replies: string[], body: (calls: () => number) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "claude-stub-")); const log = join(directory, "calls.log"); const bin = join(directory, "claude");
  writeFileSync(bin, `#!${process.execPath}
const { appendFileSync, readFileSync } = require("node:fs");
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
