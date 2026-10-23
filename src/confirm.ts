import { createInterface } from "node:readline/promises";

// Commands that destroy relay data or keys. They accept exactly one optional argument, `--yes`; anything else
// (such as `--help` or a typo) is refused before anything runs. Interactive runs ask; non-interactive runs need `--yes`.
export type DestructiveCommand = "delete" | "rotate-key";
export const isDestructive = (command: string): command is DestructiveCommand => command === "delete" || command === "rotate-key";

export type ConfirmIo = { interactive: boolean; ask: (question: string) => Promise<string> };

/** Throws unless the arguments are empty or exactly `--yes`. Returns whether `--yes` was given. */
export function destructiveArguments(command: DestructiveCommand, args: string[]) {
  if (args.length === 0) return false;
  if (args.length === 1 && args[0] === "--yes") return true;
  throw new Error(`${command} accepts only --yes; nothing was changed.`);
}

const prompts: Record<DestructiveCommand, { question: string; accepts: (answer: string) => boolean }> = {
  delete: {
    question: 'This deletes your relay data, disconnects every paired phone and removes the encryption key on this computer. It can\'t be undone.\nType "delete" to confirm: ',
    accepts: answer => answer.trim() === "delete",
  },
  "rotate-key": {
    question: "This creates a new encryption key and disconnects every paired phone; each must pair again. Continue? [y/N] ",
    accepts: answer => /^y(es)?$/i.test(answer.trim()),
  },
};

/** Resolves when the command may run; throws (nothing changed) when it is refused or cannot be confirmed. */
export async function confirmDestructive(command: DestructiveCommand, args: string[], io: ConfirmIo) {
  if (destructiveArguments(command, args)) return;
  if (!io.interactive) throw new Error(`${command} needs confirmation: run it in a terminal, or pass --yes. Nothing was changed.`);
  if (!prompts[command].accepts(await io.ask(prompts[command].question))) throw new Error("Cancelled; nothing was changed.");
}

export const terminalConfirmIo = (): ConfirmIo => ({
  interactive: !!process.stdin.isTTY,
  ask: async question => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(question); } finally { rl.close(); } },
});
