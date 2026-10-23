import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexCommand } from "../src/codex.js";

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
