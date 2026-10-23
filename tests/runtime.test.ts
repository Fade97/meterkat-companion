import assert from "node:assert/strict";
import { test } from "node:test";
import { childEnv } from "../src/runtime.js";

test("only a .js entry point run by Electron gets ELECTRON_RUN_AS_NODE", () => {
  const env = { PATH: "/bin" };
  assert.deepEqual(childEnv({ command: process.execPath }, env, true), { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(childEnv({ command: "codex" }, env, true), env);
  assert.equal(childEnv({ command: process.execPath }, env, false), env);
});
