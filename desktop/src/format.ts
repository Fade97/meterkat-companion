// Formatting shared by the window and the tray menu; pure, so it is unit-tested.
import type { ProviderUsage, Snapshot, WindowUsage } from "../../shared/snapshot.js";
import { PROVIDER_GLYPHS } from "./provider-glyphs.js";

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity" };
export const providerName = (id: string) => NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
/** Providers the companion can read; listed as "not set up" when they have never reported quota. */
export const KNOWN_PROVIDERS = ["claude", "codex", "antigravity"];
// Same colours as the Android app's bars; unknown providers get a neutral grey, not an official colour.
const COLORS: Record<string, string> = { claude: "#D97757", codex: "#6EA8FE", antigravity: "#34C77B" };
export const providerColor = (id: string) => COLORS[id] ?? "#94A3B8";
/** Inline SVG of the provider's glyph, filled with --provider; a plain dot for providers without a registered glyph. */
export function providerMark(id: string) {
  const glyph = PROVIDER_GLYPHS[id];
  return glyph ? `<svg class="provider-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="${glyph}"/></svg>` : `<span class="provider-dot" aria-hidden="true"></span>`;
}

export type Bar = { label: string; usedPercent: number; resetsAt: number };
/** The bars a provider shows: its five-hour and weekly windows, or its quota buckets (Antigravity). */
export function bars(provider: ProviderUsage): Bar[] {
  const windows: [string, WindowUsage | undefined][] = [["5-hour", provider.windows.fiveHour], ["Weekly", provider.windows.weekly]];
  const result = windows.filter((w): w is [string, WindowUsage] => !!w[1]).map(([label, w]) => ({ label, ...w }));
  for (const meter of provider.meters ?? []) result.push({ label: meter.label, usedPercent: meter.usedPercent, resetsAt: meter.resetsAt });
  return result;
}

/** True when a provider has never reported quota on this computer: missing tool or never read. Sign-in needed is set up. */
const notSetUp = (p: ProviderUsage) => p.state === "unavailable" && p.sampledAt === null && bars(p).length === 0;
/** Splits a snapshot into providers shown as cards and ids shown as a single "not set up" line. */
export function providerGroups(snapshot: Snapshot | null): { shown: ProviderUsage[]; notSetUp: string[] } {
  if (!snapshot) return { shown: [], notSetUp: [] };
  const shown = snapshot.providers.filter(p => !notSetUp(p));
  const ids = new Set(shown.map(p => p.id));
  return { shown, notSetUp: [...snapshot.providers.map(p => p.id), ...KNOWN_PROVIDERS].filter((id, i, all) => !ids.has(id) && all.indexOf(id) === i) };
}

export const percent = (value: number) => `${Math.round(value)}%`;

/** "3 h 12 min", "45 min", "2 d 4 h"; never negative. */
export function duration(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `${Math.floor(hours / 24)} d${hours % 24 ? ` ${hours % 24} h` : ""}`;
}

export function ago(at: number, now = Date.now()) {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  return `${duration(now - at)} ago`;
}

export function resetText(resetsAt: number, now = Date.now()) {
  return resetsAt <= now ? "reset due" : `resets in ${duration(resetsAt - now)}`;
}

/** One line per provider for the tray: the highest used share among its bars. */
export function trayLines(snapshot: Snapshot | null): string[] {
  const { shown, notSetUp } = providerGroups(snapshot);
  return [...shown.map(p => {
    const highest = bars(p).reduce<number | null>((max, b) => max === null || b.usedPercent > max ? b.usedPercent : max, null);
    if (p.state === "auth_required") return `${providerName(p.id)}: sign-in needed`;
    if (highest === null) return `${providerName(p.id)}: no data`;
    return `${providerName(p.id)}: ${percent(highest)} used${p.state === "ok" ? "" : " (stale)"}`;
  }), ...notSetUp.map(id => `${providerName(id)}: not set up`)];
}
