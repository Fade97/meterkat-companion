import { readCodexUsage } from "./codex.js";
import { readClaudeUsage } from "./claude.js";
import { readAntigravityUsage } from "./antigravity.js";
import { readState, writeState } from "./state.js";
import { parseSnapshot, unavailable, type ProviderUsage, type Snapshot } from "../shared/snapshot.js";

/** An optional provider is only reported once it has delivered real quota data, and only while its CLI is usable. */
export type ProviderReader = { id: string; read: () => Promise<ProviderUsage>; optional?: boolean };
export const providerReaders: ProviderReader[] = [
  { id: "claude", read: () => readClaudeUsage() },
  { id: "codex", read: () => readCodexUsage() },
  // On by default: v1.0 phones accept 1–12 providers. AI_USAGE_ANTIGRAVITY=off is for old two-provider pilot builds.
  ...(process.env.AI_USAGE_ANTIGRAVITY === "off" ? [] : [{ id: "antigravity", read: () => readAntigravityUsage(), optional: true }]),
];

export async function collect(readers = providerReaders): Promise<Snapshot> {
  const previous = readState<Snapshot>("snapshot.json");
  const read = async ({ id, read: fetch, optional }: ProviderReader): Promise<ProviderUsage | undefined> => {
    let authRequired = false;
    try {
      const current = await fetch();
      if (current.id === id && current.state === "ok") return current;
      authRequired = current.state === "auth_required";
    } catch {
      // A removed or outdated optional CLI is no longer a provider; others keep their observation age and data.
      if (optional) return undefined;
    }
    const old = previous?.providers.find(p => p.id === id);
    if (optional && !old) return undefined;
    if (id === "claude") {
      const exported = readState<ProviderUsage>("claude.json");
      if (exported && (exported.sampledAt ?? 0) > (old?.sampledAt ?? 0)) {
        // A status-line export is an optional fallback; don't relabel it a fresh native poll.
        return exported;
      }
    }
    return unavailable(id, old, authRequired);
  };
  const providers = (await Promise.all(readers.map(read))).filter(p => p !== undefined);
  const snapshot = parseSnapshot({ schemaVersion: 1, sequence: (previous?.sequence ?? 0) + 1, generatedAt: Math.max(Date.now(), (previous?.generatedAt ?? 0) + 1), providers });
  writeState("snapshot.json", snapshot); return snapshot;
}
