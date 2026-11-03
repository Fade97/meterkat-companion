// Companion side of protocol v2 (docs/adr/0001-relay-protocol-v2.md): registration with proof of work,
// end-to-end encrypted uploads and the pairing link that carries the source key.
import { relayJson, registrationFields } from "./relay-response.js";
import { createHash } from "node:crypto";
import { MAX_POW_BITS, encryptSnapshot, fromBase64url, leadingZeroBits, pairingLink, randomSecret } from "../shared/protocol-v2.js";
import type { Snapshot } from "../shared/snapshot.js";
import type { Config } from "./state.js";

/** revokePending: a rotated key is saved but the old phones may still hold relay access. */
export type V2Config = Config & { protocol: 2; sourceKey: string; epoch: number; revokePending?: boolean };
export const isV2 = (config: Config): config is V2Config => (config as Partial<V2Config>).protocol === 2;

/** Smallest decimal solution whose SHA-256(challenge + "." + solution) has `bits` leading zero bits. */
export function solveChallenge(challenge: string, bits: number, options: { timeoutMs?: number; now?: () => number } = {}) {
  if (typeof challenge !== "string" || challenge.length === 0 || challenge.length > 2048 || !Number.isInteger(bits) || bits < 0 || bits > MAX_POW_BITS) throw new Error("Unsupported proof-of-work challenge");
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.timeoutMs ?? 30_000);
  for (let n = 0; n < 1_000_000_000_000; n++) {
    if (n % 1024 === 0 && now() >= deadline) throw new Error("Proof of work timed out");
    if (leadingZeroBits(createHash("sha256").update(`${challenge}.${n}`).digest()) >= bits) return String(n);
  }
  throw new Error("No proof-of-work solution found");
}

async function call(relay: string, path: string, method: string, auth?: string, value?: unknown) {
  const response = await fetch(`${relay}${path}`, {
    method, redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(value === undefined ? {} : { "Content-Type": "application/json" }) },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
  const result = await relayJson(response);
  if (path === "/v2/pairing" && (typeof result.code !== "string" || !/^[A-Za-z0-9_-]{12}$/.test(result.code) || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= 0)) throw new Error("Invalid pairing response");
  if (path === "/v2/devices" && (!Array.isArray(result.devices) || result.devices.length > 10 || result.devices.some((d: any) => !d || typeof d.id !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(d.id) || !Number.isSafeInteger(d.pairedAt) || d.pairedAt <= 0))) throw new Error("Invalid devices response");
  return result;
}

/** Registers a new source. With an admin token the relay skips proof of work (closed self-hosted relays). */
export async function registerV2(relay: string, adminToken?: string): Promise<V2Config> {
  let source: { sourceId: string; writerToken: string };
  if (adminToken) source = registrationFields(await call(relay, "/v2/sources", "POST", adminToken), true);
  else {
    const { challenge, bits } = await call(relay, "/v2/challenge", "GET");
    source = registrationFields(await call(relay, "/v2/sources", "POST", undefined, { challenge, solution: solveChallenge(challenge, bits) }), true);
  }
  return { relay, sourceId: source.sourceId, writerToken: source.writerToken, protocol: 2, sourceKey: randomSecret(), epoch: 1 };
}

export const writerCall = (config: V2Config, path: string, method: string, value?: unknown) => call(config.relay, path, method, config.writerToken, value);

export async function uploadV2(config: V2Config, snapshot: Snapshot) {
  const envelope = await encryptSnapshot({ sourceKey: fromBase64url(config.sourceKey) as Uint8Array<ArrayBuffer>, sourceId: config.sourceId, epoch: config.epoch, snapshot });
  await writerCall(config, "/v2/snapshot", "PUT", envelope);
}

export async function pairingLinkV2(config: V2Config, phoneRelay = config.relay) {
  const { code, expiresAt } = await writerCall(config, "/v2/pairing", "POST");
  return { link: pairingLink({ relay: phoneRelay, sourceId: config.sourceId, code, sourceKey: config.sourceKey, epoch: config.epoch }), code: code as string, expiresAt: expiresAt as number };
}

/**
 * New source key and epoch, saved before anything else so a failure can never lose the new key.
 * Then every phone is revoked. If that fails, running rotate-key again only retries the revocation.
 */
export async function rotateKey(config: V2Config, save: (config: V2Config) => void): Promise<V2Config> {
  const next: V2Config = config.revokePending ? config : { ...config, sourceKey: randomSecret(), epoch: config.epoch + 1, revokePending: true };
  save(next);
  await writerCall(next, "/v2/revoke", "POST");
  const done: V2Config = { ...next, revokePending: false };
  save(done); return done;
}
