export type WindowUsage = { usedPercent: number; resetsAt: number };
export type MeterUsage = WindowUsage & { id: string; label: string };
export type ProviderUsage = {
  id: string;
  state: "ok" | "unavailable" | "auth_required";
  sampledAt: number | null;
  windows: { fiveHour?: WindowUsage; weekly?: WindowUsage };
  meters?: MeterUsage[];
};
export type Snapshot = { schemaVersion: 1; sequence: number; generatedAt: number; providers: ProviderUsage[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const timestamp = (v: unknown, now: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= now + 300_000;
const windowValue = (v: unknown): v is WindowUsage => object(v) && typeof v.usedPercent === "number" && Number.isFinite(v.usedPercent) && v.usedPercent >= 0 && v.usedPercent <= 100 && typeof v.resetsAt === "number" && Number.isSafeInteger(v.resetsAt) && v.resetsAt > 0;

/** Whitelist-only reconstruction: upstream session metadata never reaches the relay. */
export function parseSnapshot(value: unknown, now = Date.now()): Snapshot {
  if (!object(value) || value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !timestamp(value.generatedAt, now) || !Array.isArray(value.providers) || value.providers.length < 1 || value.providers.length > 12) throw new Error("Invalid snapshot");
  const ids = new Set<string>();
  const providers = value.providers.map((p: unknown): ProviderUsage => {
    if (!object(p) || typeof p.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(p.id) || ids.has(p.id) || !["ok", "unavailable", "auth_required"].includes(String(p.state)) || !object(p.windows)) throw new Error("Invalid provider");
    ids.add(p.id);
    if (p.sampledAt !== null && (!timestamp(p.sampledAt, now) || Number(p.sampledAt) > Number(value.generatedAt))) throw new Error("Invalid sample time");
    const windows: ProviderUsage["windows"] = {};
    for (const key of ["fiveHour", "weekly"] as const) {
      if (p.windows[key] != null) {
        if (!windowValue(p.windows[key]) || p.sampledAt === null) throw new Error("Invalid quota window");
        windows[key] = { usedPercent: p.windows[key].usedPercent, resetsAt: p.windows[key].resetsAt };
      }
    }
    let meters: MeterUsage[] | undefined;
    if (p.meters !== undefined) {
      if (!Array.isArray(p.meters) || p.meters.length < 1 || p.meters.length > 6) throw new Error("Invalid meters");
      const meterIds = new Set<string>();
      meters = p.meters.map((m: unknown) => {
        if (!object(m) || typeof m.id !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(m.id) || meterIds.has(m.id) || typeof m.label !== "string" || !/^[\p{L}\p{N} _().:+/-]{1,32}$/u.test(m.label) || p.sampledAt === null) throw new Error("Invalid meter");
        const quota = { usedPercent: m.usedPercent, resetsAt: m.resetsAt };
        if (!windowValue(quota)) throw new Error("Invalid meter quota");
        meterIds.add(m.id);
        return { id: m.id, label: m.label, ...quota };
      });
    }
    if (p.state === "ok" && (!p.sampledAt || (Object.keys(windows).length === 0 && !meters?.length))) throw new Error("Missing quota data");
    return { id: p.id, state: p.state as ProviderUsage["state"], sampledAt: p.sampledAt as number | null, windows, ...(meters ? { meters } : {}) };
  });
  return { schemaVersion: 1, sequence: Number(value.sequence), generatedAt: value.generatedAt, providers };
}

export function unavailable(id: ProviderUsage["id"], previous?: ProviderUsage, authRequired = false): ProviderUsage {
  return { id, state: authRequired ? "auth_required" : "unavailable", sampledAt: previous?.sampledAt ?? null, windows: previous?.windows ?? {}, ...(previous?.meters ? { meters: previous.meters } : {}) };
}

export function fromClaudeStatusline(input: any, sampledAt = Date.now()): ProviderUsage {
  const windows: ProviderUsage["windows"] = {};
  for (const [key, upstream] of [["fiveHour", "five_hour"], ["weekly", "seven_day"]] as const) {
    const w = input?.rate_limits?.[upstream];
    const candidate = { usedPercent: w?.used_percentage, resetsAt: Number(w?.resets_at) * 1000 };
    if (windowValue(candidate) && candidate.resetsAt > sampledAt) windows[key] = candidate;
  }
  return { id: "claude", state: Object.keys(windows).length ? "ok" : "unavailable", sampledAt: Object.keys(windows).length ? sampledAt : null, windows };
}

/** Claude may rerun its status script with cached JSON; unchanged data isn't a new observation. */
export function captureClaude(input: unknown, previous?: ProviderUsage, now = Date.now()): ProviderUsage | undefined {
  const next = fromClaudeStatusline(input, now);
  if (!next.sampledAt) return previous;
  if (previous && JSON.stringify(previous.windows) === JSON.stringify(next.windows)) return previous;
  return next;
}

/** Native /usage report. Scoped model meters are deliberately excluded from the all-model weekly bar. */
export function fromClaudeReport(input: any, sampledAt = Date.now()): ProviderUsage {
  const rows = input?.usage_report?.rate_limits?.limits;
  const windows: ProviderUsage["windows"] = {};
  if (Array.isArray(rows)) for (const row of rows) {
    const candidate = { usedPercent: row?.percent, resetsAt: Date.parse(row?.resets_at) };
    if (!windowValue(candidate) || candidate.resetsAt <= sampledAt) continue;
    if (row.kind === "session") windows.fiveHour = candidate;
    if (row.kind === "weekly_all") windows.weekly = candidate;
  }
  return { id: "claude", state: Object.keys(windows).length ? "ok" : "unavailable", sampledAt: Object.keys(windows).length ? sampledAt : null, windows };
}

export function fromCodexLimits(input: any, sampledAt = Date.now()): ProviderUsage {
  const limits = input?.rateLimitsByLimitId?.codex ?? input?.rateLimits;
  const windows: ProviderUsage["windows"] = {};
  for (const w of [limits?.primary, limits?.secondary]) {
    const candidate = { usedPercent: w?.usedPercent, resetsAt: Number(w?.resetsAt) * 1000 };
    if (!windowValue(candidate) || candidate.resetsAt <= sampledAt) continue;
    if (w.windowDurationMins === 300) windows.fiveHour = candidate;
    if (w.windowDurationMins === 10080) windows.weekly = candidate;
  }
  return { id: "codex", state: Object.keys(windows).length ? "ok" : "unavailable", sampledAt: Object.keys(windows).length ? sampledAt : null, windows };
}
