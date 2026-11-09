// The usage forecast from this computer's history: the same model as the Meterkat Android app's Forecaster
// (docs/forecast.md). Pure, so it is unit-tested; the desktop app shows it, the CLI prints it (`meterkat forecast`).

/** One reading of a quota window: when, the share used, and when that window resets. */
export type UsageSample = { at: number; used: number; resetsAt: number };
/** A point of the forecast path: the expected share used and its likely range (10th to 90th percentile of past misses). */
export type ForecastPoint = { at: number; expected: number; low: number; high: number };
/**
 * A candidate. `persistence` (hours) is how long the current activity's difference from the usual rate lasts: 0 ignores it,
 * Infinity keeps it. `scale` (0–1) is how much the usual rate follows this window's busyness so far. `pace`: the linear
 * window-average forecast instead.
 */
export type Model = { persistence: number; scale: number; pace: boolean };
/**
 * Where one quota window is heading until its reset. `runsOutAt` is the expected run-out (null: it lasts), `runsOutEarliest` /
 * `runsOutLatest` its range (latest null: possibly not before the reset). `checks` past forecasts at a similar horizon gave the
 * range and `typicalError` (median miss in points); 0 checks: the range is a rough default. `learned`: there was enough
 * history for the hour-of-week profile; `since` is the oldest reading it comes from.
 */
export type Forecast = {
  from: number; used: number; resetsAt: number; atReset: number; low: number; high: number;
  runsOutAt: number | null; runsOutEarliest: number | null; runsOutLatest: number | null; path: ForecastPoint[];
  since: number; checks: number; typicalError: number | null; learned: boolean; model: Model;
};
/** Milliseconds to add to a UTC time for local time at that moment; the system time zone by default. */
export type Offset = (at: number) => number;
export const localOffset: Offset = at => -new Date(at).getTimezoneOffset() * 60_000;

export const HOUR = 3_600_000;
const DAY = 24 * HOUR, BINS = 168;
/** Two readings belong to the same window when their reset times agree within this. */
const SAME_WINDOW = 20 * 60_000;
/** A longer gap between two readings says too little about when the usage in it happened. */
const MAX_GAP = 12 * HOUR;
/** The current activity: what was used in this span before the forecast starts. */
const RECENT = 2 * HOUR;
/** Older weeks count less: a reading's weight halves every 14 days. */
const HALF_LIFE = 14 * DAY;
/** Shrinkage in observed hours: hour of week towards the weekday/weekend hour, that towards the hour of day, that towards the overall rate. */
const K_WEEK = 3, K_TYPE = 4, K_DAY = 6, K_ALL = 24;
/** Observed hours before the profile is used; below it the window's own pace decides. */
export const MIN_HISTORY_HOURS = 24;
/** Past forecasts needed before the range comes from them and before they choose the model. */
export const MIN_CHECKS = 12;
const MAX_ORIGINS_PER_WINDOW = 12, MAX_ORIGINS = 240;

export const PACE: Model = { persistence: 0, scale: 0, pace: true };
/** Used until backtests can choose: a moderate blend. */
export const DEFAULT: Model = { persistence: 2, scale: 0.5, pace: false };
/** Simpler candidates first: they win ties. */
export const CANDIDATES: Model[] = [...[0, 0.5, 1, 2, 4, 12, Infinity].flatMap(persistence => [0, 0.5, 1].map(scale => ({ persistence, scale, pace: false }))), PACE];

const floorMod = (a: number, b: number) => ((a % b) + b) % b;
/** Local hour of the week (Monday 0:00 = 0) of a local time in milliseconds. */
const localBin = (local: number) => floorMod(Math.floor(local / DAY) + 3, 7) * 24 + Math.floor(floorMod(local, DAY) / HOUR);
export const bin = (at: number, offset: Offset = localOffset) => localBin(at + offset(at));

/** What was used between two consecutive readings of one window; `window` numbers the windows in order. */
type Step = { from: number; to: number; amount: number; window: number };
type Window = { index: number; resetsAt: number; samples: UsageSample[] };
type Prepared = { windows: Window[]; steps: Step[]; byWindow: Map<number, Step[]> };

/**
 * Splits readings into windows (a new one starts when the reset time moves, the share used drops or the reset has passed)
 * and the usage between readings. A window at its limit is censored, its time says nothing about the rate.
 */
function prepare(samples: UsageSample[]): Prepared {
  const groups: UsageSample[][] = [];
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    const group = groups.at(-1), last = group?.at(-1);
    if (!last || Math.abs(s.resetsAt - last.resetsAt) > SAME_WINDOW || s.used < last.used - 1 || s.at >= last.resetsAt) groups.push([s]);
    else if (s.at > last.at) group!.push(s);
  }
  const windows = groups.map((list, index) => ({ index, resetsAt: list.at(-1)!.resetsAt, samples: list }));
  const steps: Step[] = [];
  for (const w of windows) for (let i = 1; i < w.samples.length; i++) {
    const a = w.samples[i - 1]!, b = w.samples[i]!;
    if (b.at - a.at <= MAX_GAP && a.used < 100) steps.push({ from: a.at, to: b.at, amount: Math.max(0, b.used - a.used), window: w.index });
  }
  const byWindow = new Map<number, Step[]>();
  for (const s of steps) byWindow.set(s.window, [...byWindow.get(s.window) ?? [], s]);
  return { windows, steps, byWindow };
}

/** Spreads the span [from, to) over the local clock hours it covers. */
function spread(from: number, to: number, offset: number, each: (bin: number, share: number, hours: number) => void) {
  let t = from + offset; const end = to + offset, total = to - from;
  while (t < end) {
    const next = Math.min(end, (Math.floor(t / HOUR) + 1) * HOUR);
    each(localBin(t), (next - t) / total, (next - t) / HOUR); t = next;
  }
}

/** Usage and observed hours per hour of week. Weights are relative to `reference` and renormalised to the forecast's start in `rates`. */
class Profile {
  amount = new Float64Array(BINS); hours = new Float64Array(BINS); raw = 0;
  constructor(private reference: number, private offset: Offset) {}
  add(s: Step) {
    const weight = 2 ** (((s.from + s.to) / 2 - this.reference) / HALF_LIFE);
    this.raw += (s.to - s.from) / HOUR;
    spread(s.from, s.to, this.offset(s.from), (b, share, h) => { this.amount[b]! += weight * s.amount * share; this.hours[b]! += weight * h; });
  }
  /** Rate per hour of week at `at`, shrunk level by level towards `prior` (share per hour) where little was observed. */
  rates(at: number, prior: number | null): Float64Array {
    const c = 2 ** ((this.reference - at) / HALF_LIFE);
    const a = this.amount.map(x => x * c), e = this.hours.map(x => x * c);
    const seen = e.reduce((x, y) => x + y, 0), total = a.reduce((x, y) => x + y, 0);
    const overall = prior !== null ? (total + K_ALL * prior) / (seen + K_ALL) : seen > 0 ? total / seen : 0;
    const pooled = (days: number[], h: number, k: number, toward: number) => {
      let x = 0, y = 0; for (const d of days) { x += a[d * 24 + h]!; y += e[d * 24 + h]!; } return (x + k * toward) / (y + k);
    };
    const hod = Array.from({ length: 24 }, (_, h) => pooled([0, 1, 2, 3, 4, 5, 6], h, K_DAY, overall));
    // Weekdays (Monday to Friday) and weekends get their own daily rhythm.
    const weekday = hod.map((v, h) => pooled([0, 1, 2, 3, 4], h, K_TYPE, v)), weekend = hod.map((v, h) => pooled([5, 6], h, K_TYPE, v));
    return Float64Array.from({ length: BINS }, (_, b) => (a[b]! + K_WEEK * (b / 24 < 5 ? weekday : weekend)[b % 24]!) / (e[b]! + K_WEEK));
  }
}

/** Where a forecast starts: the reading, its window, this window's busyness so far and the current activity. */
type Start = { at: number; used: number; windowStart: number | null; busy: number; recentAmount: number; recentHours: number; recentUsual: number };
function start(p: Prepared, rates: Float64Array, at: number, used: number, window: number, windowStart: number | null, offset: Offset): Start {
  const off = offset(at);
  // Busyness: what this window used so far against what the usual rates expected over the same observed hours.
  let actual = 0, expected = 0;
  for (const s of p.byWindow.get(window) ?? []) if (s.to <= at) { actual += s.amount; spread(s.from, s.to, off, (b, _, h) => { expected += rates[b]! * h; }); }
  // The current activity: usage in the last RECENT hours, from any window of this quota, against the usual rates.
  let amount = 0, hours = 0, usual = 0;
  let lo = 0, hi = p.steps.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (p.steps[mid]!.from < at) lo = mid + 1; else hi = mid; }
  for (let i = lo - 1; i >= 0 && p.steps[i]!.to > at - RECENT; i--) {
    const s = p.steps[i]!; if (s.to > at) continue;
    const from = Math.max(s.from, at - RECENT);
    amount += s.amount * (s.to - from) / (s.to - s.from); hours += (s.to - from) / HOUR;
    spread(from, s.to, off, (b, _, h) => { usual += rates[b]! * h; });
  }
  return { at, used, windowStart, busy: expected >= 1 ? Math.min(4, Math.max(0.25, actual / expected)) : 1, recentAmount: amount, recentHours: hours, recentUsual: usual };
}

/** Expected increase of the share used at each of `points` (ascending, after the start) under `model`. */
function increases(rates: Float64Array, s: Start, model: Model, points: number[], offset: Offset): number[] {
  const out = points.map(() => 0);
  if (model.pace) {
    if (s.windowStart === null) return out;
    const elapsed = (s.at - s.windowStart) / HOUR;
    return elapsed > 0 ? points.map(t => s.used / elapsed * (t - s.at) / HOUR) : out;
  }
  const factor = 1 - model.scale + model.scale * s.busy;
  // Difference of the current rate from the (scaled) usual one; nothing observed recently: no difference.
  const anomaly = s.recentHours >= 0.25 ? (s.recentAmount - factor * s.recentUsual) / s.recentHours : 0;
  const tau = model.persistence;
  const fade = (a: number, b: number) => tau <= 0 || anomaly === 0 ? 0 : !Number.isFinite(tau) ? anomaly * (b - a) : anomaly * tau * (Math.exp(-a / tau) - Math.exp(-b / tau));
  const off = offset(s.at), end = points.at(-1);
  if (end === undefined) return out;
  const maxStep = end - s.at <= 12 * HOUR ? 15 * 60_000 : HOUR;
  let t = s.at, sum = 0, index = 0;
  while (index < points.length) {
    const next = Math.min(points[index]!, (Math.floor((t + off) / HOUR) + 1) * HOUR - off, t + maxStep);
    const a = (t - s.at) / HOUR, b = (next - s.at) / HOUR;
    // A rate can't go below zero: a quiet spell doesn't give quota back.
    sum += Math.max(0, factor * rates[localBin(t + off)]! * (b - a) + fade(a, b));
    t = next;
    while (index < points.length && points[index]! <= t) out[index++] = sum;
  }
  return out;
}

/** The rate a window's own pace suggests: the profile's prior while history is short. */
function paceRate(at: number, used: number, windowStart: number | null): number | null {
  if (windowStart === null) return null;
  const hours = (at - windowStart) / HOUR;
  return hours >= 0.25 ? used / hours : null;
}

/** One past forecast in `window`: how far ahead it looked (hours) and how far it was off per candidate (forecast minus actual, points; NaN: not tried). */
type Case = { horizon: number; window: number; errors: number[]; profiled: boolean };

/**
 * Forecasts made at earlier readings for the last reading of the same window, each from the readings before it only (rolling
 * origin). At most MAX_ORIGINS_PER_WINDOW per window and MAX_ORIGINS overall, the most recent.
 */
function backtest(p: Prepared, length: number | null, reference: number, offset: Offset): Case[] {
  const origins = p.windows.filter(w => w.samples.length >= 2).flatMap(w => {
    const target = w.samples.at(-1)!;
    const candidates = w.samples.slice(0, -1).filter(s => target.at - s.at >= 10 * 60_000 && s.used < 100);
    const every = Math.max(1, Math.ceil(candidates.length / MAX_ORIGINS_PER_WINDOW));
    return candidates.filter((_, i) => i % every === 0).map(o => ({ w, o, target }));
  }).sort((a, b) => a.o.at - b.o.at).slice(-MAX_ORIGINS);
  const profile = new Profile(reference, offset); let next = 0;
  return origins.map(({ w, o, target }) => {
    while (next < p.steps.length && p.steps[next]!.to <= o.at) profile.add(p.steps[next++]!);
    const windowStart = length === null ? null : w.resetsAt - length;
    const rates = profile.rates(o.at, paceRate(o.at, o.used, windowStart));
    const s = start(p, rates, o.at, o.used, w.index, windowStart, offset);
    const profiled = profile.raw >= MIN_HISTORY_HOURS;
    const errors = CANDIDATES.map(model => (model.pace ? windowStart === null : !profiled) ? NaN
      : Math.min(100, Math.max(o.used, o.used + increases(rates, s, model, [target.at], offset)[0]!)) - target.used);
    return { horizon: (target.at - o.at) / HOUR, window: w.index, errors, profiled };
  });
}

/** Mean absolute error per candidate over the backtest cases where the profile had enough history (where the choice matters). */
function scores(cases: Case[]): Map<Model, number> {
  const out = new Map<Model, number>();
  const usable = cases.filter(c => c.profiled);
  if (usable.length < MIN_CHECKS) return out;
  CANDIDATES.forEach((m, i) => {
    const errors = usable.map(c => c.errors[i]!).filter(e => !Number.isNaN(e));
    if (errors.length >= MIN_CHECKS) out.set(m, errors.reduce((x, e) => x + Math.abs(e), 0) / errors.length);
  });
  return out;
}

/**
 * Misses within one window are alike, so the checks are worth about as much as the `windows` they come from: a weekly quota
 * with five weeks of history has five. The 10th to 90th percentile of so few understates the spread (it holds about
 * (n-1)/(n+1) of new cases), so the range is widened like a prediction interval from n samples: Student's t (Cornish-Fisher
 * approximation) with n-1 degrees of freedom times sqrt(1 + 1/n), relative to the normal quantile.
 */
export function widening(windows: number) {
  const n = Math.max(2, windows), v = n - 1, z = 1.2816;
  const t = z + (z ** 3 + z) / (4 * v) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * v * v);
  return t * Math.sqrt(1 + 1 / n) / z;
}

/**
 * The forecast for a window currently at `used` (read at `at`, resets at `resetsAt`) from its quota's `history`. `length` is
 * the window's length when known (5 hours, a week). Null when there is nothing to go on: no time left, or neither history nor
 * a known window length.
 */
export function forecast(history: UsageSample[], at: number, used: number, resetsAt: number, length: number | null, offset: Offset = localOffset): Forecast | null {
  if (resetsAt <= at) return null;
  const p = prepare([...history.filter(s => s.at < at), { at, used, resetsAt }]);
  const windowStart = length === null ? null : resetsAt - length;
  const profile = new Profile(at, offset); for (const s of p.steps) profile.add(s);
  const learned = profile.raw >= MIN_HISTORY_HOURS;
  const prior = paceRate(at, used, windowStart);
  const cases = backtest(p, length, at, offset);
  let best: Model | null = null, bestScore = Infinity;
  for (const [m, score] of scores(cases)) if (score < bestScore) { best = m; bestScore = score; }
  const model = best ?? (learned ? DEFAULT : prior !== null ? PACE : profile.raw > 0 ? DEFAULT : null);
  if (!model) return null;
  const since = p.windows[0]!.samples[0]!.at;
  if (used >= 100) return { from: at, used, resetsAt, atReset: 100, low: 100, high: 100, runsOutAt: at, runsOutEarliest: at, runsOutLatest: at,
    path: [{ at, expected: 100, low: 100, high: 100 }, { at: resetsAt, expected: 100, low: 100, high: 100 }], since, checks: 0, typicalError: null, learned, model };

  const rates = profile.rates(at, prior);
  const s = start(p, rates, at, used, p.windows.at(-1)!.index, windowStart, offset);
  const count = 48;
  const points = Array.from({ length: count }, (_, i) => at + Math.floor((resetsAt - at) * (i + 1) / count));
  const inc = increases(rates, s, model, points, offset);
  const horizon = (resetsAt - at) / HOUR;
  // The model's past forecasts closest in horizon (log scale) give the range: 10th and 90th percentile of the misses.
  const index = CANDIDATES.indexOf(model);
  const tried = cases.filter(c => !Number.isNaN(c.errors[index]!));
  const distance = (c: Case) => Math.abs(Math.log((c.horizon + 0.1) / (horizon + 0.1)));
  const nearest = [...tried].sort((a, b) => distance(a) - distance(b)).slice(0, Math.max(MIN_CHECKS, Math.floor(tried.length / 3)));
  const near = nearest.length >= MIN_CHECKS ? nearest.map(c => c.errors[index]!).sort((a, b) => a - b) : null;
  const widen = widening(new Set(nearest.map(c => c.window)).size);
  const increase = inc.at(-1)!;
  // The range always holds the expected value: past misses all one way don't move the forecast, they only widen that side.
  // Without enough checks a rough range: half the expected increase either way, at least 3 points.
  const [errLow, errHigh] = near
    ? [Math.min(0, near[Math.floor((near.length - 1) * 0.1)]!) * widen, Math.max(0, near[Math.floor((near.length - 1) * 0.9)]!) * widen]
    : [-Math.max(3, 0.5 * increase), Math.max(3, 0.5 * increase)];
  const clamp = (v: number) => Math.min(100, Math.max(used, v));
  const path: ForecastPoint[] = [{ at, expected: used, low: used, high: used }];
  points.forEach((t, i) => {
    // The range opens along the path: with the expected increase, or with the square root of time while nothing is expected.
    const f = increase > 0.01 ? inc[i]! / increase : Math.sqrt((t - at) / (resetsAt - at));
    path.push({ at: t, expected: Math.min(100, used + inc[i]!), low: clamp(used + inc[i]! - f * errHigh), high: clamp(used + inc[i]! - f * errLow) });
  });
  const crossing = (value: (p: ForecastPoint) => number) => {
    for (let i = 1; i < path.length; i++) {
      const va = value(path[i - 1]!), vb = value(path[i]!);
      if (vb >= 100 - 1e-9) return vb - va <= 1e-9 ? path[i]!.at : path[i - 1]!.at + Math.floor((100 - va) / (vb - va) * (path[i]!.at - path[i - 1]!.at));
    }
    return null;
  };
  const end = path.at(-1)!;
  const misses = near?.map(Math.abs).sort((a, b) => a - b);
  return { from: at, used, resetsAt, atReset: end.expected, low: end.low, high: end.high, runsOutAt: crossing(p => p.expected), runsOutEarliest: crossing(p => p.high),
    runsOutLatest: crossing(p => p.low), path, since, checks: near?.length ?? 0, typicalError: misses ? misses[Math.floor(misses.length / 2)]! : null, learned, model };
}

/** Mean absolute error of every candidate's past forecasts on `history` (where the profile had enough history): for tests and tuning. */
export const evaluate = (history: UsageSample[], length: number | null, now: number, offset: Offset = localOffset) => scores(backtest(prepare(history), length, now, offset));
