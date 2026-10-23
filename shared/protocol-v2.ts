// Protocol v2 (docs/adr/0001-relay-protocol-v2.md). Web Crypto only, so the same module runs in
// Node (companion, Node relay) and in Cloudflare Workers.
import { parseSnapshot, type Snapshot } from "./snapshot.js";

/** Malformed client input; relays answer 400. Anything else is a server fault. */
export class ValidationError extends Error {}

export type Envelope = { v: 2; epoch: number; seq: number; generatedAt: number; nonce: string; ciphertext: string };

type Bytes = Uint8Array<ArrayBuffer>;
const encoder = new TextEncoder();
const subtle = () => crypto.subtle;
const bytes = (value: string): Bytes => encoder.encode(value) as Bytes;

export function toBase64url(data: Uint8Array) {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(value: string) {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new ValidationError("Invalid base64url");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}
export const randomBytes = (length: number): Bytes => crypto.getRandomValues(new Uint8Array(length));
/** 32 random bytes, base64url: token secrets and source keys. */
export const randomSecret = () => toBase64url(randomBytes(32));
/** 16 random bytes, base64url (22 chars): source and device IDs. */
export const randomId = () => toBase64url(randomBytes(16));
export const SOURCE_ID = /^[A-Za-z0-9_-]{22}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export async function sha256(data: Bytes | string) {
  return new Uint8Array(await subtle().digest("SHA-256", typeof data === "string" ? bytes(data) : data));
}
export const sha256Hex = async (value: string) => Array.from(await sha256(value), b => b.toString(16).padStart(2, "0")).join("");

/** Bearer tokens are "<sourceId>.<secret>" so the hosted relay can route without a global index. */
export function parseToken(token: string) {
  const [sourceId, secret, ...rest] = token.split(".");
  if (rest.length || !sourceId || !secret || !SOURCE_ID.test(sourceId) || !SECRET.test(secret)) return undefined;
  return { sourceId, secret };
}

export async function deriveAeadKeyBytes(sourceKey: Bytes, sourceId: string) {
  if (sourceKey.length !== 32) throw new Error("Source key must be 32 bytes");
  const ikm = await subtle().importKey("raw", sourceKey, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: bytes("ai-usage/v2"), info: bytes(`snapshot-aead|${sourceId}`) }, ikm, 256));
}
const aeadKey = async (sourceKey: Bytes, sourceId: string) =>
  subtle().importKey("raw", await deriveAeadKeyBytes(sourceKey, sourceId), "AES-GCM", false, ["encrypt", "decrypt"]);

export const associatedData = (sourceId: string, epoch: number, seq: number, generatedAt: number) => `ai-usage/v2|${sourceId}|${epoch}|${seq}|${generatedAt}`;

/** UTF-8 JSON right-padded with spaces to a multiple of 256 bytes. */
export function padPlaintext(json: string) {
  const data = bytes(json);
  const padded = new Uint8Array(Math.ceil(Math.max(data.length, 1) / 256) * 256).fill(0x20);
  padded.set(data); return padded;
}

export async function encryptSnapshot(input: { sourceKey: Bytes; sourceId: string; epoch: number; snapshot: Snapshot; nonce?: Bytes }): Promise<Envelope> {
  const { snapshot, sourceId, epoch } = input;
  const nonce = input.nonce ?? randomBytes(12);
  const ad = bytes(associatedData(sourceId, epoch, snapshot.sequence, snapshot.generatedAt));
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: ad, tagLength: 128 }, await aeadKey(input.sourceKey, sourceId), padPlaintext(JSON.stringify(snapshot))));
  return { v: 2, epoch, seq: snapshot.sequence, generatedAt: snapshot.generatedAt, nonce: toBase64url(nonce), ciphertext: toBase64url(ciphertext) };
}

/** Phone-side steps 1–3 and 5 of the ADR (sequence/sample monotonicity needs the caller's stored state). */
export async function decryptEnvelope(input: { sourceKey: Bytes; sourceId: string; epoch: number; now?: number }, envelope: Envelope): Promise<Snapshot> {
  if (envelope.epoch !== input.epoch) throw new Error(envelope.epoch > input.epoch ? "Source key rotated; re-pair required" : "Outdated key epoch");
  const ad = bytes(associatedData(input.sourceId, envelope.epoch, envelope.seq, envelope.generatedAt));
  let plaintext: ArrayBuffer;
  try {
    plaintext = await subtle().decrypt({ name: "AES-GCM", iv: fromBase64url(envelope.nonce), additionalData: ad, tagLength: 128 }, await aeadKey(input.sourceKey, input.sourceId), fromBase64url(envelope.ciphertext));
  } catch { throw new Error("Snapshot authentication failed"); }
  const snapshot = parseSnapshot(JSON.parse(new TextDecoder().decode(plaintext).trimEnd()), input.now);
  if (snapshot.sequence !== envelope.seq || snapshot.generatedAt !== envelope.generatedAt) throw new Error("Envelope metadata mismatch");
  return snapshot;
}

export const MAX_CIPHERTEXT_BYTES = 12_288;
const integer = (v: unknown, min: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
/** Relay-side shape check. The relay cannot (and must not try to) read the plaintext. */
export function parseEnvelope(value: unknown, now = Date.now()): Envelope {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== 2 || !integer(v.epoch, 1) || !integer(v.seq, 1) || !integer(v.generatedAt, 1) || Number(v.generatedAt) > now + 300_000) throw new ValidationError("Invalid envelope");
  if (typeof v.nonce !== "string" || typeof v.ciphertext !== "string") throw new ValidationError("Invalid envelope");
  const nonce = fromBase64url(v.nonce), ciphertext = fromBase64url(v.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 16 + 256 || ciphertext.length > MAX_CIPHERTEXT_BYTES || (ciphertext.length - 16) % 256 !== 0) throw new ValidationError("Invalid envelope");
  return { v: 2, epoch: v.epoch as number, seq: v.seq as number, generatedAt: v.generatedAt as number, nonce: v.nonce, ciphertext: v.ciphertext };
}

/**
 * Verified Android App Link (assetlinks.json on the Meterkat site). Phones may also scan it with the
 * in-app QR scanner. A custom scheme is not used: any app could register it and capture the key.
 * The fragment (key) is never sent to the web server.
 */
export const PAIRING_LINK_BASE = "https://meterkat.fabian-duerkop.de/pair";
export type PairingLink = { relay: string; sourceId: string; code: string; sourceKey: string; epoch: number };
export function pairingLink(p: PairingLink) {
  return `${PAIRING_LINK_BASE}?v=2&relay=${encodeURIComponent(p.relay)}&source=${encodeURIComponent(p.sourceId)}&code=${encodeURIComponent(p.code)}#k=${p.sourceKey}&e=${p.epoch}`;
}
/** HTTPS relay origin, or plain HTTP only for loopback development. */
export function isAllowedRelay(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "") || url.origin !== value) return false;
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
export function parsePairingLink(link: string): PairingLink {
  const url = new URL(link);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const relay = url.searchParams.get("relay") ?? "", sourceId = url.searchParams.get("source") ?? "", code = url.searchParams.get("code") ?? "";
  const sourceKey = fragment.get("k") ?? "", epoch = Number(fragment.get("e"));
  if (`${url.origin}${url.pathname}` !== PAIRING_LINK_BASE || url.searchParams.get("v") !== "2" || !isAllowedRelay(relay) || !SOURCE_ID.test(sourceId) || !code || !integer(epoch, 1)) throw new ValidationError("Invalid pairing link");
  if (fromBase64url(sourceKey).length !== 32) throw new ValidationError("Invalid pairing link");
  return { relay, sourceId, code, sourceKey, epoch };
}

/** Proof-of-work difficulty bounds shared by the Node relay and the Worker. */
export function parsePowBits(value: unknown) {
  const bits = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof bits !== "number" || !Number.isSafeInteger(bits) || bits < 0 || bits > 32) throw new Error("POW_BITS must be an integer between 0 and 32");
  return bits;
}

// Source IDs carry a server MAC: 8 random bytes followed by the first 8 bytes of
// HMAC-SHA256(secret, "meterkat/source-id|" || random). The hosted relay rejects forged IDs before
// touching any Durable Object. Rotating the secret invalidates every existing source.
const ID_LABEL = "meterkat/source-id|";
async function idMac(secret: string, random: Uint8Array) {
  const message = new Uint8Array(ID_LABEL.length + random.length);
  message.set(bytes(ID_LABEL)); message.set(random, ID_LABEL.length);
  return new Uint8Array(await subtle().sign("HMAC", await hmacKey(secret), message)).slice(0, 8);
}
export async function mintSourceId(secret: string) {
  const random = randomBytes(8), id = new Uint8Array(16);
  id.set(random); id.set(await idMac(secret, random), 8);
  return toBase64url(id);
}
export async function verifySourceId(secret: string, sourceId: string) {
  if (!SOURCE_ID.test(sourceId)) return false;
  const id = fromBase64url(sourceId), mac = await idMac(secret, id.slice(0, 8));
  let diff = 0; for (let i = 0; i < 8; i++) diff |= mac[i]! ^ id[8 + i]!;
  // 22 base64url chars carry 4 spare bits: only the canonical encoding is accepted, so an ID has no aliases.
  return diff === 0 && toBase64url(id) === sourceId;
}

// Proof-of-work registration challenge, stateless and HMAC-signed by the relay.
export type Challenge = { sid: string; exp: number; bits: number };
const hmacKey = (secret: string) => subtle().importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
export async function signChallenge(secret: string, payload: Challenge) {
  const body = toBase64url(bytes(JSON.stringify(payload)));
  return `${body}.${toBase64url(new Uint8Array(await subtle().sign("HMAC", await hmacKey(secret), bytes(body))))}`;
}
export function leadingZeroBits(digest: Uint8Array) {
  let count = 0;
  for (const byte of digest) { if (byte === 0) { count += 8; continue; } count += Math.clz32(byte) - 24; break; }
  return count;
}
/** Returns the challenge payload if signature, expiry and work are valid. */
export async function verifyChallenge(secret: string, challenge: string, solution: string, now = Date.now()): Promise<Challenge | undefined> {
  const [body, signature, ...rest] = challenge.split(".");
  if (rest.length || !body || !signature || !/^[0-9]{1,12}$/.test(solution)) return undefined;
  try {
    if (!await subtle().verify("HMAC", await hmacKey(secret), fromBase64url(signature), bytes(body))) return undefined;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(body))) as Challenge;
    if (!SOURCE_ID.test(payload.sid) || !integer(payload.exp, 1) || payload.exp < now || !integer(payload.bits, 0)) return undefined;
    return leadingZeroBits(await sha256(`${challenge}.${solution}`)) >= payload.bits ? payload : undefined;
  } catch { return undefined; }
}
