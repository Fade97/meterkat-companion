import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCommand, nativeCodexBeside, readCodexUsage } from "../src/codex.js";
import { accountFingerprint } from "../src/account.js";

// An npm global install on Windows: codex.cmd shim plus node_modules/@openai/codex/bin/codex.js, no codex.exe.
function npmGlobal(t: { after: (fn: () => void) => void }, withNode: boolean) {
  const root = mkdtempSync(join(tmpdir(), "meterkat-codex-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const npm = join(root, "npm"); const nodejs = join(root, "nodejs");
  mkdirSync(join(npm, "node_modules", "@openai", "codex", "bin"), { recursive: true }); mkdirSync(nodejs);
  writeFileSync(join(npm, "codex.cmd"), ""); writeFileSync(join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), "");
  if (withNode) writeFileSync(join(nodejs, "node.exe"), "");
  return { script: join(npm, "node_modules", "@openai", "codex", "bin", "codex.js"), node: join(nodejs, "node.exe"), env: { PATH: `${npm};${nodejs}` } };
}

test("packaged Windows companion runs codex.js with Node from PATH, never with itself", t => {
  const { script, node, env } = npmGlobal(t, true);
  assert.deepEqual(codexCommand(env, "win32", true), { command: node, args: [script] });
  assert.deepEqual(codexCommand({ ...env, AI_USAGE_CODEX_BIN: script }, "win32", true), { command: node, args: [script] });
});

test("unpackaged companion already is Node and keeps using its own runtime", t => {
  const { script, env } = npmGlobal(t, true);
  assert.deepEqual(codexCommand(env, "win32", false), { command: process.execPath, args: [script] });
});

test("packaged companion without Node explains how to point at the native Codex executable", t => {
  const { env } = npmGlobal(t, false);
  assert.throws(() => codexCommand(env, "win32", true), /Node\.js on PATH.*AI_USAGE_CODEX_BIN/);
});

// Where npm, pnpm or an older bundle put the native binary that codex.js would start.
const layouts = {
  nested: (npm: string) => join(npm, "node_modules", "@openai", "codex", "node_modules", "@openai", "codex-win32-x64"),
  hoisted: (npm: string) => join(npm, "node_modules", "@openai", "codex-win32-x64"),
  bundled: (npm: string) => join(npm, "node_modules", "@openai", "codex"),
};
for (const [name, base] of Object.entries(layouts)) {
  test(`Windows starts the ${name} native Codex binary directly, not through codex.js (no console window)`, t => {
    const { script, env } = npmGlobal(t, false);
    const npm = env.PATH.split(";")[0]!;
    const native = join(base(npm), "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
    mkdirSync(join(native, ".."), { recursive: true }); writeFileSync(native, "");
    assert.equal(nativeCodexBeside(script, "x64"), native);
    // Neither packaged nor desktop builds need Node then; a configured codex.js resolves the same way.
    assert.deepEqual(codexCommand(env, "win32", true, "x64"), { command: native, args: [] });
    assert.deepEqual(codexCommand(env, "win32", false, "x64"), { command: native, args: [] });
    assert.deepEqual(codexCommand({ ...env, AI_USAGE_CODEX_BIN: script }, "win32", true, "x64"), { command: native, args: [] });
  });
}

test("native lookup ignores other architectures and falls back to codex.js", t => {
  const { script, node, env } = npmGlobal(t, true);
  const native = join(env.PATH.split(";")[0]!, "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  mkdirSync(join(native, ".."), { recursive: true }); writeFileSync(native, "");
  assert.equal(nativeCodexBeside(script, "ia32"), undefined);
  assert.deepEqual(codexCommand(env, "win32", true, "arm64"), { command: node, args: [script] });
});

// A fake App Server: answers initialize, the quota read and (when [account] is set) account/read.
function fakeAppServer(t: { after: (fn: () => void) => void }, account: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "codex-stub-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bin = join(directory, "codex");
  const limits = { rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } };
  writeFileSync(bin, `#!${process.execPath}
const answers = { 1: { result: {} }, 2: { result: ${JSON.stringify(limits)} }, 3: ${JSON.stringify(account)} };
let buffer = "";
process.stdin.on("data", chunk => {
  buffer += chunk; let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, i)); buffer = buffer.slice(i + 1);
    const answer = answers[message.id];
    if (answer === null) process.exit(0);
    if (answer) console.log(JSON.stringify({ id: message.id, ...answer }));
  }
});
`);
  chmodSync(bin, 0o755);
  const saved = process.env.AI_USAGE_CODEX_BIN; process.env.AI_USAGE_CODEX_BIN = bin;
  t.after(() => { if (saved === undefined) delete process.env.AI_USAGE_CODEX_BIN; else process.env.AI_USAGE_CODEX_BIN = saved; });
}
const unixOnly = process.platform === "win32" && "stub relies on a shebang";

test("Codex quota carries the ChatGPT account fingerprint (#68)", { skip: unixOnly }, async t => {
  fakeAppServer(t, { result: { account: { type: "chatgpt", email: "a@example.test", planType: "pro" }, workspaceRouting: { chatgptAccountId: "acc-1" } } });
  const usage = await readCodexUsage();
  assert.equal(usage.state, "ok"); assert.equal(usage.windows.fiveHour?.usedPercent, 12);
  assert.equal(usage.account, accountFingerprint("codex", "acc-1", "a@example.test"));
  assert(!JSON.stringify(usage).includes("example"));
});

test("a failing or missing account read keeps the quota without a fingerprint", { skip: unixOnly }, async t => {
  for (const account of [{ error: { code: -32601, message: "unknown method" } }, null]) {
    fakeAppServer(t, account);
    const usage = await readCodexUsage();
    assert.equal(usage.state, "ok"); assert.equal(usage.account, undefined);
  }
});
