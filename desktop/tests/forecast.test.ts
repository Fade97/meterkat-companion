import test from "node:test";
import assert from "node:assert/strict";
import { forecast, HOUR, type UsageSample } from "../../src/forecast.js";
import { forecastChart, forecastText } from "../src/format.js";

const DAY = 24 * HOUR, WEEK = 7 * DAY, utc = () => 0, clock = { locale: "en-GB", timeZone: "UTC" };
/** Monday 2027-01-04 00:00 UTC. */
const monday = 1_799_020_800_000;
/** Three weeks of a steady weekday user (10 % a working day), read every 15 minutes. */
function steady(until: number) {
  const out: UsageSample[] = [];
  for (let t = monday - 21 * DAY; t < until; t += 15 * 60_000) {
    const reset = monday + Math.ceil((t + 1 - monday) / WEEK) * WEEK, start = reset - WEEK;
    let used = 0;
    for (let d = start; d < t; d += 15 * 60_000) { const h = Math.floor((d % DAY) / HOUR), dow = Math.floor((d - monday) / DAY) % 7; if (dow < 5 && h >= 9 && h < 17) used += 10 / 32; }
    out.push({ at: t, used: Math.round(used), resetsAt: reset });
  }
  return out;
}

test("a forecast row says the share at the reset, its range and what it is learned from, in Used and Left", () => {
  const history = steady(monday + 2 * DAY + 12 * HOUR), now = history.at(-1)!;
  const f = forecast(history.slice(0, -1), now.at, now.used, now.resetsAt, WEEK, utc)!;
  assert(f.learned);
  const used = forecastText(f, "used", now.at, clock), left = forecastText(f, "remaining", now.at, clock);
  assert.equal(used.tone, "");
  assert.match(used.verdict, /^Expected at the reset · Mon 00:00$/);
  assert.match(used.range!, /^Likely \d+% to \d+%/);
  assert.match(used.basis, /^Learned from 2\d+d of history · past forecasts missed by (less than 1 point|\d+ points?) \(median of \d+\)$/);
  assert.equal(left.value, 100 - used.value);
  // Left: the range runs from the smaller share left to the larger one.
  const [a, b] = left.range!.match(/\d+/g)!.map(Number);
  assert(a! <= b!);
});

test("a window that runs out says when, with its earliest and latest time", () => {
  const f = forecast([], monday + 2 * DAY, 40, monday + WEEK, WEEK, utc)!;
  const t = forecastText(f, "used", monday + 2 * DAY, clock);
  assert.equal(t.tone, "warn");
  assert.match(t.verdict, /^Runs out around Sat/);
  assert.match(t.range!, /^Likely between .* and .*|^Earliest .*, may last until the reset$/);
  assert.match(t.basis, /^Still learning your rhythm \(1h of history so far\)\. Until then this follows the window's pace\.$/);
  assert.equal(forecastText(forecast([], monday, 100, monday + HOUR, 5 * HOUR, utc)!, "used", monday, clock).verdict, "Limit reached");
});

test("the chart draws actual, expected, range, limit and now, flipped for Left", () => {
  const f = forecast([], monday + 2 * DAY, 40, monday + WEEK, WEEK, utc)!;
  const actual = [{ at: monday + DAY, used: 20, resetsAt: monday + WEEK }, { at: monday + 2 * DAY, used: 40, resetsAt: monday + WEEK }];
  const used = forecastChart(f, actual, monday, "used"), left = forecastChart(f, actual, monday, "remaining");
  for (const part of ["fc-band", "fc-expected", "fc-actual", "fc-limit", "fc-now", "fc-out"]) assert(used.includes(`class="${part}"`), part);
  // The limit line: top for Used (y = 4), bottom for Left (y = 96).
  assert.match(used, /class="fc-limit" d="M0 4\.0 H400"/);
  assert.match(left, /class="fc-limit" d="M0 96\.0 H400"/);
  assert(!used.includes("style="));
});
