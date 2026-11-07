import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderUsage, Snapshot } from "../../shared/snapshot.js";
import { LOCKUP } from "../src/brand-lockup.js";
import { radioStep } from "../src/radio-keys.js";
import { ago, bars, duration, elapsed, fresh, paceUnknown, syncProblem, STALE_MS, staleLabel, chipLabel, islandAnchorHelp, ISLAND_ANCHORS, staleSummary, headerStatus, headerAge, lowWhenLastSeen, LOW_LAST_SEEN, panelStatus, tickHint, tickLegend, tickRead, level, pace, paceText, providerColor, providerGroups, providerMark, resetClock, resetLine, resetText, urgency, runOutText, reasonLabel, headline, atRiskRows, alsoAtRisk, alsoLine, alsoMore, alsoEntry, troubleIn, ALSO_AT_RISK, lowBelowCue, paceWarns, paceGlyph, shownPercent, tickPercent, tightest, trayLines, unitWord, WINDOW_MS, type Bar } from "../src/format.js";
import { autostartFile, desktopEntry, execLine, launchCommand, linuxAutostart } from "../src/login-item.js";
import { backgroundPid, cliServiceRunning, unitStateDirectory } from "../src/service.js";
import { loginShellPath, mergePath } from "../src/shell-path.js";

const now = 1_800_000_000_000;
const claude: ProviderUsage = { id: "claude", state: "ok", sampledAt: now, windows: { fiveHour: { usedPercent: 42.4, resetsAt: now + 3_600_000 }, weekly: { usedPercent: 81, resetsAt: now + 5 * 86_400_000 } } };
const antigravity: ProviderUsage = { id: "antigravity", state: "unavailable", sampledAt: now - 60_000, windows: {}, meters: [{ id: "gemini", label: "Gemini Pro", usedPercent: 10, resetsAt: now + 1000 }] };

test("bars list windows first, then quota buckets", () => {
  assert.deepEqual(bars(claude).map(b => b.label), ["5-hour", "Weekly"]);
  assert.deepEqual(bars(antigravity).map(b => [b.label, b.usedPercent]), [["Gemini Pro", 10]]);
});

test("durations and relative times", () => {
  // Compact like the Android app, rounded up to whole minutes.
  assert.equal(duration(45 * 60_000), "45m");
  assert.equal(duration(44 * 60_000 + 1), "45m");
  assert.equal(duration(130 * 60_000), "2h 10m");
  assert.equal(duration(60 * 60_000), "1h 0m");
  assert.equal(duration(76 * 3_600_000), "3d 4h");
  assert.equal(duration(-5), "0m");
  assert.equal(ago(now - 10_000, now), "just now");
  assert.equal(ago(now - 120_000, now), "2m ago");
  assert.equal(ago(now - 150 * 60_000, now), "2h ago");
  assert.equal(ago(now - 76 * 3_600_000, now), "3d ago");
  assert.equal(resetText(now - 1, now), "Updating");
  assert.equal(resetText(now + 3_600_000, now), "Resets in 1h 0m");
});

test("tray lines show the highest used share and stale or sign-in states", () => {
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [claude, antigravity, { id: "codex", state: "auth_required", sampledAt: null, windows: {} }] };
  assert.deepEqual(trayLines(snapshot), ["Claude · Weekly: 81% used", "Antigravity · Gemini Pro: 10% used (stale)", "Codex: sign-in needed"]);
  assert.deepEqual(trayLines(null), []);
});

test("with \"remaining\" the bars and tray show what is left", () => {
  assert.equal(shownPercent(42.4, "used"), 42.4);
  assert.equal(shownPercent(42.4, "remaining"), 57.6);
  assert.equal(shownPercent(104, "remaining"), 0);
  assert.equal(shownPercent(-3, "used"), 0);
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [claude, antigravity] };
  // The most used bar is the one with the least left.
  assert.deepEqual(trayLines(snapshot, "remaining"), ["Claude · Weekly: 19% left", "Antigravity · Gemini Pro: 90% left (stale)", "Codex: not set up"]);
});

test("providers that never reported quota are grouped as not set up", () => {
  const codexMissing: ProviderUsage = { id: "codex", state: "unavailable", sampledAt: null, windows: {} };
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [claude, codexMissing] };
  const groups = providerGroups(snapshot);
  assert.deepEqual(groups.shown.map(p => p.id), ["claude"]);
  // Antigravity is optional and absent from the snapshot until it reports data.
  assert.deepEqual(groups.notSetUp, ["codex", "antigravity"]);
  // Stale data and sign-in needed stay cards.
  const signIn: ProviderUsage = { id: "codex", state: "auth_required", sampledAt: null, windows: {} };
  assert.deepEqual(providerGroups({ ...snapshot, providers: [claude, antigravity, signIn] }), { shown: [claude, antigravity, signIn], notSetUp: [] });
  assert.deepEqual(providerGroups(null), { shown: [], notSetUp: [] });
  assert.deepEqual(trayLines(snapshot), ["Claude · Weekly: 81% used", "Codex: not set up", "Antigravity: not set up"]);
});

test("bars use the provider colours from the Android app", () => {
  assert.deepEqual(["claude", "codex", "antigravity", "other"].map(providerColor), ["#D97757", "#6EA8FE", "#34C77B", "#94A3B8"]);
});

test("login command points at the AppImage, the packaged executable or Electron with the app folder", () => {
  assert.deepEqual(launchCommand({ APPIMAGE: "/home/u/Meterkat.AppImage" }, "/tmp/.mount_x/meterkat", true, "/app"), ["/home/u/Meterkat.AppImage", "--hidden"]);
  assert.deepEqual(launchCommand({}, "C:\\Meterkat\\Meterkat.exe", true, "/app"), ["C:\\Meterkat\\Meterkat.exe", "--hidden"]);
  assert.deepEqual(launchCommand({}, "/usr/bin/electron", false, "/src/desktop"), ["/usr/bin/electron", "/src/desktop", "--hidden"]);
});

test("desktop entry quotes and escapes every argument", () => {
  assert.equal(execLine(["/home/a b/Meter$kat \"x\" 100%.AppImage", "--hidden"]), '"/home/a b/Meter\\$kat \\"x\\" 100%%.AppImage" "--hidden"');
  assert.throws(() => execLine(["/bad\npath"]));
  assert.match(desktopEntry(["/x"]), /^Exec="\/x"$/m);
  assert.equal(autostartFile({ XDG_CONFIG_HOME: "/cfg" }, "/home/u"), join("/cfg", "autostart", "meterkat-desktop.desktop"));
  assert.equal(autostartFile({ XDG_CONFIG_HOME: "relative" }, "/home/u"), join("/home/u", ".config", "autostart", "meterkat-desktop.desktop"));
});

test("Linux autostart only removes its own entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-autostart-"));
  const file = join(dir, "autostart", "meterkat-desktop.desktop");
  const entry = linuxAutostart(file);
  assert.equal(entry.enabled(), false);
  entry.set(true, ["/x/Meterkat.AppImage", "--hidden"]);
  assert.equal(entry.enabled(), true);
  entry.set(false, []);
  assert.equal(existsSync(file), false);
  writeFileSync(file, "[Desktop Entry]\nExec=/someone/else\n");
  entry.set(false, []);
  assert.equal(readFileSync(file, "utf8"), "[Desktop Entry]\nExec=/someone/else\n");
});

test("a CLI service counts only when it is active for the same state directory", () => {
  const exec = (state: string, active = "active") => (_: string, args: string[]) => ({ status: 0, stdout: args.includes("is-active") ? active : `PATH=/bin AI_USAGE_STATE_DIR=${state} AI_USAGE_SUPERVISOR=systemd` });
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/meterkat")), true);
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/other")), false);
  assert.equal(cliServiceRunning("/s/meterkat", "linux", exec("/s/meterkat", "inactive")), false);
  assert.equal(unitStateDirectory('PATH=/bin "AI_USAGE_STATE_DIR=/a b/state" X=1'), "/a b/state");
});

test("the Windows background process counts only with a lock from this boot", () => {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-service-"));
  writeFileSync(join(dir, "companion.pid"), "4242");
  assert.equal(backgroundPid(dir, 0), 4242);
  assert.equal(backgroundPid(dir, Date.now() + 60_000), undefined);
  assert.equal(cliServiceRunning(dir, "win32", undefined, pid => pid === 4242, 0), true);
  assert.equal(cliServiceRunning(dir, "win32", undefined, () => false, 0), false);
});

test("login shell PATH is read between markers and merged after the current one", () => {
  const run = (_: string, args: string[]) => ({ status: 0, stdout: `motd noise\n__METERKAT_PATH__/home/u/.local/bin:/usr/bin__METERKAT_PATH__${args.length}` });
  assert.equal(loginShellPath({ SHELL: "/bin/zsh" }, run), "/home/u/.local/bin:/usr/bin");
  assert.equal(loginShellPath({ SHELL: "zsh" }, run), undefined);
  assert.equal(loginShellPath({}, run), undefined);
  if (process.platform !== "win32") assert.equal(mergePath("/usr/bin:/bin", "/home/u/.local/bin:/usr/bin:relative"), "/usr/bin:/bin:/home/u/.local/bin");
});

test("provider marks: glyph for known providers, dot otherwise", () => {
  for (const id of ["claude", "codex", "antigravity"]) assert.match(providerMark(id), /^<svg class="provider-mark" viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="[^"<>]+"\/><\/svg>$/);
  assert.equal(providerMark("gemini"), `<span class="provider-dot" aria-hidden="true"></span>`);
});

test("reset times: clock time today, weekday once it is a day or more away", () => {
  const utc = { locale: "en-GB", timeZone: "UTC" };
  const at = Date.UTC(2026, 10, 4, 12, 20); // a Wednesday
  assert.equal(resetClock(at + 130 * 60_000, at, utc), "14:30");
  assert.equal(resetClock(Date.UTC(2026, 10, 7, 9, 41), at, utc), "Sat 09:41");
  assert.equal(resetLine(at + 130 * 60_000, at, utc), "Resets in 2h 10m · 14:30");
  assert.equal(resetLine(at - 1, at, utc), "Updating");
});

test("pace: elapsed share and the tick, which drains with the bar in \"left\" mode", () => {
  const five: Bar = { label: "5-hour", usedPercent: 42, resetsAt: now + 3 * 3_600_000, windowMs: WINDOW_MS.fiveHour };
  assert.equal(elapsed(five, now), 0.4);
  assert.equal(tickPercent(five, "used", now), 40);
  assert.equal(tickPercent(five, "remaining", now), 60);
  // Buckets without a known length and windows that have reset get no tick.
  assert.equal(tickPercent({ label: "Gemini Pro", usedPercent: 10, resetsAt: now + 1000 }, "used", now), null);
  assert.equal(elapsed({ ...five, resetsAt: now - 1 }, now), null);
  // A reset further away than the window length is clamped to the start.
  assert.equal(elapsed({ ...five, resetsAt: now + 6 * 3_600_000 }, now), 0);
});

test("pace: limit, running out before the reset, or on pace", () => {
  const h = 3_600_000;
  const five = (usedPercent: number, left: number): Bar => ({ label: "5-hour", usedPercent, resetsAt: now + left, windowMs: WINDOW_MS.fiveHour });
  // 2 h of 5 h gone and 80 % used: 40 %/h, the last 20 % last 30 min, 2.5 h before the reset.
  const fast = pace(five(80, 3 * h), now)!;
  assert.equal(fast.state, "fast");
  assert.equal(fast.runsOutIn, 30 * 60_000);
  assert.equal(paceText(fast), "Runs out in 30m");
  assert.equal(paceText(fast, true), "Runs out in 30m, 2h 30m before reset");
  assert.equal(level(five(80, 3 * h), fast), "warn");
  // 40 % used with 40 % of the window gone lasts exactly until the reset.
  const even = pace(five(40, 3 * h), now)!;
  assert.equal(even.state, "ok");
  assert.equal(paceText(even), "On pace");
  assert.equal(level(five(40, 3 * h), even), "");
  assert.equal(pace(five(0, 3 * h), now)?.state, "ok");
  const limit = pace(five(100, 3 * h), now)!;
  assert.deepEqual([limit.state, paceText(limit), level(five(100, 3 * h), limit)], ["limit", "Limit reached", "bad"]);
  // Too early (< 3 % of the window), already reset, or unknown length: no verdict; a full bucket still is a limit.
  assert.equal(pace(five(20, 5 * h - 60_000), now), null);
  assert.equal(pace(five(20, -1), now), null);
  assert.equal(pace({ label: "Gemini Pro", usedPercent: 60, resetsAt: now + h }, now), null);
  assert.equal(pace({ label: "Gemini Pro", usedPercent: 100, resetsAt: now + h }, now)?.state, "limit");
  // From 80 % used the verdict says "Running low" when nothing more urgent applies: buckets, too early, or on pace.
  const low = pace({ label: "Gemini Pro", usedPercent: 88, resetsAt: now + h }, now)!;
  assert.deepEqual([low.state, paceText(low), level({ label: "Gemini Pro", usedPercent: 88, resetsAt: now + h }, low)], ["low", "Running low", "warn"]);
  assert.equal(pace(five(85, 5 * h - 60_000), now)?.state, "low");
  assert.equal(pace(five(85, 10 * 60_000), now)?.state, "low");
  assert.equal(pace(five(79, 10 * 60_000), now)?.state, "ok");
  assert.equal(pace(five(90, 3 * h), now)?.state, "fast");
});

test("the tightest quota: a limit first, then the earliest run-out, then the highest share", () => {
  const h = 3_600_000;
  const p = (id: string, fiveHour: number, weekly: number, state: ProviderUsage["state"] = "ok"): ProviderUsage =>
    ({ id, state, sampledAt: now, windows: { fiveHour: { usedPercent: fiveHour, resetsAt: now + 3 * h }, weekly: { usedPercent: weekly, resetsAt: now + 5 * 86_400_000 } } });
  const snap = (...providers: ProviderUsage[]): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: now, providers });
  // Weekly 2 of 7 days gone: 20 % is on pace, 5-hour 40 % too; the higher share wins.
  assert.deepEqual(((t) => [t?.provider.id, t?.bar.label])(tightest(snap(p("claude", 40, 20), p("codex", 30, 25)), now)), ["claude", "5-hour"]);
  // Codex 5-hour at 80 % runs out early.
  assert.deepEqual(((t) => [t?.provider.id, t?.bar.label, t?.pace?.state])(tightest(snap(p("claude", 40, 20), p("codex", 80, 25)), now)), ["codex", "5-hour", "fast"]);
  assert.equal(tightest(snap(p("claude", 100, 20), p("codex", 80, 25)), now)?.pace?.state, "limit");
  // Only current data counts while there is any: providers that need a sign-in or are stale (by state or age) are skipped.
  assert.deepEqual(((t) => [t?.provider.id, t?.bar.label, t?.lastKnown])(tightest(snap(p("claude", 40, 20), p("codex", 100, 25, "unavailable")), now)), ["claude", "5-hour", null]);
  // With none current, the last known data stands in, marked with its age and without a verdict.
  const old = tightest(snap({ ...p("claude", 100, 20), sampledAt: now - STALE_MS - 1 }), now)!;
  assert.deepEqual([old.provider.id, old.bar.label, old.pace, old.lastKnown], ["claude", "5-hour", null, now - STALE_MS - 1]);
  assert.equal(tightest(snap(p("codex", 90, 25, "auth_required")), now)?.lastKnown, now);
  assert.equal(tightest(null, now), null);
});

test("vocabulary matches the Android app", () => {
  assert.deepEqual([unitWord("used"), unitWord("remaining")], ["used", "left"]);
  assert.deepEqual(bars(claude).map(b => b.windowMs), [WINDOW_MS.fiveHour, WINDOW_MS.weekly]);
  assert.equal(bars(antigravity)[0]?.windowMs, undefined);
});

test("the header names the provider whose data is not current", () => {
  const ok = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: now - 60_000, windows: {} });
  const old = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: now - 15 * 60_000, windows: {} });
  assert.equal(staleSummary([ok("claude"), ok("codex")], now), null);
  assert.equal(staleSummary([ok("claude"), old("codex")], now), "Codex stale");
  assert.equal(staleSummary([old("claude"), old("codex"), ok("antigravity")], now), "2 stale");
  // The chips' words: sign-in needed is not "stale".
  const signIn = (id: string): ProviderUsage => ({ ...ok(id), state: "auth_required" });
  assert.equal(staleSummary([ok("claude"), signIn("codex")], now), "Codex sign-in needed");
  assert.equal(staleSummary([signIn("claude"), signIn("codex"), ok("antigravity")], now), "2 need sign-in");
  assert.equal(staleSummary([signIn("claude"), old("codex"), ok("antigravity")], now), "2 need attention");
});

test("the header says what needs attention and nothing else (no fresh claim next to it), 'Updated' only when all are current", () => {
  const ok = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: now - 60_000, windows: {} });
  const old = (id: string, minutes = 15): ProviderUsage => ({ id, state: "ok", sampledAt: now - minutes * 60_000, windows: {} });
  const synced = now - 5_000;
  assert.equal(headerStatus([ok("claude"), ok("codex")], synced, now), "Updated just now");
  assert.equal(headerStatus([ok("claude"), old("codex")], synced, now), "Codex stale");
  assert.equal(headerStatus([old("claude"), old("codex"), ok("antigravity")], synced, now), "2 stale");
  assert.equal(headerStatus([old("claude", 40), old("codex", 15)], synced, now), "All stale · 15m ago");
  assert.equal(headerStatus([old("claude")], synced, now), "Claude stale · 15m ago");
  const signIn = (id: string, minutes = 120): ProviderUsage => ({ ...old(id, minutes), state: "auth_required" });
  assert.equal(headerStatus([ok("claude"), signIn("codex")], synced, now), "Codex sign-in needed");
  assert.equal(headerStatus([ok("claude"), signIn("codex"), old("antigravity")], synced, now), "2 need attention");
  // Nothing current: all stale, all needing sign-in, or a mix.
  assert.equal(headerStatus([signIn("claude"), signIn("codex", 90)], synced, now), "All need sign-in · 1h ago");
  assert.equal(headerStatus([signIn("claude"), old("codex")], synced, now), "All need attention · 15m ago");
  assert.equal(headerStatus([signIn("codex")], synced, now), "Codex sign-in needed · 2h ago");
});

test("the chips drop the age the header already gives (every shown provider not current, all read at the same time) and keep it otherwise", () => {
  const ok = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: now - 60_000, windows: {} });
  const old = (id: string, minutes = 15): ProviderUsage => ({ id, state: "ok", sampledAt: now - minutes * 60_000, windows: {} });
  const signIn = (id: string, minutes = 15): ProviderUsage => ({ ...old(id, minutes), state: "auth_required" });
  const synced = now - 5_000;
  const chips = (shown: ProviderUsage[]) => shown.map(p => chipLabel(p, shown, synced, now));
  // Same age as the header: plain "Stale" / "Sign-in needed" (island-04f).
  assert.deepEqual(chips([old("claude"), old("codex"), signIn("antigravity")]), ["Stale", "Stale", "Sign-in needed"]);
  assert.deepEqual(chips([old("claude")]), ["Stale"]);
  // Different ages: the header names the newest only, so every chip keeps its own age (island-04g).
  assert.deepEqual(chips([old("claude", 40), old("codex", 15)]), ["Stale · 40m ago", "Stale · 15m ago"]);
  // One stale provider among current ones: the header gives no age, the chip keeps it (window-04b); current providers have no chip.
  assert.deepEqual(chips([ok("claude"), old("codex")]), [null, "Stale · 15m ago"]);
  assert.deepEqual(chips([ok("claude"), signIn("codex")]), [null, "Sign-in needed · 15m ago"]);
  // No sample at all: "Unavailable" stays, it has no age to repeat.
  assert.equal(chipLabel({ id: "claude", state: "ok", windows: {} } as ProviderUsage, [{ id: "claude", state: "ok", windows: {} } as ProviderUsage], synced, now), "Unavailable");
});

test("Settings > Island > Position says 'AI app' and describes the selected segment, not both", () => {
  assert.deepEqual(ISLAND_ANCHORS, { screen: "Top of screen", window: "AI app" });
  assert.equal(islandAnchorHelp("screen"), "Centred at the top of the screen");
  assert.equal(islandAnchorHelp("window"), "Follows the Claude, Codex or Antigravity window in front");
});

test("the island panel's header is the window's: 'Updated' and the neutral tone only while every shown provider is current", () => {
  const ok = (id: string): ProviderUsage => ({ id, state: "ok", sampledAt: now - 60_000, windows: {} });
  const snap = (...providers: ProviderUsage[]): Snapshot => ({ generatedAt: now - 5_000, providers } as Snapshot);
  assert.deepEqual(panelStatus(snap(ok("claude"), ok("codex")), now), { text: "Updated just now", warn: false });
  // Codex needs sign-in: no "Updated just now" beside it, and the amber tone.
  const signIn: ProviderUsage = { ...ok("codex"), state: "auth_required", sampledAt: now - 120 * 60_000 };
  assert.deepEqual(panelStatus(snap(ok("claude"), signIn), now), { text: "Codex sign-in needed", warn: true });
  assert.deepEqual(panelStatus(snap(signIn), now), { text: "Codex sign-in needed · 2h ago", warn: true });
  // No provider shown yet: the sync time alone.
  assert.deepEqual(panelStatus(snap(), now), { text: "Updated just now", warn: false });
});

test("old data says how old it is", () => {
  const base: ProviderUsage = { id: "codex", state: "ok", sampledAt: now - 2 * 3_600_000, windows: {} };
  // "ok" but older than the stale threshold (a failed or stuck sync) is stale too.
  assert.equal(staleLabel(base, now), "Stale · 2h ago");
  assert.equal(staleLabel({ ...base, sampledAt: now - STALE_MS }, now), null);
  assert.deepEqual([fresh({ ...base, sampledAt: now - 60_000 }, now), fresh(base, now), fresh({ ...base, sampledAt: null }, now)], [true, false, true]);
  assert.equal(staleLabel({ ...base, state: "auth_required" }, now), "Sign-in needed · 2h ago");
  assert.equal(staleLabel({ ...base, state: "unavailable", sampledAt: now - 15 * 60_000 }, now), "Stale · 15m ago");
  assert.equal(staleLabel({ ...base, state: "auth_required", sampledAt: null }, now), "Sign-in needed");
  assert.equal(staleLabel({ ...base, state: "unavailable", sampledAt: null }, now), "Unavailable");
});

// assets/brand lives in the private monorepo around the companion subtree; the standalone public repo skips this check.
const LOCKUP_SVG = join(import.meta.dirname, "../../../assets/brand/meterkat-lockup-reversed.svg");
test("the lockup is the drawn one from assets/brand, not retyped", { skip: !existsSync(LOCKUP_SVG) && "assets/brand is only in the monorepo" }, () => {
  const file = readFileSync(LOCKUP_SVG, "utf8");
  const paths = [...file.matchAll(/ d="([^"]+)"/g)].map(m => m[1]!);
  assert.equal(paths.length, 23);
  for (const d of paths) assert.ok(LOCKUP.includes(`d="${d}"`), d);
  assert.match(LOCKUP, /viewBox="0 24 922 136" role="img" aria-label="Meterkat"/);
  assert.doesNotMatch(LOCKUP, /<text/);
});

test("the elapsed mark has one key sentence on every surface; the tooltip adds how to read a bar", () => {
  assert.equal(tickLegend("used"), "The tick marks the time passed in each window.");
  assert.equal(tickLegend("remaining"), "The tick marks the time left in each window.");
  assert.equal(tickHint("used"), "The tick marks the time passed in each window. A bar ahead of the tick runs out before the reset.");
  assert.equal(tickHint("remaining"), "The tick marks the time left in each window. A bar short of the tick runs out before the reset.");
  assert.equal(tickRead("used"), "A bar ahead of the tick runs out before the reset.");
  assert.equal(tickRead("remaining"), "A bar short of the tick runs out before the reset.");
});

test("segmented controls move like a radio group: arrows wrap, Home and End jump, other keys are left alone", () => {
  assert.deepEqual(["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].map(key => radioStep(0, 2, key)), [1, 1, 1, 1, 0, 1]);
  assert.equal(radioStep(1, 2, "ArrowRight"), 0);
  assert.equal(radioStep(1, 3, "ArrowLeft"), 0);
  assert.equal(radioStep(0, 2, "Enter"), null);
  assert.equal(radioStep(0, 2, "Tab"), null);
  assert.equal(radioStep(0, 0, "ArrowRight"), null);
});

test("a failed sync is explained in words, with the age of the data on screen", () => {
  const hosted = "https://meterkat-relay.fabian-duerkop.de";
  assert.equal(syncProblem("Relay unreachable (network error)", hosted, now - 12 * 60_000, now), "Can't reach the Meterkat relay. Showing data from 12m ago.");
  assert.equal(syncProblem("fetch failed", "https://relay.example.com", now - 10_000, now), "Can't reach your relay.");
  assert.equal(syncProblem("HTTP 500", hosted, null, now), "Couldn't send your quota to your phone.");
});

test("providers whose quotas have no known window length say once that pace is not available", () => {
  assert.equal(paceUnknown(antigravity), true);
  assert.equal(paceUnknown(claude), false);
  assert.equal(paceUnknown({ ...antigravity, meters: [] }), false);
});

test("the tightest quota is the same bar whether the data is current or only last known", () => {
  const h = 3_600_000, day = 24 * h;
  // Like the mock: Claude weekly runs out early (67 % with 3d 4h to go), Antigravity's bucket is running low (88 %).
  const providers = (sampledAt: number): ProviderUsage[] => [
    { id: "claude", state: "ok", sampledAt, windows: { fiveHour: { usedPercent: 42, resetsAt: now + 2 * h + 600_000 }, weekly: { usedPercent: 67, resetsAt: now + 3 * day + 4 * h } } },
    { id: "antigravity", state: "ok", sampledAt, windows: {}, meters: [{ id: "c", label: "Claude models", usedPercent: 88, resetsAt: now + h }] },
  ];
  const snap = (sampledAt: number): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: providers(sampledAt) });
  const current = tightest(snap(now), now)!, old = tightest(snap(now - 12 * 60_000), now)!;
  assert.deepEqual([current.provider.id, current.bar.label, current.pace?.state, current.lastKnown], ["claude", "Weekly", "fast", null]);
  assert.deepEqual([old.provider.id, old.bar.label, old.pace, old.lastKnown], ["claude", "Weekly", null, now - 12 * 60_000]);
  // Tiers: limit, then fast (earliest first), then running low, then the highest share.
  const bar = (usedPercent: number): Bar => ({ label: "x", usedPercent, resetsAt: now + h });
  const tiers = [urgency(bar(100), { state: "limit", runsOutIn: 0, untilReset: h }), urgency(bar(50), { state: "fast", runsOutIn: 60_000, untilReset: h }),
    urgency(bar(50), { state: "fast", runsOutIn: 30 * 60_000, untilReset: h }), urgency(bar(85), { state: "low", runsOutIn: null, untilReset: h }), urgency(bar(79), null)];
  assert.deepEqual([...tiers].sort((a, b) => b - a), tiers);
});

test("the Tightest line says when a quota runs out, on the same clock as resets", () => {
  const utc = { locale: "en-GB", timeZone: "UTC" };
  const at = Date.UTC(2026, 10, 4, 12, 20); // a Wednesday
  assert.equal(runOutText({ state: "fast", runsOutIn: 80 * 60_000, untilReset: 3 * 3_600_000 }, at, utc), "Runs out around 13:40");
  assert.equal(runOutText({ state: "fast", runsOutIn: 45 * 3_600_000, untilReset: 76 * 3_600_000 }, at, utc), "Runs out around Fri 09:20");
  assert.equal(runOutText({ state: "low", runsOutIn: null, untilReset: 3_600_000 }, at, utc), "Running low");
});

test("the headline says why its quota was picked, also for last known data", () => {
  const h = 3_600_000;
  const snap = (sampledAt: number, weekly: number, meter: number): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [
    { id: "claude", state: "ok", sampledAt, windows: { weekly: { usedPercent: weekly, resetsAt: now + 76 * h } } },
    { id: "antigravity", state: "ok", sampledAt, windows: {}, meters: [{ id: "c", label: "Claude models", usedPercent: meter, resetsAt: now + h }] } ] });
  assert.equal(reasonLabel(tightest(snap(now, 67, 88), now)!.reason), "Runs out first");
  assert.equal(reasonLabel(tightest(snap(now - 12 * 60_000, 67, 88), now)!.reason), "Runs out first");
  assert.equal(reasonLabel(tightest(snap(now, 20, 88), now)!.reason), "Running low");
  assert.equal(reasonLabel(tightest(snap(now, 20, 100), now)!.reason), "Limit reached");
  assert.equal(reasonLabel(tightest(snap(now, 20, 40), now)!.reason), "Most used");
});

test("a window whose reset has passed shows no number in the tray until the next sample", () => {
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [{ ...claude, windows: { fiveHour: { usedPercent: 90, resetsAt: now - 1 }, weekly: { usedPercent: 40, resetsAt: now + 3_600_000 } } }] };
  assert.deepEqual(trayLines(snapshot, "used", now).slice(0, 1), ["Claude · Weekly: 40% used"]);
  const passed: Snapshot = { ...snapshot, providers: [{ ...claude, windows: { fiveHour: { usedPercent: 90, resetsAt: now - 1 } } }] };
  assert.deepEqual(trayLines(passed, "used", now).slice(0, 1), ["Claude: updating"]);
});

test("a run-out close to the reset is no warning: fast needs a margin of 15 minutes or 3 % of the window", () => {
  const h = 3_600_000;
  const five = (usedPercent: number, left: number): Bar => ({ label: "5-hour", usedPercent, resetsAt: now + left, windowMs: WINDOW_MS.fiveHour });
  // 58 % with 2h 10m left runs out in about 2h 4m: six minutes before the reset, within the margin: "Cutting it close", no warning.
  assert.equal(pace(five(58, 130 * 60_000), now)?.state, "tight");
  // 62 % runs out in about 1h 44m, 26 minutes early.
  assert.equal(pace(five(62, 130 * 60_000), now)?.state, "fast");
  // Weekly: the margin is 3 % of 7 days (about 5 h); 2 h early is not enough, 10 h is.
  const week = (usedPercent: number, left: number): Bar => ({ label: "Weekly", usedPercent, resetsAt: now + left, windowMs: WINDOW_MS.weekly });
  const leftWeek = 84 * h; // half the week gone: 50 % used lasts exactly; slightly more runs out early
  assert.equal(pace(week(50.6, leftWeek), now)?.state, "tight");
  assert.equal(pace(week(53, leftWeek), now)?.state, "fast");
});

test("the headline: reason on its own line, provider and window, then the detail; old data says Last known", () => {
  const utc = { locale: "en-GB", timeZone: "UTC" }, h = 3_600_000, at = Date.UTC(2026, 10, 4, 12, 20);
  const p = (sampledAt: number): ProviderUsage => ({ id: "claude", state: "ok", sampledAt, windows: { weekly: { usedPercent: 67, resetsAt: at + 76 * h } } });
  const snap = (sampledAt: number): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [p(sampledAt)] });
  const fresh = headline(tightest(snap(at), at)!, "used", at, utc);
  assert.deepEqual([fresh.label, fresh.tone, fresh.glyph, fresh.title, fresh.lead, fresh.rest, fresh.name],
    ["Runs out first", "fast", true, "Claude · Weekly", "Runs out around Fri 09:38", "resets Sat 16:20", "Runs out first: Claude Weekly, 67% used"]);
  const old = headline(tightest(snap(at - 12 * 60_000), at)!, "remaining", at, utc);
  assert.deepEqual([old.label, old.tone, old.glyph, old.lead, old.rest, old.name], ["Last known", "", false, "", "12m ago · resets Sat 16:20", "Last known: Claude Weekly, 33% left"]);
});

test("the headline drops the age the header already gives, and keeps its own when its sample is older", () => {
  const utc = { locale: "en-GB", timeZone: "UTC" }, h = 3_600_000, at = Date.UTC(2026, 10, 4, 12, 20), ago15 = at - 15 * 60_000;
  const prov = (id: string, sampledAt: number, used: number): ProviderUsage => ({ id, state: "ok", sampledAt, windows: { weekly: { usedPercent: used, resetsAt: at + 76 * h } } });
  const snap = (providers: ProviderUsage[]): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: ago15, providers });
  // All stale and read at the same time: the header says "All stale · 15m ago", the headline does not repeat it.
  const same = snap([prov("claude", ago15, 67), prov("codex", ago15, 30)]), shown = providerGroups(same).shown;
  assert.equal(headerStatus(shown, same.generatedAt, at), "All stale · 15m ago");
  assert.equal(headerAge(shown, same.generatedAt, at), "15m ago");
  const lead = headline(tightest(same, at)!, "used", at, utc, headerAge(shown, same.generatedAt, at));
  assert.equal(lead.rest, "resets Sat 16:20");
  // Without a header age (one provider still current) or with another age, the headline keeps its own.
  assert.equal(headline(tightest(same, at)!, "used", at, utc).rest, "15m ago · resets Sat 16:20");
  const older = snap([prov("claude", at - 40 * 60_000, 67), prov("codex", ago15, 30)]), shownOlder = providerGroups(older).shown;
  assert.equal(headerAge(shownOlder, older.generatedAt, at), "15m ago");
  assert.equal(headline(tightest(older, at)!, "used", at, utc, headerAge(shownOlder, older.generatedAt, at)).rest, "40m ago · resets Sat 16:20");
  const mixed = snap([prov("claude", ago15, 67), prov("codex", at, 30)]);
  assert.equal(headerAge(providerGroups(mixed).shown, mixed.generatedAt, at), null);
});

test("a stale or sign-in row that was low when last seen says so; current and calm rows do not", () => {
  const h = 3_600_000, at = Date.UTC(2026, 10, 4, 12, 20);
  const bar = (usedPercent: number, left = 2 * h): Bar => ({ label: "Claude models", usedPercent, resetsAt: at + left });
  const prov = (state: ProviderUsage["state"], sampledAt: number | null): ProviderUsage => ({ id: "antigravity", state, sampledAt, windows: {} });
  const stale = prov("ok", at - 15 * 60_000), signIn = prov("auth_required", at - 60 * 60_000), current = prov("ok", at);
  assert.equal(lowWhenLastSeen(stale, bar(88), at), LOW_LAST_SEEN);
  assert.equal(lowWhenLastSeen(signIn, bar(80), at), "Low when last seen");
  assert.equal(lowWhenLastSeen(stale, bar(79), at), null);
  assert.equal(lowWhenLastSeen(current, bar(88), at), null);
  // A window that has reset has no last-seen number to speak of.
  assert.equal(lowWhenLastSeen(stale, bar(88, -1), at), null);
});

test("three bands: on pace, tight (runs out just before the reset, no warning), runs out early", () => {
  const five = (usedPercent: number): Bar => ({ label: "5-hour", usedPercent, resetsAt: now + 130 * 60_000, windowMs: WINDOW_MS.fiveHour });
  const ok = pace(five(50), now)!, tight = pace(five(58), now)!, fast = pace(five(62), now)!;
  assert.deepEqual([ok.state, tight.state, fast.state], ["ok", "tight", "fast"]);
  assert.deepEqual([paceText(ok), paceText(tight), paceText(tight, true)], ["On pace", "Cutting it close", "Cutting it close: may run out just before the reset"]);
  assert.deepEqual([paceWarns(ok), paceWarns(tight), paceWarns(fast)], [false, false, true]);
  assert.deepEqual([level(five(58), tight), paceGlyph(tight)], ["", false]);
});

test("one at-risk rule: low, at its limit or forecast to run out; never the headline itself, never old data", () => {
  const h = 3_600_000;
  const snap = (sampledAt: number, meter: number, other = 40): Snapshot => ({ schemaVersion: 1, sequence: 1, generatedAt: sampledAt, providers: [
    { id: "claude", state: "ok", sampledAt, windows: { fiveHour: { usedPercent: other, resetsAt: now + 2 * h }, weekly: { usedPercent: 67, resetsAt: now + 76 * h } } },
    { id: "antigravity", state: "ok", sampledAt, windows: {}, meters: [{ id: "c", label: "Claude models", usedPercent: meter, resetsAt: now + h }, { id: "g", label: "Gemini Pro", usedPercent: 85, resetsAt: now + 3 * h }] } ] });
  const current = snap(now, 88), tight = tightest(current, now)!;
  assert.deepEqual([tight.provider.id, tight.bar.label], ["claude", "Weekly"]);
  // Both low buckets are at risk, the one that resets first leads the footer.
  assert.deepEqual(atRiskRows(current, tight, now).map(r => r.bar.label), ["Claude models", "Gemini Pro"]);
  assert.deepEqual(alsoAtRisk(current, tight, now).map(r => r.bar.label), ["Claude models", "Gemini Pro"]);
  // The limit is the headline itself now; the other low bucket is the one added.
  const limit = snap(now, 100);
  assert.deepEqual([tightest(limit, now)!.bar.label, alsoAtRisk(limit, tightest(limit, now)!, now).map(r => r.bar.label)], ["Claude models", ["Gemini Pro", "Weekly"]]);
  const calm: Snapshot = { ...current, providers: [current.providers[0]!] };
  assert.deepEqual(alsoAtRisk(calm, tightest(calm, now)!, now), []);
  const old = snap(now - 12 * 60_000, 88);
  assert.deepEqual([atRiskRows(old, tightest(old, now)!, now), alsoAtRisk(old, tightest(old, now)!, now)], [[], []]);
  // A forecast counts exactly like a threshold: the weekly window that runs out first leads while the 88 % bucket is the other entry.
  const two = snap(now, 88, 70), lead = tightest(two, now)!;
  assert.deepEqual([lead.bar.label, alsoAtRisk(two, lead, now).map(r => r.bar.label)], ["5-hour", ["Claude models", "Gemini Pro", "Weekly"]]);
});

test("the at-risk footer: forecast entries say when they run out, low ones keep their share and reset; most pressing first", () => {
  const h = 3_600_000;
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 1, generatedAt: now, providers: [
    { id: "claude", state: "ok", sampledAt: now, windows: { fiveHour: { usedPercent: 80, resetsAt: now + 130 * 60_000 }, weekly: { usedPercent: 67, resetsAt: now + 76 * h } } },
    { id: "antigravity", state: "ok", sampledAt: now, windows: {}, meters: [{ id: "c", label: "Claude models", usedPercent: 88, resetsAt: now + 50 * 60_000 }] } ] };
  const lead = tightest(snapshot, now)!;
  assert.deepEqual([lead.provider.id, lead.bar.label], ["claude", "5-hour"]);
  // Weekly runs out in 1d 21h (forecast); the low bucket resets in 50m: 50 minutes of trouble come first.
  const rows = alsoAtRisk(snapshot, lead, now);
  assert.deepEqual(rows.map(r => [r.bar.label, troubleIn(r.pace)]), [["Claude models", 50 * 60_000], ["Weekly", rows[1]!.pace.runsOutIn!]]);
  const [low, fast] = rows.map(r => alsoEntry(r, "used", now)) as [ReturnType<typeof alsoEntry>, ReturnType<typeof alsoEntry>];
  assert.deepEqual([low.name, low.alert, low.rest], ["Antigravity · Claude models", "▲ 88% used", "resets in 50m"]);
  assert.deepEqual([fast.name, fast.alert, fast.rest, fast.state], ["Claude · Weekly", "▲ runs out in 1d 21h", "", "fast"]);
  assert.equal(alsoEntry(rows[0]!, "remaining", now).alert, "▲ 12% left");
  // The most pressing entry in full (unit kept), the rest counted and named in the tooltip text; the spoken text reads every entry.
  const line = alsoLine(rows, "used", now);
  assert.deepEqual([line.label, line.entries.map(e => e.title), line.more, alsoMore(line.more)], [ALSO_AT_RISK, ["Antigravity · Claude models ▲ 88% used · resets in 50m"], 1, "+1 more"]);
  assert.equal(line.hidden, "Claude · Weekly ▲ runs out in 1d 21h");
  // With "+N more" the visible entry drops its reset (one line at 460px); a single entry keeps it. Title and spoken text keep it either way.
  assert.deepEqual([line.entries[0]!.rest, line.entries[0]!.alert], ["", "▲ 88% used"]);
  assert.deepEqual([alsoLine(rows.slice(0, 1), "used", now).entries[0]!.rest], ["resets in 50m"]);
  // "+N more" scrolls to the card of the next entry and is named for assistive technology; the group reads only the entry shown.
  assert.equal(line.next, "claude");
  assert.equal(line.moreName, "+1 more: Claude Weekly, runs out in 1d 21h, resets in 3d 4h. Show the Claude card");
  assert.equal(line.spokenShown, "Also at risk: Antigravity Claude models, 88% used, resets in 50m");
  assert.match(line.spoken, /^Also at risk: Antigravity Claude models, 88% used, resets in 50m; Claude Weekly, runs out in 1d 21h, resets in 3d 4h$/);
  const three = alsoLine([...rows, rows[0]!], "used", now);
  assert.deepEqual([three.entries.length, three.more, three.hidden.split("; ").length], [1, 2, 2]);
  const single = alsoLine(rows.slice(0, 1), "used", now);
  assert.deepEqual([single.more, single.hidden], [0, ""]);
  // One order and count on every surface: the footer's "+N more" is the island's at-risk rows minus the one it names.
  assert.deepEqual(atRiskRows(snapshot, lead, now).map(r => r.bar.label).sort(), rows.map(r => r.bar.label).sort());
  assert.equal(line.more, atRiskRows(snapshot, lead, now).length - line.entries.length);
});

test("the island's scroll cue names what is at risk below the fold and counts rows, not providers", () => {
  assert.equal(lowBelowCue([]), null);
  assert.equal(lowBelowCue([{ provider: "Antigravity", state: "low" }]), "▲ Antigravity low ↓");
  assert.equal(lowBelowCue([{ provider: "Gemini", state: "limit" }]), "▲ Gemini at its limit ↓");
  assert.equal(lowBelowCue([{ provider: "Claude", state: "fast" }]), "▲ Claude runs out early ↓");
  // Two rows in one provider are still two.
  assert.equal(lowBelowCue([{ provider: "Gemini", state: "low" }, { provider: "Gemini", state: "fast" }]), "▲ 2 at risk below ↓");
});
