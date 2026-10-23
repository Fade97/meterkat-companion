import test from "node:test";
import assert from "node:assert/strict";
import { confirmDestructive, destructiveArguments, isDestructive, type ConfirmIo } from "../src/confirm.js";

// A recorded fake terminal: answers are scripted, questions are kept for assertions.
function io(interactive: boolean, answer = "") {
  const questions: string[] = [];
  const fake: ConfirmIo = { interactive, ask: async question => { questions.push(question); return answer; } };
  return { fake, questions };
}

test("only delete and rotate-key are destructive", () => {
  assert.ok(isDestructive("delete") && isDestructive("rotate-key"));
  for (const c of ["revoke", "pair", "devices", "--help", ""]) assert.equal(isDestructive(c), false);
});

test("destructive commands accept no argument or exactly --yes", () => {
  assert.equal(destructiveArguments("delete", []), false);
  assert.equal(destructiveArguments("delete", ["--yes"]), true);
  for (const args of [["--help"], ["-h"], ["-y"], ["--yes", "--yes"], ["--yes", "now"], ["yes"], ["--force"]])
    assert.throws(() => destructiveArguments("delete", args), /accepts only --yes; nothing was changed/, args.join(" "));
});

test("--yes skips the prompt, interactive or not", async () => {
  for (const interactive of [true, false]) {
    const { fake, questions } = io(interactive);
    await confirmDestructive("delete", ["--yes"], fake);
    assert.deepEqual(questions, []);
  }
});

test("non-interactive runs without --yes are refused without asking", async () => {
  for (const command of ["delete", "rotate-key"] as const) {
    const { fake, questions } = io(false, "delete");
    await assert.rejects(confirmDestructive(command, [], fake), /needs confirmation: run it in a terminal, or pass --yes/);
    assert.deepEqual(questions, []);
  }
});

test("delete asks to type the word delete", async () => {
  for (const answer of ["delete", "  delete\n"]) {
    const { fake, questions } = io(true, answer);
    await confirmDestructive("delete", [], fake);
    assert.match(questions[0]!, /Type "delete" to confirm/);
  }
  for (const answer of ["", "y", "yes", "Delete", "DELETE", "del"])
    await assert.rejects(confirmDestructive("delete", [], io(true, answer).fake), /Cancelled; nothing was changed/, answer);
});

test("rotate-key asks y/N and defaults to no", async () => {
  for (const answer of ["y", "Y", "yes", "YES "]) await confirmDestructive("rotate-key", [], io(true, answer).fake);
  const { fake, questions } = io(true, "");
  await assert.rejects(confirmDestructive("rotate-key", [], fake), /Cancelled/);
  assert.match(questions[0]!, /\[y\/N\]/);
  for (const answer of ["n", "no", "rotate", "delete"]) await assert.rejects(confirmDestructive("rotate-key", [], io(true, answer).fake), /Cancelled/);
});

test("an invalid argument is refused before any prompt", async () => {
  const { fake, questions } = io(true, "delete");
  await assert.rejects(confirmDestructive("delete", ["--help"], fake), /accepts only --yes/);
  assert.deepEqual(questions, []);
});
