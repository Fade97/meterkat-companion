// What the island announces, derived from successive snapshots and the clock. Pure, so it is unit-tested.
//   usage:      a bar rose by at least 10 points since its last announcement, or crossed 50, 75 or 90 %
//   reset-soon: 60, 30, 10, 5 and 1 minutes before a window with usage resets
//   reset-done: once the reset time has passed
import type { Snapshot } from "../../shared/snapshot.js";
import { bars } from "./format.js";

export const JUMP_POINTS = 10;
export const THRESHOLDS = [50, 75, 90];
export const RESET_MILESTONES_MIN = [60, 30, 10, 5, 1];
const KEEP_MS = 10 * 60_000;

type Base = { key: string; provider: string; label: string; at: number; expiresAt: number };
export type IslandEvent =
  | Base & { kind: "usage"; from: number; to: number }
  | Base & { kind: "reset-soon"; resetsAt: number; usedPercent: number }
  | Base & { kind: "reset-done" };

type ResetWatch = { resetsAt: number; usedPercent: number; fired: Set<number>; done: boolean };

export class IslandTracker {
  private readonly baseline = new Map<string, number>();
  private readonly resets = new Map<string, ResetWatch>();

  /** Events that became due since the last call. The first sight of a bar only sets its baseline. */
  update(snapshot: Snapshot | null, now: number): IslandEvent[] {
    const events: IslandEvent[] = [];
    for (const provider of snapshot?.providers ?? []) {
      for (const bar of bars(provider)) {
        const key = `${provider.id}:${bar.label}`;
        const base = { key, provider: provider.id, label: bar.label, at: now };
        if (provider.state === "ok") {
          const usage = this.usage(key, bar.usedPercent);
          if (usage) events.push({ ...base, kind: "usage", ...usage, expiresAt: now + KEEP_MS });
        }
        events.push(...this.reset(key, bar.resetsAt, bar.usedPercent, now).map(event => ({ ...base, ...event })));
      }
    }
    // Windows whose bar vanished from the snapshot still announce their reset.
    for (const [key, watch] of this.resets) {
      if (watch.done || now < watch.resetsAt) continue;
      watch.done = true;
      const [provider = key, label = ""] = key.split(":");
      if (watch.usedPercent > 0) events.push({ key, provider, label, at: now, kind: "reset-done", expiresAt: now + KEEP_MS });
    }
    return events;
  }

  private usage(key: string, value: number) {
    const previous = this.baseline.get(key);
    if (previous === undefined || value < previous) { this.baseline.set(key, value); return null; }
    const crossed = THRESHOLDS.some(t => previous < t && value >= t);
    if (value - previous < JUMP_POINTS && !crossed) return null;
    this.baseline.set(key, value);
    return { from: previous, to: value };
  }

  private reset(key: string, resetsAt: number, usedPercent: number, now: number) {
    const events: ({ kind: "reset-done"; expiresAt: number } | { kind: "reset-soon"; resetsAt: number; usedPercent: number; expiresAt: number })[] = [];
    let watch = this.resets.get(key);
    if (watch && !watch.done && now >= watch.resetsAt) {
      watch.done = true;
      if (watch.usedPercent > 0) events.push({ kind: "reset-done", expiresAt: now + KEEP_MS });
    }
    if (!watch || watch.resetsAt !== resetsAt) {
      // Milestones already behind us when a window first shows up are not announced late.
      const remaining = resetsAt - now;
      watch = { resetsAt, usedPercent, done: remaining <= 0, fired: new Set(RESET_MILESTONES_MIN.filter(m => remaining <= m * 60_000)) };
      this.resets.set(key, watch);
      return events;
    }
    watch.usedPercent = usedPercent;
    const remaining = resetsAt - now;
    const due = RESET_MILESTONES_MIN.filter(m => remaining <= m * 60_000 && !watch.fired.has(m));
    if (!due.length || watch.done) return events;
    for (const m of RESET_MILESTONES_MIN) if (remaining <= m * 60_000) watch.fired.add(m);
    // Nothing to reset in an unused window.
    if (usedPercent > 0) events.push({ kind: "reset-soon", resetsAt, usedPercent, expiresAt: resetsAt });
    return events;
  }
}

/** Adds events to the waiting queue; a newer event for the same bar and kind replaces the older one. */
export function enqueue(queue: IslandEvent[], events: IslandEvent[]): IslandEvent[] {
  let next = queue;
  for (const event of events) {
    const same = (e: IslandEvent) => e.key === event.key && (e.kind === event.kind || (e.kind === "reset-soon" && event.kind === "reset-done"));
    next = [...next.filter(e => !same(e)), event];
  }
  return next;
}

/** The next event still worth showing, and the queue without it and without expired events. */
export function dequeue(queue: IslandEvent[], now: number): { event: IslandEvent | null; rest: IslandEvent[] } {
  const live = queue.filter(e => e.expiresAt > now);
  // Reset notices are time-critical; usage jumps can wait a moment.
  const index = live.findIndex(e => e.kind !== "usage");
  const pick = index >= 0 ? index : live.length ? 0 : -1;
  if (pick < 0) return { event: null, rest: [] };
  return { event: live[pick]!, rest: live.filter((_, i) => i !== pick) };
}
