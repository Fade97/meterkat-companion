import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mintSourceId, parsePowBits, verifySourceId, decryptEnvelope, encryptSnapshot, fromBase64url, parseEnvelope, parsePairingLink, parseToken, randomBytes, signChallenge, toBase64url, verifyChallenge, type Envelope } from "../shared/protocol-v2.js";
import { solveChallenge } from "../src/relay-v2.js";
import { vectors } from "../scripts/protocol-v2-vectors.js";
import { unavailable } from "../shared/snapshot.js";

const fixture = JSON.parse(readFileSync(new URL("../protocol/v2-test-vectors.json", import.meta.url), "utf8"));
const key = (b64u: string) => fromBase64url(b64u) as Uint8Array<ArrayBuffer>;

test("published test vectors match the implementation", async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(await vectors())), fixture);
  const e = fixture.encryption;
  const snapshot = await decryptEnvelope({ sourceKey: key(e.sourceKeyB64u), sourceId: e.sourceId, epoch: e.epoch, now: e.envelope.generatedAt }, e.envelope);
  assert.deepEqual(snapshot, JSON.parse(e.plaintextJson));
  for (const bad of fixture.mustReject) {
    await assert.rejects(decryptEnvelope({ sourceKey: key(bad.sourceKeyB64u), sourceId: bad.sourceId, epoch: bad.epoch, now: e.envelope.generatedAt }, bad.envelope), bad.reason);
  }
  const parsed = fixture.pairingLink.parsed;
  assert.deepEqual(parsePairingLink(fixture.pairingLink.link), { relay: parsed.relay, sourceId: parsed.sourceId, code: parsed.code, sourceKey: parsed.sourceKeyB64u, epoch: parsed.epoch });
  assert.equal(parsePairingLink(fixture.pairingLink.loopbackLink).relay, "http://127.0.0.1:4381");
  for (const bad of fixture.pairingLink.mustReject) assert.throws(() => parsePairingLink(bad.link), undefined, bad.reason);
  assert.equal(solveChallenge(fixture.proofOfWork.challenge, fixture.proofOfWork.bits), fixture.proofOfWork.solution);
  assert(await verifySourceId(fixture.sourceIdMac.secretUtf8, fixture.sourceIdMac.sourceId));
});

test("round trip uses fresh nonces, pads plaintext and hides it from the relay", async () => {
  const sourceKey = randomBytes(32), sourceId = toBase64url(randomBytes(16));
  const snapshot = { schemaVersion: 1 as const, sequence: 1, generatedAt: Date.now(), providers: [unavailable("claude")] };
  const a = await encryptSnapshot({ sourceKey, sourceId, epoch: 1, snapshot });
  const b = await encryptSnapshot({ sourceKey, sourceId, epoch: 1, snapshot });
  assert.notEqual(a.nonce, b.nonce); assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal((fromBase64url(a.ciphertext).length - 16) % 256, 0);
  assert(!JSON.stringify(a).includes("claude"));
  assert.deepEqual(parseEnvelope(a), a);
  assert.deepEqual(await decryptEnvelope({ sourceKey, sourceId, epoch: 1 }, a), snapshot);
  const flipped = fromBase64url(a.ciphertext); flipped[0]! ^= 1;
  await assert.rejects(decryptEnvelope({ sourceKey, sourceId, epoch: 1 }, { ...a, ciphertext: toBase64url(flipped) }), /authentication/);
  await assert.rejects(decryptEnvelope({ sourceKey, sourceId, epoch: 2 }, a), /Outdated/);
});

test("relay envelope validation rejects malformed or oversized input", () => {
  const ok: Envelope = { v: 2, epoch: 1, seq: 1, generatedAt: 1000, nonce: toBase64url(new Uint8Array(12)), ciphertext: toBase64url(new Uint8Array(272)) };
  assert.doesNotThrow(() => parseEnvelope(ok, 1000));
  for (const bad of [{ ...ok, v: 1 }, { ...ok, seq: 0 }, { ...ok, epoch: 1.5 }, { ...ok, generatedAt: 1000 + 300_001 }, { ...ok, nonce: toBase64url(new Uint8Array(11)) },
    { ...ok, ciphertext: toBase64url(new Uint8Array(100)) }, { ...ok, ciphertext: toBase64url(new Uint8Array(12_288 + 256)) }, { ...ok, ciphertext: "not base64!" }, null, []]) {
    assert.throws(() => parseEnvelope(bad, 1000));
  }
});

test("tokens, links and challenges reject tampering", async () => {
  const id = toBase64url(randomBytes(16)), secret = toBase64url(randomBytes(32));
  assert.deepEqual(parseToken(`${id}.${secret}`), { sourceId: id, secret });
  for (const bad of ["", id, `${id}.${secret}.x`, `${id}x.${secret}`, `${id}.short`]) assert.equal(parseToken(bad), undefined);
  assert.throws(() => parsePairingLink("aiusage://pair?relay=https://x&code=abc"));
  const minted = await mintSourceId("server-secret");
  assert(await verifySourceId("server-secret", minted));
  assert(!await verifySourceId("other-secret", minted));
  assert(!await verifySourceId("server-secret", id), "random IDs fail the MAC");
  // The last base64url char carries 4 spare bits; flipping them must not yield a second valid ID.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = alphabet.indexOf(minted.at(-1)!);
  for (let spare = 1; spare < 16; spare++) assert(!await verifySourceId("server-secret", minted.slice(0, -1) + alphabet[last ^ spare]), "non-canonical aliases are rejected");
  for (const bad of ["33", "-1", "1.5", "", "abc"]) assert.throws(() => parsePowBits(bad));
  assert.equal(parsePowBits("20"), 20); assert.equal(parsePowBits(0), 0);
  const challenge = await signChallenge("server-secret", { sid: id, exp: 2000, bits: 8 });
  const solution = solveChallenge(challenge, 8);
  assert.equal((await verifyChallenge("server-secret", challenge, solution, 1000))?.sid, id);
  assert.equal(await verifyChallenge("server-secret", challenge, solution, 2001), undefined, "expired");
  assert.equal(await verifyChallenge("other-secret", challenge, solution, 1000), undefined, "wrong key");
  const [body, signature] = challenge.split(".");
  const forged = `${toBase64url(new TextEncoder().encode(JSON.stringify({ sid: id, exp: 2000, bits: 0 })))}.${signature}`;
  assert.equal(await verifyChallenge("server-secret", forged, "0", 1000), undefined, "forged difficulty");
  assert(body);
});
