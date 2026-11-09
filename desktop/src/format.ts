// Formatting shared by the window and the tray menu; pure, so it is unit-tested.
import type { ProviderUsage, Snapshot, WindowUsage } from "../../shared/snapshot.js";
import { PROVIDER_GLYPHS } from "./provider-glyphs.js";
import type { Forecast, UsageSample } from "../../src/forecast.js";

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

const HOUR = 3_600_000, DAY = 24 * HOUR;
/** Length of the fixed Claude/Codex windows; quota buckets (Antigravity) don't say how long theirs are. */
export const WINDOW_MS = { fiveHour: 5 * HOUR, weekly: 7 * DAY };

export type Bar = { label: string; usedPercent: number; resetsAt: number; windowMs?: number };
/** The bars a provider shows: its five-hour and weekly windows, or its quota buckets (Antigravity). */
export function bars(provider: ProviderUsage): Bar[] {
  const windows: [string, WindowUsage | undefined, number][] = [["5-hour", provider.windows.fiveHour, WINDOW_MS.fiveHour], ["Weekly", provider.windows.weekly, WINDOW_MS.weekly]];
  const result: Bar[] = windows.filter((w): w is [string, WindowUsage, number] => !!w[1]).map(([label, w, windowMs]) => ({ label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, windowMs }));
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

/** What the bars show, the "Used" / "Left" setting. Stored as "remaining" for older settings files. */
export type BarMode = "used" | "remaining";
/** The share a bar shows in `mode`, clamped to 0–100. */
export const shownPercent = (usedPercent: number, mode: BarMode) => Math.min(100, Math.max(0, mode === "remaining" ? 100 - usedPercent : usedPercent));
/** The word after a percentage: "42% used", "58% left". */
export const unitWord = (mode: BarMode) => mode === "remaining" ? "left" : "used";

/** Compact like the Android app: "45m", "2h 10m", "3d 4h"; rounded up to whole minutes, never negative. */
export function duration(ms: number) {
  const minutes = Math.ceil(Math.max(0, ms) / 60_000), hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

/** "just now", "15m ago", "2h ago", "3d ago": one unit is enough for an age. */
export function ago(at: number, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  return minutes < 60 ? `${minutes}m ago` : minutes < 24 * 60 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function resetText(resetsAt: number, now = Date.now()) {
  return resetsAt <= now ? "Updating" : `Resets in ${duration(resetsAt - now)}`;
}

type Clock = { locale?: string; timeZone?: string };
/** The reset as a clock time, "14:30"; with the weekday ("Sat 09:41") when it is a day or more away. */
export function resetClock(resetsAt: number, now = Date.now(), { locale, timeZone }: Clock = {}) {
  const weekday = resetsAt - now >= DAY ? { weekday: "short" } as const : {};
  return new Intl.DateTimeFormat(locale, { ...weekday, hour: "numeric", minute: "2-digit", timeZone }).format(resetsAt).replace(",", "");
}
/** "Resets in 2h 10m · 14:30", or "Updating" once the window has reset and the next sync is still due. */
export const resetLine = (resetsAt: number, now = Date.now(), clock: Clock = {}) =>
  resetsAt <= now ? "Updating" : `${resetText(resetsAt, now)} · ${resetClock(resetsAt, now, clock)}`;

// ---- Pace: does the quota last until its reset? (docs/design/ui-v2.md, same model as the Android app) ----------

/** Share of the window that has passed, 0–1; null when its length is unknown or it has reset. */
export function elapsed(bar: Bar, now = Date.now()) {
  if (!bar.windowMs || bar.resetsAt <= now) return null;
  return Math.min(1, Math.max(0, 1 - (bar.resetsAt - now) / bar.windowMs));
}
/** Where the elapsed tick sits on a bar in `mode`, 0–100: a used bar fills up towards it, a left bar drains towards it. */
export function tickPercent(bar: Bar, mode: BarMode, now = Date.now()) {
  const share = elapsed(bar, now);
  return share === null ? null : mode === "remaining" ? 100 - share * 100 : share * 100;
}

/** "tight": the forecast runs out just before the reset, within the margin of the forecast; neutral, not a warning. */
export type PaceState = "limit" | "fast" | "low" | "tight" | "ok";
export type Pace = { state: PaceState; /** ms until the quota is used up at the current rate */ runsOutIn: number | null; untilReset: number };
/** Above this share used a quota is "Running low" when the pace has nothing more urgent to say. */
export const LOW_PERCENT = 80;
/**
 * The verdict under a bar. Null while there is nothing to say: too early in the window (< 3 %), unknown length, or
 * already reset; "low" fills in from 80 % used whenever there is no fast or limit verdict (quota buckets, early on).
 */
export function pace(bar: Bar, now = Date.now()): Pace | null {
  if (bar.resetsAt <= now) return null;
  const untilReset = bar.resetsAt - now;
  if (bar.usedPercent >= 100) return { state: "limit", runsOutIn: 0, untilReset };
  const share = elapsed(bar, now);
  let verdict: Pace | null = null;
  if (share !== null && share >= 0.03) {
    const runsOutIn = bar.usedPercent > 0 ? (100 - bar.usedPercent) / (bar.usedPercent / (share * bar.windowMs!)) : null;
    // Only a clear early run-out is a warning: one within the margin of the reset is noise of the forecast.
    const margin = Math.max(15 * 60_000, 0.03 * bar.windowMs!);
    const state = runsOutIn === null || runsOutIn >= untilReset ? "ok" : runsOutIn < untilReset - margin ? "fast" : "tight";
    verdict = { state, runsOutIn, untilReset };
  }
  return verdict?.state !== "fast" && bar.usedPercent >= LOW_PERCENT ? { state: "low", runsOutIn: verdict?.runsOutIn ?? null, untilReset } : verdict;
}
/** "Limit reached", "Runs out in 1h 20m" (`long`: ", 50m before reset"), "Running low", "Cutting it close", "On pace". */
export function paceText(p: Pace, long = false) {
  if (p.state === "limit") return "Limit reached";
  if (p.state === "low") return "Running low";
  if (p.state === "ok") return "On pace";
  if (p.state === "tight") return long ? "Cutting it close: may run out just before the reset" : "Cutting it close";
  return `Runs out in ${duration(p.runsOutIn!)}${long ? `, ${duration(p.untilReset - p.runsOutIn!)} before reset` : ""}`;
}
/** For the Tightest line, which adds what the row below does not say: "Runs out around Fri 11:40 AM" (same clock as resets). */
export const runOutText = (p: Pace, now = Date.now(), clock: Clock = {}) =>
  p.state === "fast" ? `Runs out around ${resetClock(now + p.runsOutIn!, now, clock)}` : paceText(p);
/** Verdicts that warn (and widen the island pill): limit, fast and low; "On pace" and "Cutting it close" do not. */
export const paceWarns = (p: Pace | null) => p?.state === "limit" || p?.state === "fast" || p?.state === "low";
/** ▲ goes with every warning verdict, so the colour is never the only sign. */
export const paceGlyph = (p: Pace | null) => p?.state === "fast" || p?.state === "low";
/** Emphasis for a row's number: "bad" at the limit, "warn" when it runs out early or is running low. */
export function level(bar: Bar, p: Pace | null): "bad" | "warn" | "" {
  if (p?.state === "limit" || bar.usedPercent >= 100) return "bad";
  return p?.state === "fast" || p?.state === "low" || bar.usedPercent >= LOW_PERCENT ? "warn" : "";
}

/** Data older than this is stale even when the provider still reports "ok": no forecast is made from it. */
export const STALE_MS = 5 * 60_000;
/** True while a provider's numbers are current enough for a pace verdict and the Tightest summary. */
export const fresh = (p: ProviderUsage, now = Date.now()) => p.state === "ok" && (p.sampledAt === null || now - p.sampledAt <= STALE_MS);
export type Headline = {
  /** Why it was picked: "Runs out first", "Running low", "Limit reached", "Most used"; "Last known" for old data. */
  label: string; tone: "fast" | "low" | "limit" | ""; glyph: boolean;
  /** "Claude · Weekly" */ title: string;
  /** The detail line: an optional coloured lead ("Runs out around Fri 10:26 AM", "On pace") and the muted rest. */
  lead: string; rest: string;
  /** The region's accessible name: "Runs out first: Claude Weekly, 67% used". */ name: string;
};
/** The headline above the cards (and in the island panel): reason, provider and window, then the detail. */
export function headline(t: Tightest, mode: BarMode, now = Date.now(), clock: Clock = {}, headerAgeText: string | null = null): Headline {
  const { provider, bar, pace: p, lastKnown, reason } = t, at = resetClock(bar.resetsAt, now, clock);
  const title = `${providerName(provider.id)} · ${bar.label}`;
  const value = `${percent(shownPercent(bar.usedPercent, mode))} ${unitWord(mode)}`;
  const label = lastKnown !== null ? "Last known" : reasonLabel(reason);
  const tone = lastKnown !== null || reason === "most" ? "" : reason;
  // The header's "All stale · 15m ago" already gives the age: the headline repeats it only when its own sample is older than that reading.
  const [lead, rest] = lastKnown !== null ? ["", ago(lastKnown, now) === headerAgeText ? `resets ${at}` : `${ago(lastKnown, now)} · resets ${at}`]
    : p?.state === "fast" ? [runOutText(p, now, clock), `resets ${at}`]
    : p?.state === "ok" || p?.state === "tight" ? [paceText(p), `resets ${at}`]
    : ["", `${resetText(bar.resetsAt, now)} · ${at}`];
  return { label, tone, glyph: tone === "fast" || tone === "low", title, lead, rest, name: `${label}: ${providerName(provider.id)} ${bar.label}, ${value}` };
}

/** "Sign-in needed · 2h ago", "Stale · 15m ago", "Unavailable"; null while the data is current. */
export function staleLabel(p: ProviderUsage, now = Date.now()) {
  if (fresh(p, now)) return null;
  const age = p.sampledAt ? ` · ${ago(p.sampledAt, now)}` : "";
  return p.state === "auth_required" ? `Sign-in needed${age}` : p.sampledAt ? `Stale${age}` : "Unavailable";
}
/**
 * The chip on a provider's row: `staleLabel`, without its age when the header already gives that very age for every shown provider (all of
 * them not current, all read at the same time: "All stale · 15m ago" and then plain "Stale" / "Sign-in needed" chips). Ages that differ, or a
 * header without an age (one provider stale among current ones), keep it on the chip. Window and island panel share it.
 */
export function chipLabel(p: ProviderUsage, shown: ProviderUsage[], syncedAt: number, now = Date.now()) {
  const label = staleLabel(p, now);
  if (!label || shown.some(q => fresh(q, now))) return label;
  const header = ago(Math.max(0, ...shown.map(q => q.sampledAt ?? 0)) || syncedAt, now);
  return shown.every(q => q.sampledAt && ago(q.sampledAt, now) === header) ? label.replace(/ · .*$/, "") : label;
}
/** True when the provider's data is not current because it needs a sign-in (the chip says "Sign-in needed"), not merely old. */
const needsSignIn = (p: ProviderUsage) => p.state === "auth_required";
/**
 * The header's note on what is not current, in the chips' words: "Codex sign-in needed" / "Codex stale" for one provider,
 * "2 stale", "2 need sign-in" or (a mix) "2 need attention" for several; null while all are current.
 */
export function staleSummary(providers: ProviderUsage[], now = Date.now()) {
  const stale = providers.filter(p => !fresh(p, now));
  if (stale.length === 0) return null;
  if (stale.length === 1) return `${providerName(stale[0]!.id)} ${needsSignIn(stale[0]!) ? "sign-in needed" : "stale"}`;
  return `${stale.length} ${stale.every(needsSignIn) ? "need sign-in" : stale.some(needsSignIn) ? "need attention" : "stale"}`;
}
/**
 * The header's freshness text. All current: "Updated just now", only then. Some not current: just the problem, in the chips' words
 * ("Codex sign-in needed", "2 need attention"; no "others …" clause, which made the line too long for the room beside "Sync now").
 * None current: "All stale · 15m ago" (the newest reading; all needing sign-in: "All need sign-in", mixed: "All need attention";
 * one provider: "Claude stale · 15m ago").
 */
export function headerStatus(providers: ProviderUsage[], syncedAt: number, now = Date.now()) {
  const stale = staleSummary(providers, now);
  if (!stale) return `Updated ${ago(syncedAt, now)}`;
  const age = headerAge(providers, syncedAt, now);
  return age === null ? stale : `${providers.length > 1 ? stale.replace(/^\d+ /, "All ") : stale} · ${age}`;
}
/** The age the header names while no provider is current ("15m ago": the newest reading); null when it names none. The headline then leaves its own age out. */
export function headerAge(providers: ProviderUsage[], syncedAt: number, now = Date.now()) {
  if (staleSummary(providers, now) === null || providers.some(p => fresh(p, now))) return null;
  return ago(Math.max(0, ...providers.map(p => p.sampledAt ?? 0)) || syncedAt, now);
}
/** What a stale or sign-in row says in the slot where a current row says "On pace": its last sample was at or past the low threshold. Muted, no ▲, never in the headline or the ranking. */
export const LOW_LAST_SEEN = "Low when last seen";
export const lowWhenLastSeen = (p: ProviderUsage, bar: Bar, now = Date.now()) => !fresh(p, now) && bar.resetsAt > now && bar.usedPercent >= LOW_PERCENT ? LOW_LAST_SEEN : null;
/** The island panel's freshness note, the window's words: `headerStatus` over the shown providers, `warn` while any of them is not current. */
export function panelStatus(snapshot: Snapshot, now = Date.now()) {
  const shown = providerGroups(snapshot).shown;
  return { text: headerStatus(shown, snapshot.generatedAt, now), warn: staleSummary(shown, now) !== null };
}
/** Settings > Island > Position: the two segments and the secondary text that follows the selection (it describes the choice made, as the radiogroup's description). */
export const ISLAND_ANCHORS = { screen: "Top of screen", window: "AI app" } as const;
export const islandAnchorHelp = (anchor: keyof typeof ISLAND_ANCHORS) => anchor === "window"
  ? "Follows the Claude, Codex or Antigravity window in front"
  : "Centred at the top of the screen";
/** The key to the elapsed tick: one sentence on every surface (window, island panel, Settings); a "left" bar drains, so the tick then marks the time still ahead. */
export const tickLegend = (mode: BarMode) => `The tick marks the time ${mode === "remaining" ? "left" : "passed"} in each window.`;
/** How to read a bar against the key (Settings shows it under the key as secondary text); a "left" bar stays short of the tick instead of running ahead of it. */
export const tickRead = (mode: BarMode) => mode === "remaining"
  ? "A bar short of the tick runs out before the reset."
  : "A bar ahead of the tick runs out before the reset.";
/** The tooltip on the key and on the bars: the key plus how to read a bar against it. */
export const tickHint = (mode: BarMode) => `${tickLegend(mode)} ${tickRead(mode)}`;
/** "No forecast" next to a provider whose quotas have no known window length; `noPaceHint` is the whole sentence. */
export const noPaceHint = "No forecast: this provider doesn't say how long its quota windows are";
/** `lastKnown`: when no provider is current, the tightest quota of the last known data and when it was read. */
export type Tightest = { provider: ProviderUsage; bar: Bar; pace: Pace | null; lastKnown: number | null; reason: TightestReason };
/** Why a quota is the tightest, from the numbers as they are (also for last known data). */
export type TightestReason = "limit" | "fast" | "low" | "most";
/** The headline's first words say why it was picked: "Runs out first", "Limit reached", "Running low", "Most used". */
export const reasonLabel = (reason: TightestReason) => ({ limit: "Limit reached", fast: "Runs out first", low: "Running low", most: "Most used" })[reason];
/**
 * Order of urgency, the same as the Android app's: a reached limit, then running out before the reset (earliest first),
 * then running low (80 % or more used), then the highest used share.
 */
export function urgency(bar: Bar, p: Pace | null) {
  if (p?.state === "limit") return 4e6;
  if (p?.state === "fast") return 3e6 - Math.min(p.runsOutIn! / 60_000, 1e6 - 1);
  if (p?.state === "low") return 2e6 + bar.usedPercent;
  return bar.usedPercent;
}
/**
 * The quota closest to running out. Only current data counts while there is any; with none, the last known data
 * stands in. Both are ranked alike (the pace model on the numbers as they are), but old data carries no verdict.
 */
export function tightest(snapshot: Snapshot | null, now = Date.now()): Tightest | null {
  const pick = (providers: ProviderUsage[], current: boolean) => providers
    .flatMap(provider => bars(provider).filter(bar => bar.resetsAt > now).map(bar => {
      const p = pace(bar, now);
      const reason: TightestReason = p?.state === "limit" || p?.state === "fast" || p?.state === "low" ? p.state : "most";
      return { provider, bar, rank: urgency(bar, p), reason, pace: current ? p : null, lastKnown: current ? null : provider.sampledAt ?? snapshot!.generatedAt };
    }))
    .reduce<(Tightest & { rank: number }) | null>((best, next) => !best || next.rank > best.rank ? next : best, null);
  const shown = providerGroups(snapshot).shown;
  const best = pick(shown.filter(p => fresh(p, now)), true) ?? pick(shown.filter(p => !fresh(p, now)), false);
  if (!best) return null;
  const { rank: _rank, ...tight } = best;
  return tight;
}

/** A current window that is at risk: low, at its limit, or forecast to run out before its reset (the ▲ verdicts, see `paceWarns`). */
export type AtRisk = { provider: ProviderUsage; bar: Bar; pace: Pace };
/**
 * Every OTHER current window that is at risk, in list order: one rule for the headline card's footer, the island's row
 * highlights and its scroll cue. Empty when the headline is old data.
 */
export function atRiskRows(snapshot: Snapshot | null, tight: Tightest, now = Date.now()): AtRisk[] {
  if (tight.lastKnown !== null) return [];
  return providerGroups(snapshot).shown.filter(p => fresh(p, now)).flatMap(provider => bars(provider)
    .filter(bar => bar.resetsAt > now && !(provider.id === tight.provider.id && bar.label === tight.bar.label))
    .map(bar => ({ provider, bar, pace: pace(bar, now) }))
    .filter((o): o is AtRisk => paceWarns(o.pace)));
}
/** Time until a window is in trouble: when it runs out (0 at its limit); a low window without an early run-out is in trouble until its reset. */
export const troubleIn = (p: Pace) => p.state === "fast" ? p.runsOutIn! : p.state === "limit" ? 0 : p.untilReset;
/** The footer's entries, most pressing first, so the one that would hide behind "+N more" is the least urgent. */
export const alsoAtRisk = (snapshot: Snapshot | null, tight: Tightest, now = Date.now()): AtRisk[] =>
  atRiskRows(snapshot, tight, now).sort((a, b) => troubleIn(a.pace) - troubleIn(b.pace));
/** The footer line's label, the same on every surface. */
export const ALSO_AT_RISK = "Also at risk";
/** How many entries the footer line names in full before it counts the rest ("+1 more"). */
export const ALSO_MAX = 1;
/**
 * One footer entry. `alert` is the coloured part: "▲ 88% used" (low, at its limit) or "▲ runs out in 1d 21h" (forecast);
 * `rest` follows it, muted ("resets in 50m"; empty for a forecast, which already says when). `title` is the entry in full
 * ("Antigravity · Claude models ▲ 88% used · resets in 50m"), which names it in the tooltip of "+N more".
 */
export type AlsoEntry = { provider: string; name: string; alert: string; rest: string; state: Pace["state"]; title: string; spoken: string };
export function alsoEntry(r: AtRisk, mode: BarMode, now = Date.now()): AlsoEntry {
  const provider = providerName(r.provider.id), p = r.pace;
  const value = `${percent(shownPercent(r.bar.usedPercent, mode))} ${unitWord(mode)}`;
  const forecast = p.state === "fast";
  const alert = `▲ ${forecast ? `runs out in ${duration(p.runsOutIn!)}` : value}`;
  const reset = resetText(r.bar.resetsAt, now).replace(/^Resets/, "resets");
  const name = `${provider} · ${r.bar.label}`, rest = forecast ? "" : reset;
  return {
    provider: r.provider.id, name, alert, rest, state: p.state, title: `${name} ${alert}${rest ? ` · ${rest}` : ""}`,
    spoken: `${provider} ${r.bar.label}, ${forecast ? `runs out in ${duration(p.runsOutIn!)}, ${reset}` : `${value}, ${reset}`}`,
  };
}
/** "+1 more": what the footer says for the entries it does not name; the same words on every surface. */
export const alsoMore = (n: number) => `+${n} more`;
/**
 * The line: the label and the most pressing entry in full ("Antigravity · Claude models ▲ 88% used · resets in 50m"); with several
 * entries without its reset ("Antigravity · Claude models ▲ 88% used · +1 more"). `hidden` names those (tooltip) and `spoken` reads every entry out.
 */
export function alsoLine(rows: AtRisk[], mode: BarMode, now = Date.now()) {
  const entries = rows.map(r => alsoEntry(r, mode, now));
  const hidden = entries.slice(ALSO_MAX);
  // With "+N more" the line stays one line: the named entry drops its reset part (it stays in the card, the tooltips and the spoken text).
  return { label: ALSO_AT_RISK, entries: entries.slice(0, ALSO_MAX).map(e => hidden.length ? { ...e, rest: "" } : e), more: hidden.length,
    hidden: hidden.map(e => e.title).join("; "),
    /** The provider whose card "+N more" scrolls to: the next at-risk entry. */
    next: hidden[0]?.provider ?? null,
    /** What "+N more" is called for assistive technology: it names the hidden entries and says what it does. */
    moreName: hidden.length ? `${alsoMore(hidden.length)}: ${hidden.map(e => e.spoken).join("; ")}. Show the ${hidden[0]!.name.replace(/ · .*$/, "")} card` : "",
    spokenShown: `${ALSO_AT_RISK}: ${entries.slice(0, ALSO_MAX).map(e => e.spoken).join("; ")}`,
    spoken: `${ALSO_AT_RISK}: ${entries.map(e => e.spoken).join("; ")}` };
}
/**
 * The island's scroll cue when at-risk rows sit below the fold: it names them ("▲ Antigravity low ↓"), or counts the
 * rows when several ("▲ 2 at risk below ↓"). Null when none is below; the cue then counts providers instead.
 */
export function lowBelowCue(rows: { provider: string; state: "low" | "limit" | "fast" }[]): string | null {
  if (rows.length === 0) return null;
  if (rows.length === 1) return `▲ ${rows[0]!.provider} ${({ limit: "at its limit", fast: "runs out early", low: "low" })[rows[0]!.state]} ↓`;
  return `▲ ${rows.length} at risk below ↓`;
}

/** True when none of a provider's quotas has a known window length (quota buckets): no elapsed mark, no forecast. */
export const paceUnknown = (p: ProviderUsage) => { const all = bars(p); return all.length > 0 && all.every(b => !b.windowMs); };

/** A failed sync in words: what went wrong for people, and how old the numbers on screen are. */
export function syncProblem(error: string, relay: string | null, dataAt: number | null, now = Date.now()) {
  const network = /unreachable|network|fetch failed|timed? ?out|ENOTFOUND|ECONN|EAI_AGAIN|offline/i.test(error);
  const hosted = !!relay && /(^|\.)meterkat[^/]*\.fabian-duerkop\.de$/i.test(new URL(relay).hostname);
  const what = network ? `Can't reach ${hosted ? "the Meterkat relay" : "your relay"}.` : "Couldn't send your quota to your phone.";
  const age = dataAt === null ? "" : ago(dataAt, now);
  return age && age !== "just now" ? `${what} Showing data from ${age}.` : what;
}

/** One line per provider for the tray: its most used window by name, "Claude · Weekly: 81% used" (or what is left). */
export function trayLines(snapshot: Snapshot | null, mode: BarMode = "used", now = Date.now()): string[] {
  const { shown, notSetUp } = providerGroups(snapshot);
  return [...shown.map(p => {
    // A window whose reset has passed has no number until the next sample.
    const current = bars(p).filter(b => b.resetsAt > now);
    const highest = current.reduce<Bar | null>((max, b) => max === null || b.usedPercent > max.usedPercent ? b : max, null);
    if (p.state === "auth_required") return `${providerName(p.id)}: sign-in needed`;
    if (highest === null) return `${providerName(p.id)}: ${bars(p).length ? "updating" : "no data"}`;
    return `${providerName(p.id)} · ${highest.label}: ${percent(shownPercent(highest.usedPercent, mode))} ${unitWord(mode)}${fresh(p) ? "" : " (stale)"}`;
  }), ...notSetUp.map(id => `${providerName(id)}: not set up`)];
}

// ---- Forecast from this computer's history (docs/forecast.md, same model as the Android app) --------------------

/** "less than 1 point", "1 point", "4 points". */
const missed = (points: number) => { const n = Math.round(points); return n === 0 ? "less than 1 point" : `${n} point${n === 1 ? "" : "s"}`; };
/** What a forecast row says: the number at the reset, the verdict, the likely range and what it is based on. */
export type ForecastText = { value: number; tone: "bad" | "warn" | ""; verdict: string; range: string | null; basis: string; spoken: string };
export function forecastText(f: Forecast, mode: BarMode, now = Date.now(), clock: Clock = {}): ForecastText {
  const at = (t: number) => resetClock(t, now, clock);
  const shown = (used: number) => percent(shownPercent(used, mode));
  const out = f.runsOutAt !== null && f.used < 100;
  const verdict = f.used >= 100 ? "Limit reached" : out ? `Runs out around ${at(f.runsOutAt!)}` : `Expected at the reset · ${at(f.resetsAt)}`;
  const range = f.used >= 100 ? null
    : out ? (f.runsOutLatest !== null ? `Likely between ${at(f.runsOutEarliest ?? f.runsOutAt!)} and ${at(f.runsOutLatest)}` : `Earliest ${at(f.runsOutEarliest ?? f.runsOutAt!)}, may last until the reset`)
    : [`Likely ${shown(mode === "remaining" ? f.high : f.low)} to ${shown(mode === "remaining" ? f.low : f.high)}`, f.runsOutEarliest !== null ? `may run out from ${at(f.runsOutEarliest)}` : ""].filter(Boolean).join(" · ");
  const span = f.from - f.since, history = span >= 2 * DAY ? `${Math.floor(span / DAY)}d` : `${Math.max(1, Math.floor(span / HOUR))}h`;
  const basis = !f.learned && f.model.pace ? `Still learning your rhythm (${history} of history so far). Until then this follows the window's pace.`
    : !f.learned ? `Still learning your rhythm (${history} of history so far): a rough estimate.`
    : f.model.pace ? "Your history didn't predict this quota better than its average pace so far, so this follows the pace."
    : `Learned from ${history} of history${f.typicalError === null ? "" : ` · past forecasts missed by ${missed(f.typicalError)} (median of ${f.checks})`}`;
  const value = shownPercent(f.atReset, mode);
  return { value, tone: f.used >= 100 ? "bad" : out ? "warn" : "", verdict, range, basis,
    spoken: [`${percent(value)} ${unitWord(mode)} expected at the reset`, verdict, range ?? ""].filter(Boolean).join(", ") };
}

/**
 * The window from its start to its reset as SVG: used so far (solid), the expected path (dashed) inside its likely range
 * (shaded), the limit (dashed; top for Used, bottom for Left), a hairline at the latest reading and a dot where the expected
 * path reaches the limit. Colours come from CSS (the CSP allows no style attributes).
 */
export function forecastChart(f: Forecast, actual: UsageSample[], windowStart: number | null, mode: BarMode) {
  const W = 400, H = 100, pad = 4;
  const start = windowStart ?? Math.min(actual[0]?.at ?? f.from, f.from - (f.resetsAt - f.from) / 4), span = Math.max(1, f.resetsAt - start);
  const x = (t: number) => (Math.min(1, Math.max(0, (t - start) / span)) * W).toFixed(1);
  const y = (used: number) => (pad + (H - 2 * pad) * (mode === "remaining" ? used / 100 : 1 - used / 100)).toFixed(1);
  const line = (points: [number, number][]) => points.map(([t, v], i) => `${i ? "L" : "M"}${x(t)} ${y(v)}`).join(" ");
  const band = `${line(f.path.map(p => [p.at, p.high]))} ${[...f.path].reverse().map(p => `L${x(p.at)} ${y(p.low)}`).join(" ")} Z`;
  const dot = f.runsOutAt !== null && f.used < 100 ? `<circle class="fc-out" cx="${x(f.runsOutAt)}" cy="${y(100)}" r="3.5"/>` : "";
  return `<svg class="fc-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path class="fc-grid" d="M0 ${y(0)} H${W} M0 ${y(50)} H${W}"/><path class="fc-limit" d="M0 ${y(100)} H${W}"/>
    <path class="fc-band" d="${band}"/><path class="fc-expected" d="${line(f.path.map(p => [p.at, p.expected]))}"/>
    <path class="fc-actual" d="${line(actual.map(s => [s.at, s.used]))}"/><path class="fc-now" d="M${x(f.from)} ${pad} V${H - pad}"/>${dot}
  </svg>`;
}
