import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bin, evaluate, forecast, HOUR, MIN_CHECKS, PACE, widening, type UsageSample } from "../src/forecast.js";
import { addReadings, forecastLines, forecasts, formatHistory, HEARTBEAT_MS, HISTORY_FILE, parseHistory, readHistory, recordHistory, type History } from "../src/history.js";
import type { Snapshot } from "../shared/snapshot.js";

// The usage forecast on simulated users (same model and checks as the Android app's ForecastTest).
const DAY = 24 * HOUR, WEEK = 7 * DAY, FIVE = 5 * HOUR;
const utc = () => 0;
/** Monday 2027-01-04 00:00 UTC. */
const monday = 1_799_020_800_000;

/** A seeded generator (mulberry32), so the simulated users are the same on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/**
 * A simulated user read every minute in whole percent: weekday work blocks (9–12, 13–18) whose intensity varies from day to
 * day, some evenings, rare weekend sessions; Claude-like windows (a 5-hour window starts with the first use after the last
 * one ended; the weekly window resets Mondays 00:00 UTC). Readings every 15 minutes keep the tests fast.
 */
function simulate(seed: number, from: number, to: number) {
  const next = random(seed), level = new Map<number, number>();
  const rate = (t: number) => {
    const d = Math.floor(t / DAY), h = Math.floor((t % DAY) / HOUR), dow = (((d + 3) % 7) + 7) % 7;
    if (!level.has(d)) level.set(d, 0.5 + next() * 1.2);
    const base = dow >= 5 ? (h >= 15 && h <= 17 && d % 3 === 0 ? 0.8 : 0) : (h >= 9 && h <= 11) || (h >= 13 && h <= 17) ? 1 : h >= 20 && h <= 21 && d % 2 === 0 ? 0.7 : 0;
    return base * level.get(d)!;
  };
  const weekly: UsageSample[] = [], five: UsageSample[] = [];
  let weekUsed = 0, fiveUsed = 0, fiveReset = 0, weekReset = from - (from - monday) % WEEK + WEEK;
  for (let t = from; t < to;) {
    if (t >= weekReset) { weekReset += WEEK; weekUsed = 0; }
    if (fiveReset && fiveReset <= t) { fiveReset = 0; fiveUsed = 0; }
    const amount = rate(t) * 0.25 * (0.6 + next() * 0.8);
    if (amount > 0 && !fiveReset) fiveReset = t + FIVE;
    weekUsed = Math.min(100, weekUsed + amount * 1.6);
    if (fiveReset) fiveUsed = Math.min(100, fiveUsed + amount * 14);
    t += 15 * 60_000;
    weekly.push({ at: t, used: Math.round(weekUsed), resetsAt: weekReset });
    if (fiveReset > t) five.push({ at: t, used: Math.round(fiveUsed), resetsAt: fiveReset });
  }
  return { weekly, five };
}
/** Forecasts at many readings of the last two weeks for the last reading of their window: misses of the model and of the linear pace. */
function replay(samples: UsageSample[], length: number, from: number) {
  let model = 0, pace = 0, inside = 0, count = 0;
  const lastOf = new Map<number, UsageSample>(); for (const s of samples) lastOf.set(s.resetsAt, s);
  samples.filter(s => s.at >= from && s.used < 100).filter((_, i) => i % 7 === 0).forEach(origin => {
    const target = lastOf.get(origin.resetsAt)!; if (target.at - origin.at < HOUR) return;
    const f = forecast(samples.filter(s => s.at < origin.at), origin.at, origin.used, origin.resetsAt, length, utc)!;
    const point = f.path.reduce((a, b) => Math.abs(b.at - target.at) < Math.abs(a.at - target.at) ? b : a);
    const elapsed = origin.at - (origin.resetsAt - length);
    const linear = Math.min(100, origin.used / elapsed * (target.at - (origin.resetsAt - length)));
    model += Math.abs(point.expected - target.used); pace += Math.abs(linear - target.used); count++;
    if (target.used >= point.low - 1 && target.used <= point.high + 1) inside++;
  });
  return { model: model / count, pace: pace / count, coverage: inside / count };
}

test("weekly forecasts from history beat the linear pace and their range holds", () => {
  const { weekly } = simulate(7, monday - 35 * DAY, monday);
  const r = replay(weekly, WEEK, monday - 14 * DAY);
  assert(r.model < r.pace * 0.8, JSON.stringify(r));
  assert(r.coverage >= 0.6 && r.coverage <= 0.99, JSON.stringify(r));
});

test("five-hour forecasts from history beat the linear pace", () => {
  const { five } = simulate(11, monday - 21 * DAY, monday);
  const r = replay(five, FIVE, monday - 7 * DAY);
  assert(r.model < r.pace, JSON.stringify(r));
  assert(r.coverage >= 0.55 && r.coverage <= 0.98, JSON.stringify(r));
});

test("backtests choose a history model over the pace for a rhythmic user", () => {
  const { weekly } = simulate(3, monday - 35 * DAY, monday);
  const scores = evaluate(weekly, WEEK, monday, utc);
  const [best] = [...scores].sort((a, b) => a[1] - b[1])[0]!;
  assert(!best.pace);
  assert(scores.get(PACE)! > scores.get(best)!);
});

test("the weekend ahead lowers the forecast below the linear pace", () => {
  const { weekly } = simulate(5, monday - 28 * DAY, monday + 4 * DAY + 19 * HOUR);
  const now = weekly.at(-1)!;
  const f = forecast(weekly.slice(0, -1), now.at, now.used, now.resetsAt, WEEK, utc)!;
  const linear = now.used / (now.at - (now.resetsAt - WEEK)) * WEEK;
  assert(f.learned);
  assert(f.atReset < linear - 5, `${f.atReset} vs ${linear}`);
  assert(f.low <= f.atReset && f.atReset <= f.high);
  assert(f.checks >= MIN_CHECKS && f.typicalError !== null);
  f.path.forEach(p => assert(p.low <= p.expected + 1e-9 && p.expected <= p.high + 1e-9 && p.low >= now.used - 1e-9));
});

test("without history the forecast follows the pace, and nothing to go on means no forecast", () => {
  const f = forecast([], monday + 2 * DAY, 40, monday + WEEK, WEEK, utc)!;
  assert(!f.learned && f.model.pace && f.checks === 0);
  assert.equal(f.atReset, 100);
  assert(Math.abs(f.runsOutAt! - (monday + 5 * DAY)) <= HOUR);
  assert.equal(forecast([], monday, 10, monday + HOUR, null, utc), null);
  assert.equal(forecast([], monday, 10, monday, FIVE, utc), null);
  const limit = forecast([], monday, 100, monday + HOUR, FIVE, utc)!;
  assert.equal(limit.atReset, 100); assert.equal(limit.runsOutAt, monday);
});

test("a reset is not negative usage, and a window without a length is forecast from its history", () => {
  const old = Array.from({ length: 21 }, (_, i) => ({ at: monday + i * 15 * 60_000, used: 90 * i / 20, resetsAt: monday + 5 * HOUR }));
  const fresh = Array.from({ length: 5 }, (_, i) => ({ at: monday + 5 * HOUR + i * 15 * 60_000, used: 2, resetsAt: monday + 10 * HOUR }));
  const f = forecast([...old, ...fresh], monday + 6 * HOUR, 2, monday + 10 * HOUR, FIVE, utc)!;
  f.path.slice(1).forEach((p, i) => assert(p.expected >= f.path[i]!.expected - 1e-9));
  const meter = Array.from({ length: 40 }, (_, i) => ({ at: monday - 10 * HOUR + i * 15 * 60_000, used: i * 0.5, resetsAt: i < 20 ? monday - 5 * HOUR : monday + 3 * HOUR }));
  assert(forecast(meter, monday, 20, monday + 3 * HOUR, null, utc)!.atReset > 20);
});

test("hour of week follows the local clock, and few windows widen the range", () => {
  assert.equal(bin(monday, utc), 0);
  assert.equal(bin(monday, () => HOUR), 1);
  assert.equal(bin(monday - HOUR, utc), 167);
  assert(widening(5) > 1.25 && widening(5) < 1.4);
  assert(widening(60) < 1.05);
});

const account = "abcdefghijklmnopqrstuv";
const snapshot = (at: number, used: number, state: "ok" | "auth_required" = "ok", base = monday): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: at, providers: [
  { id: "claude", state, sampledAt: at, windows: { fiveHour: { usedPercent: used, resetsAt: base + 5 * HOUR }, weekly: { usedPercent: 40, resetsAt: base + 3 * DAY } }, account },
  { id: "antigravity", state, sampledAt: at, windows: {}, meters: [{ id: "gemini-pro", label: "Gemini Pro", usedPercent: 10, resetsAt: base + 4 * HOUR }] },
] });

test("history keeps changes, collapses quiet runs and spaces minute readings", () => {
  const history: History = new Map();
  for (let m = 0; m <= 60; m++) addReadings(history, snapshot(monday + m * 60_000, 10), monday);
  // A change one minute after the last kept reading waits for the five-minute spacing.
  addReadings(history, snapshot(monday + 61 * 60_000, 12), monday);
  addReadings(history, snapshot(monday + 66 * 60_000, 13), monday);
  const five = history.get(`claude|${account}|fiveHour`)!;
  assert.deepEqual(five.map(s => (s.at - monday) / 60_000), [0, 60, 66]);
  assert.deepEqual(five.map(s => s.used), [10, 10, 13]);
  assert(history.get("antigravity||gemini-pro")!.every((s, i, all) => i === 0 || s.at - all[i - 1]!.at <= HEARTBEAT_MS));
  // Sign-in needed repeats the last sample: not a new reading.
  assert(!addReadings(history, snapshot(monday + 70 * 60_000, 20, "auth_required"), monday));
  // Readings older than five weeks go.
  addReadings(history, snapshot(monday + 40 * DAY, 5, "ok", monday + 40 * DAY), monday + 40 * DAY);
  assert.deepEqual(history.get(`claude|${account}|fiveHour`)!.map(s => s.at), [monday + 40 * DAY]);
});

test("the history file round-trips, skips damaged lines and is private", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-history-"));
  try {
    recordHistory(snapshot(monday, 10), monday, dir);
    recordHistory(snapshot(monday + 10 * 60_000, 12), monday, dir);
    const read = readHistory(dir);
    assert.deepEqual(read.get(`claude|${account}|fiveHour`)!.map(s => s.used), [10, 12]);
    assert.deepEqual(parseHistory(formatHistory(read) + "x\t1\t2\nclaude||weekly\tnope\t1\t2\nclaude||weekly\t5\t101\t9\n"), read);
    if (process.platform !== "win32") assert.equal(statSync(join(dir, HISTORY_FILE)).mode & 0o777, 0o600);
    assert(!readFileSync(join(dir, HISTORY_FILE), "utf8").includes("Gemini Pro"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("forecasts cover every current window and say so in the CLI lines", () => {
  const { weekly, five } = simulate(13, monday - 28 * DAY, monday + 2 * DAY);
  const history: History = new Map([[`claude|${account}|weekly`, weekly.slice(0, -1)], [`claude|${account}|fiveHour`, five.slice(0, -1)]]);
  const w = weekly.at(-1)!, now = w.at;
  const snap: Snapshot = { schemaVersion: 1, sequence: 2, generatedAt: now, providers: [
    { id: "claude", state: "ok", sampledAt: now, windows: { weekly: { usedPercent: w.used, resetsAt: w.resetsAt } }, account },
    { id: "codex", state: "ok", sampledAt: now - 10 * 60_000, windows: { weekly: { usedPercent: 50, resetsAt: now + DAY } } },
  ] };
  const result = forecasts(snap, history, now);
  // Codex is stale: no forecast from old data.
  assert.deepEqual(result.map(r => r.key), [`claude|${account}|weekly`]);
  assert(result[0]!.forecast!.learned && result[0]!.actual.length > 1 && result[0]!.windowStart === w.resetsAt - WEEK);
  const lines = forecastLines(snap, history, now);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Claude · Weekly: .* · learned from \d+d of history/);
});
