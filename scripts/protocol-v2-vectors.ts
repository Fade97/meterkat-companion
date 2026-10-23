// Generates protocol/v2-test-vectors.json from fixed inputs. `--check` fails if the file is out of date.
import { readFileSync, writeFileSync } from "node:fs";
import { associatedData, deriveAeadKeyBytes, encryptSnapshot, fromBase64url, leadingZeroBits, padPlaintext, pairingLink, sha256, sha256Hex, toBase64url } from "../shared/protocol-v2.js";
import type { Snapshot } from "../shared/snapshot.js";

async function sourceIdFor(secret: string, random: Uint8Array<ArrayBuffer>) {
  const message = new Uint8Array([...new TextEncoder().encode("meterkat/source-id|"), ...random]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message)).slice(0, 8);
  return toBase64url(new Uint8Array([...random, ...mac]));
}
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
const fixed = (length: number, start: number) => Uint8Array.from({ length }, (_, i) => (start + i) & 0xff);

export async function vectors() {
  const sourceKey = fixed(32, 0x00), sourceId = "AAECAwQFBgcICQoLDA0ODw", epoch = 1;
  const snapshot: Snapshot = { schemaVersion: 1, sequence: 42, generatedAt: 1790000000000, providers: [
    { id: "claude", state: "ok", sampledAt: 1789999990000, windows: { fiveHour: { usedPercent: 37.5, resetsAt: 1790010000000 }, weekly: { usedPercent: 12, resetsAt: 1790500000000 } } },
    { id: "codex", state: "unavailable", sampledAt: null, windows: {} },
  ] };
  const plaintextJson = JSON.stringify(snapshot);
  const nonce = fixed(12, 0xa0);
  const envelope = await encryptSnapshot({ sourceKey, sourceId, epoch, snapshot, nonce });
  const tampered = { ...envelope, seq: 43 };
  const rotated = await encryptSnapshot({ sourceKey: fixed(32, 0x40), sourceId, epoch: 2, snapshot: { ...snapshot, sequence: 43 }, nonce: fixed(12, 0xb0) });
  const challenge = "eyJzaWQiOiJBQUVDQXdRRkJnY0lDUW9MREEwT0R3IiwiZXhwIjoxNzkwMDAwNjAwMDAwLCJiaXRzIjoxMn0.signature-not-checked-by-clients";
  let solution = 0; while (leadingZeroBits(await sha256(`${challenge}.${solution}`)) < 12) solution++;
  const link = pairingLink({ relay: "https://meterkat-relay.fabian-duerkop.de", sourceId, code: "AbCdEfGhIjKl", sourceKey: toBase64url(sourceKey), epoch });
  return {
    description: "Meterkat relay protocol v2 test vectors. See protocol/v2.md and docs/adr/0001-relay-protocol-v2.md. Byte strings are lowercase hex unless the field name ends in B64u (base64url, no padding). Regenerate with `pnpm exec tsx scripts/protocol-v2-vectors.ts`.",
    hkdf: { ikmHex: hex(sourceKey), saltUtf8: "ai-usage/v2", infoUtf8: `snapshot-aead|${sourceId}`, length: 32, okmHex: hex(await deriveAeadKeyBytes(sourceKey, sourceId)) },
    encryption: {
      sourceKeyB64u: toBase64url(sourceKey), sourceId, epoch, nonceHex: hex(nonce),
      associatedDataUtf8: associatedData(sourceId, epoch, snapshot.sequence, snapshot.generatedAt),
      plaintextJson, paddedPlaintextLength: padPlaintext(plaintextJson).length,
      paddedPlaintextHex: hex(padPlaintext(plaintextJson)),
      envelope,
      ciphertextWithTagHex: hex(fromBase64url(envelope.ciphertext)),
    },
    mustReject: [
      { reason: "seq changed by relay (AAD mismatch)", sourceKeyB64u: toBase64url(sourceKey), sourceId, epoch, envelope: tampered },
      { reason: "wrong sourceId (different derived key)", sourceKeyB64u: toBase64url(sourceKey), sourceId: "BBECAwQFBgcICQoLDA0ODw", epoch, envelope },
      { reason: "envelope epoch 2 > paired epoch 1: key rotated, re-pair required", sourceKeyB64u: toBase64url(sourceKey), sourceId, epoch, envelope: rotated },
    ],
    pairingLink: {
      link, parsed: { relay: "https://meterkat-relay.fabian-duerkop.de", sourceId, code: "AbCdEfGhIjKl", sourceKeyB64u: toBase64url(sourceKey), epoch },
      loopbackLink: pairingLink({ relay: "http://127.0.0.1:4381", sourceId, code: "AbCdEfGhIjKl", sourceKey: toBase64url(sourceKey), epoch }),
      mustReject: [
        { reason: "plain http relay that is not loopback", link: pairingLink({ relay: "http://meterkat-relay.fabian-duerkop.de", sourceId, code: "AbCdEfGhIjKl", sourceKey: toBase64url(sourceKey), epoch }) },
        { reason: "relay with a path", link: pairingLink({ relay: "https://meterkat-relay.fabian-duerkop.de/x", sourceId, code: "AbCdEfGhIjKl", sourceKey: toBase64url(sourceKey), epoch }) },
        { reason: "custom scheme instead of the verified App Link", link: link.replace("https://meterkat.fabian-duerkop.de/pair", "aiusage://pair") },
        { reason: "other host", link: link.replace("meterkat.fabian-duerkop.de", "evil.example") },
        { reason: "key shorter than 32 bytes", link: link.replace(/#k=[^&]+/, "#k=AAECAw") },
        { reason: "missing v=2", link: link.replace("v=2&", "") },
        { reason: "epoch 0", link: link.replace(/&e=\d+$/, "&e=0") },
      ],
    },
    sourceIdMac: {
      note: "Relay-internal; clients treat source IDs as opaque. id = random(8) || HMAC-SHA256(secret, 'meterkat/source-id|' || random)[0..8]",
      secretUtf8: "example-server-secret-not-used-anywhere",
      randomHex: hex(fixed(8, 0x30)),
      sourceId: await sourceIdFor("example-server-secret-not-used-anywhere", fixed(8, 0x30)),
    },
    proofOfWork: { challenge, bits: 12, solution: String(solution), digestHex: hex(await sha256(`${challenge}.${solution}`)), note: "Smallest decimal solution; SHA-256 over UTF-8 of challenge + '.' + solution. Clients never verify the signature part." },
    tokenHash: { token: `${sourceId}.${toBase64url(fixed(32, 0x10))}`, storedHashOfSecretHex: await sha256Hex(toBase64url(fixed(32, 0x10))) },
  };
}

const file = new URL("../protocol/v2-test-vectors.json", import.meta.url);
if (process.argv[1]?.endsWith("protocol-v2-vectors.ts")) {
  const text = JSON.stringify(await vectors(), null, 2) + "\n";
  if (process.argv.includes("--check")) { if (readFileSync(file, "utf8") !== text) { console.error("Test vectors out of date"); process.exit(1); } }
  else writeFileSync(file, text);
}
