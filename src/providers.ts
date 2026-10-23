import { antigravityCommand } from "./antigravity.js";
import { codexCommand } from "./codex.js";
import { providerReaders } from "./collect.js";
import { findExecutable, type ProviderCheck } from "./setup.js";

/** Presence comes from PATH (no side effects); readiness from the same native quota read `inspect` uses. */
export async function detectProviders(probe: boolean): Promise<ProviderCheck[]> {
  const commands: Record<string, () => string | undefined> = {
    claude: () => findExecutable(process.env.AI_USAGE_CLAUDE_BIN ?? "claude"),
    codex: () => { try { const c = codexCommand(); return c.args[0] ?? findExecutable(c.command); } catch { return undefined; } },
    antigravity: () => findExecutable(antigravityCommand().command),
  };
  const ids = [...new Set([...providerReaders.map(r => r.id), ...Object.keys(commands)])];
  return Promise.all(ids.map(async id => {
    const installed = !!commands[id]?.();
    const reader = providerReaders.find(r => r.id === id);
    if (!reader) return { id, installed, ready: null, note: installed ? "found; quota collection is not supported yet" : "not found" };
    if (!installed) return { id, installed, ready: false, note: "not found on PATH (set AI_USAGE_" + id.toUpperCase() + "_BIN if installed elsewhere)" };
    if (!probe) return { id, installed, ready: null, note: "found; sign-in is checked during setup" };
    try { const usage = await reader.read(); return { id, installed, ready: usage.state === "ok", note: usage.state === "ok" ? "signed in, quota readable" : "found, but no quota data; check sign-in" }; }
    catch (error) { return { id, installed, ready: false, note: error instanceof Error ? error.message : "quota unavailable" }; }
  }));
}
