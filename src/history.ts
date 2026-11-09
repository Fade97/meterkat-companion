import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProviderUsage, Snapshot, WindowUsage } from "../shared/snapshot.js";
import { forecast, type Forecast, type UsageSample } from "./forecast.js";
import { stateDirectory } from "./state.js";

// This computer's usage history for the forecast: one series per subscription and quota window, readings of the last
// RETENTION_MS, in the state directory (private, never uploaded). A reading is kept when the share or the reset changed, at
// most every MIN_SPACING_MS; a quiet run keeps its first reading, one per HEARTBEAT_MS and the latest, so the history
// knows when the usage resumed.

export const HISTORY_FILE = "usage-history.tsv";
export const RETENTION_MS = 35 * 86_400_000;
export const HEARTBEAT_MS = 60 * 60_000;
export const MIN_SPACING_MS = 5 * 60_000;
const MAX_PER_SERIES = 12_000;
const HOUR = 3_600_000;
/** Length of the fixed Claude/Codex windows; quota buckets (Antigravity) don't say how long theirs are. */
export const WINDOW_LENGTH: Record<string, number> = { fiveHour: 5 * HOUR, weekly: 7 * 24 * HOUR };

export type History = Map<string, UsageSample[]>;
/** One quota window of a provider: its id (fiveHour, weekly or a meter id) and current reading. */
export type QuotaWindow = { id: string; usage: WindowUsage };
export function quotaWindows(p: ProviderUsage): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  if (p.windows.fiveHour) out.push({ id: "fiveHour", usage: p.windows.fiveHour });
  if (p.windows.weekly) out.push({ id: "weekly", usage: p.windows.weekly });
  for (const m of p.meters ?? []) out.push({ id: m.id, usage: m });
  return out;
}
/** One subscription's quota window: provider, account fingerprint and window id (the same key as on the phone). */
export const historyKey = (p: ProviderUsage, windowId: string) => [p.id, p.account ?? "", windowId].join("|");

/** Current readings only: a provider in sign-in or unavailable state repeats its last sample, which is not a new one. */
export function readings(snapshot: Snapshot): [string, UsageSample][] {
  return snapshot.providers.filter(p => p.state === "ok" && p.sampledAt !== null).flatMap(p =>
    quotaWindows(p).filter(w => w.usage.resetsAt > p.sampledAt!).map(w => [historyKey(p, w.id), { at: p.sampledAt!, used: w.usage.usedPercent, resetsAt: w.usage.resetsAt }] as [string, UsageSample]));
}

/** Adds `snapshot`'s readings to `history` (in place); returns whether anything changed. */
export function addReadings(history: History, snapshot: Snapshot, now = Date.now()): boolean {
  let changed = false;
  for (const [key, sample] of readings(snapshot)) {
    const list = history.get(key) ?? []; history.set(key, list);
    const last = list.at(-1), before = list.at(-2);
    if (last && sample.at <= last.at) continue;
    const same = (s?: UsageSample) => !!s && s.used === sample.used && s.resetsAt === sample.resetsAt;
    if (last && same(last) && same(before) && sample.at - before!.at <= HEARTBEAT_MS) list[list.length - 1] = sample;
    // Changes closer than MIN_SPACING_MS to the last kept one wait for the next reading (the change is not lost, only its minute).
    else if (last && !same(last) && sample.resetsAt === last.resetsAt && sample.at - last.at < MIN_SPACING_MS) continue;
    else list.push(sample);
    changed = true;
  }
  for (const [key, list] of history) {
    const kept = list.filter(s => s.at >= now - RETENTION_MS).slice(-MAX_PER_SERIES);
    if (kept.length !== list.length) changed = true;
    if (kept.length) history.set(key, kept); else history.delete(key);
  }
  return changed;
}

export const formatHistory = (history: History) => [...history].flatMap(([key, list]) => list.map(s => `${key}\t${s.at}\t${s.used}\t${s.resetsAt}\n`)).join("");
/** Lines that don't parse are skipped: a damaged history only loses those readings. */
export function parseHistory(text: string): History {
  const out: History = new Map();
  for (const line of text.split("\n")) {
    const parts = line.split("\t"); if (parts.length !== 4) continue;
    const [key, at, used, resetsAt] = [parts[0]!, Number(parts[1]), Number(parts[2]), Number(parts[3])];
    if (!Number.isSafeInteger(at) || !Number.isSafeInteger(resetsAt) || !Number.isFinite(used) || used < 0 || used > 100) continue;
    out.set(key, [...out.get(key) ?? [], { at, used, resetsAt }]);
  }
  for (const list of out.values()) list.sort((a, b) => a.at - b.at);
  return out;
}

export function readHistory(directory = stateDirectory()): History {
  try { return parseHistory(readFileSync(join(directory, HISTORY_FILE), "utf8")); } catch { return new Map(); }
}
export function recordHistory(snapshot: Snapshot, now = Date.now(), directory = stateDirectory()) {
  const history = readHistory(directory);
  if (!addReadings(history, snapshot, now)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, HISTORY_FILE), temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, formatHistory(history), { mode: 0o600 }); renameSync(temporary, target);
}
export const clearHistory = (directory = stateDirectory()) => rmSync(join(directory, HISTORY_FILE), { force: true });

export type WindowForecast = { provider: string; key: string; windowId: string; forecast: Forecast | null; actual: UsageSample[]; windowStart: number | null };
/**
 * The forecast of every current quota window in `snapshot`, with the current window's readings for a chart. Stale and
 * sign-in-needed providers get none (no forecast from old data, as everywhere else).
 */
export function forecasts(snapshot: Snapshot, history: History, now = Date.now(), staleMs = 5 * 60_000): WindowForecast[] {
  return snapshot.providers.filter(p => p.state === "ok" && p.sampledAt !== null && now - p.sampledAt <= staleMs).flatMap(p =>
    quotaWindows(p).filter(w => w.usage.resetsAt > now).map(w => {
      const key = historyKey(p, w.id), length = WINDOW_LENGTH[w.id] && !p.meters?.some(m => m.id === w.id) ? WINDOW_LENGTH[w.id]! : null;
      const series = history.get(key) ?? [];
      const f = forecast(series, p.sampledAt!, w.usage.usedPercent, w.usage.resetsAt, length);
      const windowStart = length === null ? null : w.usage.resetsAt - length;
      const actual = f ? [...series.filter(s => Math.abs(s.resetsAt - f.resetsAt) <= 20 * 60_000 && s.at < f.from && (windowStart === null || s.at >= windowStart)),
        { at: f.from, used: f.used, resetsAt: f.resetsAt }] : [];
      return { provider: p.id, key, windowId: w.id, forecast: f, actual, windowStart };
    }));
}

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", fiveHour: "5-hour", weekly: "Weekly" };
/** `meterkat forecast`: one line per window, "Claude · Weekly: 74% used at the reset (likely 66–82%) · learned from 21d of history". */
export function forecastLines(snapshot: Snapshot, history: History, now = Date.now()): string[] {
  const clock = (at: number) => new Date(at).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const lines = forecasts(snapshot, history, now).map(({ provider, windowId, forecast: f }) => {
    const p = snapshot.providers.find(x => x.id === provider);
    const name = `${NAMES[provider] ?? provider} · ${NAMES[windowId] ?? p?.meters?.find(m => m.id === windowId)?.label ?? windowId}`;
    if (!f) return `${name}: no forecast yet (needs a few readings)`;
    const verdict = f.runsOutAt !== null
      ? `runs out around ${clock(f.runsOutAt)} (likely ${clock(f.runsOutEarliest ?? f.runsOutAt)} to ${f.runsOutLatest !== null ? clock(f.runsOutLatest) : "the reset"})`
      : `${Math.round(f.atReset)}% used at the reset ${clock(f.resetsAt)} (likely ${Math.round(f.low)}–${Math.round(f.high)}%)`;
    const days = (f.from - f.since) / 86_400_000;
    const basis = !f.learned ? "still learning, follows the window's pace" : f.model.pace ? "follows the pace (history did not predict better)"
      : `learned from ${days >= 2 ? `${Math.floor(days)}d` : `${Math.max(1, Math.floor(days * 24))}h`} of history${f.typicalError === null ? "" : `, past forecasts missed by ${Math.round(f.typicalError) === 0 ? "less than 1 point" : `${Math.round(f.typicalError)} points`} (median)`}`;
    return `${name}: ${verdict} · ${basis}`;
  });
  return lines.length ? lines : ["No current readings to forecast from."];
}
