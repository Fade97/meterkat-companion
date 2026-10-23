import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "./state.js";
import type { MeterUsage, ProviderUsage } from "../shared/snapshot.js";

/**
 * Antigravity quotas from the native CLI's zero-turn print-mode `/usage` answer. Its JSON layout is
 * undocumented; the parser follows the payload verified with CLI 1.4.5 (docs/antigravity.md).
 * Native CLI owns sign-in; nothing here reads auth files, calls provider endpoints or starts a login.
 */
export const printUsageSince = [1, 1, 11] as const; // CHANGELOG 1.1.11: zero-turn `-p "/usage"`.
const maxOutputBytes = 256_000;
/** After a kill, `close` can stay out while an orphaned grandchild holds the pipes; the run resolves anyway. */
const killGraceMs = 3_000;
const authTailChars = 512;
const maxDepth = 6;
const maxKeys = 32;

/** Structural names worth reporting verbatim. Any other key may be an identity or ID and is masked. */
const knownKeys = new Set([
  "conversation_id", "status", "response", "error", "duration_seconds", "num_turns", "structured_output", "json_schema", "usage",
  "input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens",
  "quota", "quotas", "model_quotas", "models", "model", "buckets", "bucket", "limits", "limit", "credits",
  "id", "model_id", "bucket_id", "name", "label", "display_name", "kind", "type", "window", "period", "duration",
  "remaining", "remaining_fraction", "remaining_percent", "used", "used_fraction", "used_percent", "percent", "fraction",
  "reset_time", "reset_at", "resets_at", "reset_in_seconds", "unit", "requests", "tokens",
]);
const knownStatus = new Set(["SUCCESS", "ERROR", "CANCELED", "INTERRUPTED", "INVALID", "WAITING", "RUNNING"]);

export type Shape = string | { array: number; item?: Shape } | { object: Record<string, Shape>; omittedKeys?: number } | { json: Shape };

/**
 * Spawned without a shell on purpose. On Windows a `.cmd`/`.ps1` shim cannot be started that way (ENOENT or
 * EINVAL), which counts as "not installed": the reader fails safe. Point AI_USAGE_ANTIGRAVITY_BIN at the `.exe`.
 */
export function antigravityCommand(): { command: string; args: string[] } {
  const configured = process.env.AI_USAGE_ANTIGRAVITY_BIN;
  if (configured) return configured.endsWith(".js") ? { command: process.execPath, args: [configured] } : { command: configured, args: [] };
  return { command: "agy", args: [] };
}

/** First `x.y.z` anywhere in the `--version` output, so a banner or build suffix does not hide the version. */
export function parseVersion(output: string): [number, number, number] | undefined {
  const match = /(?<![\d.])(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?![\d])/.exec(output);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

/** Older CLIs would send `/usage` to the model as a prompt, so they are never run in print mode. */
export function supportsPrintUsage(version: readonly number[] | undefined) {
  if (!version) return false;
  for (let i = 0; i < 3; i++) if (version[i] !== printUsageSince[i]) return version[i]! > printUsageSince[i]!;
  return true;
}

const keyName = (key: string, index: number) => knownKeys.has(key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase()) ? key : `<key${index}>`;

/** Types, key allowlist and counts only. Values, unknown keys and free text never appear. */
export function describeShape(value: unknown, depth = 0): Shape {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : value >= 0 && value <= 1 ? "number<0..1>" : "number";
  if (typeof value === "string") {
    if (!value) return "string<empty>";
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return "string<datetime>";
    if (depth < maxDepth && /^\s*[[{]/.test(value)) { try { return { json: describeShape(JSON.parse(value), depth + 1) }; } catch { /* Plain text. */ } }
    const lines = value.split("\n").filter(line => line.trim());
    if (lines.length > 1 && lines.some(line => line.includes("\t"))) return `string<tsv rows=${lines.length} cols=${[...new Set(lines.map(line => line.split("\t").length))].slice(0, 4).join("|")}>`;
    return "string";
  }
  if (depth >= maxDepth) return "<depth limit>";
  if (Array.isArray(value)) return value.length ? { array: value.length, item: describeShape(value[0], depth + 1) } : { array: 0 };
  if (typeof value === "object") {
    const entries = Object.entries(value);
    const object: Record<string, Shape> = {};
    entries.slice(0, maxKeys).forEach(([key, child], index) => {
      object[keyName(key, index)] = key === "status" && typeof child === "string" && knownStatus.has(child) ? `status<${child}>` : describeShape(child, depth + 1);
    });
    return entries.length > maxKeys ? { object, omittedKeys: entries.length - maxKeys } : { object };
  }
  return "unsupported";
}

/**
 * A signed-out CLI prints a Google authorization URL to stderr and then waits for a pasted code. Only that URL
 * or an explicit prompt counts, so a stray "login" in a harmless message does not end a good run.
 */
const authUrl = /https:\/\/accounts\.google\.com\/\S*(?:oauth|signin)/i;
const authPhrase = /\b(?:please\s+(?:sign|log)\s?in|(?:sign|log)\s?in\s+(?:to|with)\s+(?:your\s+)?(?:google|antigravity)|(?:enter|paste)\s+(?:the\s+|your\s+)?(?:authori[sz]ation|auth|verification)\s+code|authentication\s+required)\b/i;
export const looksLikeAuthPrompt = (text: string) => authUrl.test(text) || authPhrase.test(text);

/**
 * Child environment: no display and a no-op browser, so a signed-out CLI on a desktop cannot open a sign-in tab
 * on every retry. Keyring access goes through D-Bus, not the display. Windows has no equivalent switch; the
 * 24-hour backoff bounds it there.
 */
export function childEnvironment(env: NodeJS.ProcessEnv = process.env, platform = process.platform): NodeJS.ProcessEnv {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, BROWSER: _browser, ...rest } = env;
  return platform === "win32" ? rest : { ...rest, BROWSER: "true" };
}

function lastJsonObject(stdout: string): any {
  const line = stdout.trim().split("\n").reverse().find(candidate => candidate.trim().startsWith("{"));
  try { return line ? JSON.parse(line) : undefined; } catch { return undefined; }
}

type Run = { code: number | null; stdout: string; timedOut: boolean; tooLarge: boolean; missing: boolean; authRequired: boolean };
function kill(child: ChildProcess) {
  try {
    if (!child.pid) child.kill("SIGKILL");
    else if (process.platform === "win32") spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).once("error", () => child.kill());
    else process.kill(-child.pid, "SIGKILL");
  } catch { /* Already exited. */ }
}
/**
 * One CLI run in an empty temporary directory (no inherited project config or agent rules), stdin closed, its
 * own process group. Always resolves: on close, at the timeout, or shortly after a kill or exit even if an
 * orphaned grandchild keeps the pipes open.
 */
function run(args: string[], timeoutMs: number): Promise<Run> {
  return new Promise(resolve => {
    const bin = antigravityCommand();
    const cwd = mkdtempSync(join(tmpdir(), "meterkat-agy-"));
    const cleanup = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* OS temp cleanup remains safe. */ } };
    let child: ChildProcess;
    try {
      // New session without a terminal and stdin closed: a signed-out CLI cannot read a pasted auth code.
      child = spawn(bin.command, [...bin.args, ...args], { cwd, env: childEnvironment(), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch {
      // Windows refuses `.cmd` shims without a shell (EINVAL): treated like a missing CLI.
      cleanup(); resolve({ code: null, stdout: "", timedOut: false, tooLarge: false, missing: true, authRequired: false }); return;
    }
    let stdout = ""; let tail = ""; let settled = false; let stopped = false; let timedOut = false; let tooLarge = false; let missing = false; let authRequired = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (code: number | null) => {
      if (settled) return; settled = true; timers.forEach(clearTimeout); tail = "";
      child.stdout?.destroy(); child.stderr?.destroy();
      // Windows cannot delete a running process's current directory; retry once it exits.
      if (child.exitCode !== null || child.signalCode !== null || missing) cleanup(); else child.once("exit", cleanup);
      resolve({ code, stdout, timedOut, tooLarge, missing, authRequired });
    };
    const stop = () => { if (stopped) return; stopped = true; kill(child); timers.push(setTimeout(() => done(null), killGraceMs)); };
    timers.push(setTimeout(() => { timedOut = true; stop(); done(null); }, timeoutMs));
    child.stdout!.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > maxOutputBytes) { tooLarge = true; stdout = ""; stop(); }
    });
    // Stderr is never kept: it can contain an auth URL. Only a bounded rolling tail is matched, so a prompt split
    // across chunks is still found. A sign-in prompt ends the run at once.
    child.stderr!.on("data", (chunk: Buffer) => {
      if (authRequired) return;
      tail = (tail + chunk.toString()).slice(-authTailChars);
      if (looksLikeAuthPrompt(tail)) { authRequired = true; tail = ""; stop(); }
    });
    child.once("error", () => { missing = true; done(null); });
    child.once("exit", code => { timers.push(setTimeout(() => done(code), killGraceMs)); });
    child.once("close", code => done(code));
  });
}

type CollectorState = { failures: number; retryAt: number; authRequired: boolean; inferenceSeenVersion?: string };
const stateFile = "antigravity.json";
/** A run that reports turns or tokens used the model. That CLI version is never run again. */
const usedInference = (envelope: any) => (typeof envelope?.num_turns === "number" && envelope.num_turns > 0) || (typeof envelope?.usage?.total_tokens === "number" && envelope.usage.total_tokens > 0);
function latchInference(state: CollectorState | undefined, version: string) {
  writeState(stateFile, { ...(state ?? { failures: 0, retryAt: 0, authRequired: false }), inferenceSeenVersion: version } satisfies CollectorState);
  console.error(`Antigravity CLI ${version} ran a model turn for /usage; quota collection is paused until the CLI version changes.`);
}
/** The latch only holds for the version that misbehaved; an update (or downgrade) clears it. */
function latchedFor(state: CollectorState | undefined, version: string) {
  if (!state?.inferenceSeenVersion) return false;
  if (state.inferenceSeenVersion === version) return true;
  const { inferenceSeenVersion: _cleared, ...rest } = state; writeState(stateFile, rest); return false;
}

export type AntigravityProbe = {
  installed: boolean; version: string | null; printUsageSupported: boolean; ran: boolean;
  outcome?: "ok" | "auth_required" | "error_envelope" | "timeout" | "too_large" | "no_json" | "inference_latched";
  status?: string; zeroInference?: boolean; shape?: Shape;
};

/**
 * Explicit, one-off diagnostic of the payload structure. Prints no values; `collect` uses `readAntigravityUsage`.
 * It honours the inference latch, and a successful run clears the reader's backoff so a CLI that was just signed
 * in shows up on the next sync instead of after up to 24 hours.
 */
export async function probeAntigravityUsage(timeoutMs = 30_000): Promise<AntigravityProbe> {
  const versionRun = await run(["--version"], 10_000);
  const version = versionRun.missing ? undefined : parseVersion(versionRun.stdout);
  const result: AntigravityProbe = { installed: !versionRun.missing && !!version, version: version ? version.join(".") : null, printUsageSupported: supportsPrintUsage(version), ran: false };
  if (!result.printUsageSupported) return result;
  const state = readState<CollectorState>(stateFile);
  if (latchedFor(state, result.version!)) return { ...result, outcome: "inference_latched" };
  // The signed-out CLI waits ~60 s for an auth code regardless of --print-timeout, so cap it here.
  const usage = await run(["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], timeoutMs);
  result.ran = true;
  if (usage.authRequired) return { ...result, outcome: "auth_required" };
  if (usage.timedOut) return { ...result, outcome: "timeout" };
  if (usage.tooLarge) return { ...result, outcome: "too_large" };
  const envelope = lastJsonObject(usage.stdout);
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { ...result, outcome: "no_json" };
  if (usedInference(envelope)) latchInference(readState<CollectorState>(stateFile), result.version!);
  const status = typeof envelope.status === "string" && knownStatus.has(envelope.status) ? envelope.status : "unknown";
  const zeroInference = envelope.num_turns === 0 && envelope.usage?.total_tokens === 0;
  const outcome = status === "SUCCESS" && usage.code === 0 ? "ok" : "error_envelope";
  if (outcome === "ok" && zeroInference) writeState(stateFile, { failures: 0, retryAt: 0, authRequired: false } satisfies CollectorState);
  return { ...result, outcome, status, zeroInference, shape: describeShape(envelope) };
}

const labelText = (value: unknown) => typeof value === "string" ? value.replace(/[^\p{L}\p{N} _().:+/-]/gu, " ").replace(/\s+/g, " ").trim() : "";
/** Cut by code points: a UTF-16 cut can leave a lone surrogate, which fails `parseSnapshot` for the whole snapshot. */
const fit = (text: string, max: number) => Array.from(text).slice(0, Math.max(0, max)).join("").trim();
function meterId(value: unknown, index: number) {
  const id = (typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") : "");
  return (!id ? `bucket-${index + 1}` : /^[a-z]/.test(id) ? id : `q-${id}`).slice(0, 32);
}
/** Group name plus payload window; a label already taken (same group, several buckets) adds the bucket name. */
function meterLabel(group: any, bucket: any, taken: Set<string>) {
  const window = fit(labelText(bucket.window), 12); const suffix = window ? ` (${window})` : "";
  const groupName = labelText(group?.name); const bucketName = labelText(bucket.name);
  const room = 32 - Array.from(suffix).length;
  const base = groupName || bucketName || "Quota";
  for (const name of [base, groupName && bucketName ? `${groupName} ${bucketName}` : "", bucketName]) {
    const label = fit(name, room) + suffix; if (name && !taken.has(label)) return label;
  }
  for (let n = 2; ; n++) { const label = `${fit(base, room - String(n).length - 1)} ${n}${suffix}`; if (!taken.has(label)) return label; }
}

/**
 * One meter per quota bucket. Models in a group share the bucket, so the group name is the label and the
 * window comes verbatim from the payload ("weekly" in 1.4.5); no session or week window is assumed.
 * Buckets without a 0..1 remaining fraction or a future reset time are unknown and left out.
 */
export function fromAntigravityUsage(envelope: any, sampledAt = Date.now()): ProviderUsage {
  const meters: MeterUsage[] = [];
  const groups = envelope?.status === "SUCCESS" && Array.isArray(envelope?.command?.data?.groups) ? envelope.command.data.groups : [];
  for (const group of groups) for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
    const remaining = bucket?.remaining_fraction; const resetsAt = typeof bucket?.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
    if (typeof remaining !== "number" || !(remaining >= 0 && remaining <= 1) || !Number.isSafeInteger(resetsAt) || resetsAt <= sampledAt) continue;
    const id = meterId(bucket.id, meters.length);
    if (meters.length >= 6 || meters.some(meter => meter.id === id)) continue;
    const label = meterLabel(group, bucket, new Set(meters.map(meter => meter.label)));
    meters.push({ id, label, usedPercent: Math.round((1 - remaining) * 1000) / 10, resetsAt });
  }
  return { id: "antigravity", state: meters.length ? "ok" : "unavailable", sampledAt: meters.length ? sampledAt : null, windows: {}, ...(meters.length ? { meters } : {}) };
}

/** Failures back off 5 minutes doubling to 60; a sign-in prompt doubles on to 24 hours (a desktop may open a tab). */
export const backoffMs = (failures: number, authRequired: boolean) =>
  Math.min(authRequired ? 24 * 60 : 60, 5 * 2 ** Math.min(failures - 1, 12)) * 60_000;
const unread = (authRequired: boolean): ProviderUsage => ({ id: "antigravity", state: authRequired ? "auth_required" : "unavailable", sampledAt: null, windows: {} });

/**
 * Periodic reader. Skipped while backing off so a signed-out or broken CLI is not started every minute.
 * Resolves `auth_required` when the CLI asks for sign-in; throws when it is missing, too old or unrecognised.
 * A CLI version that ever reports a model turn for `/usage` is latched and not run in print mode again.
 */
export async function readAntigravityUsage(timeoutMs = 20_000, now = () => Date.now()): Promise<ProviderUsage> {
  const state = readState<CollectorState>(stateFile);
  if (state && now() < state.retryAt) return unread(state.authRequired);
  // Checked on every read (about 0.3 s): the CLI updates itself, and older versions would send `/usage` to the model.
  const versionRun = await run(["--version"], 10_000);
  if (versionRun.missing) throw new Error("Antigravity CLI not found");
  const parsed = parseVersion(versionRun.stdout);
  if (!parsed) throw new Error("Antigravity CLI version unrecognised; quotas are not read");
  if (!supportsPrintUsage(parsed)) throw new Error("Antigravity CLI is older than 1.1.11; update it to read quotas");
  const version = parsed.join(".");
  if (latchedFor(state, version)) return unread(false);
  const usage = await run(["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"], timeoutMs);
  const envelope = usage.authRequired || usage.timedOut || usage.tooLarge ? undefined : lastJsonObject(usage.stdout);
  const current = readState<CollectorState>(stateFile);
  if (usedInference(envelope)) { latchInference(current, version); return unread(false); }
  // Only the documented zero-inference answer is trusted.
  const zeroInference = envelope?.num_turns === 0 && envelope?.usage?.total_tokens === 0;
  const result = usage.code === 0 && zeroInference ? fromAntigravityUsage(envelope, now()) : undefined;
  if (result?.state === "ok") { if (current?.failures || current?.retryAt) writeState(stateFile, { failures: 0, retryAt: 0, authRequired: false } satisfies CollectorState); return result; }
  const failures = (current?.failures ?? 0) + 1;
  writeState(stateFile, { failures, retryAt: now() + backoffMs(failures, usage.authRequired), authRequired: usage.authRequired } satisfies CollectorState);
  return unread(usage.authRequired);
}
