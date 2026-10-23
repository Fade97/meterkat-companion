# ADR 0001: Relay protocol v2 with end-to-end encryption and self-service registration

- Status: accepted (implemented for companion, Node relay, Cloudflare Worker and the Android client)
- Date: 2026-10-22

## Context

Protocol v1 (`/v1/*`, `services/relay/server.ts`) sends allowlisted quota snapshots to the relay in plaintext. Sources are created only with the operator's `RELAY_ADMIN_TOKEN`. That is acceptable for the operator-run private pilot, but not for a public, free, hosted relay:

- The operator, or anyone who compromises the relay, can read every user's usage.
- End users can't create a source without an operator.
- The relay must withstand anonymous abuse (mass registration, oversized bodies, pairing-code guessing).

Constraints:

- The Android client must implement the crypto on API 26 with the platform JCA and no native libraries. X25519 and ChaCha20-Poly1305 are not available on API 26; AES-GCM and HMAC-SHA256 are.
- Pairing already uses a QR code / `aiusage://pair` link shown on the desktop. That is an authenticated, out-of-band channel from the companion to the phone that the relay never sees.
- The private pilot runs v1 and must keep working until phones migrate.

## Decision

### 1. Keys

The companion generates a random 32-byte **source key** `K` (CSPRNG) at registration and stores it in its private state (`config.json`, mode 0600, the same protection as the writer token). `K` reaches a phone only inside the fragment of the pairing link. The relay never receives it.

A source key has an **epoch** (integer, starts at 1). Rotating the key increments the epoch.

The AEAD key is derived per source with HKDF-SHA256 (RFC 5869):

```
aeadKey = HKDF-SHA256(
  IKM  = K,
  salt = UTF-8("ai-usage/v2"),
  info = UTF-8("snapshot-aead|" + sourceId),
  L    = 32)
```

Binding `sourceId` into `info` means a key cannot be reused across sources by accident or by a relay that swaps source IDs.

**Why a symmetric key instead of an X25519 exchange:** the pairing channel is already a confidential, authenticated one-way channel from the companion to the phone (QR on the user's own screen, or a link the user copies themselves). An ephemeral key agreement would add no protection against an attacker who can read that channel, and API 26 has no X25519. A symmetric key also lets the companion encrypt one ciphertext for every paired phone. The cost is that every phone of a source holds the same key; removing a phone's ability to decrypt future data requires a key rotation (section 5).

### 2. Envelope

The plaintext is the existing v1 snapshot JSON (`shared/snapshot.ts`, `schemaVersion: 1`), serialized as UTF-8 and **right-padded with ASCII spaces (0x20) to a multiple of 256 bytes**. Padding hides small size differences (number of meters/providers). Parsers must accept trailing whitespace; Kotlin clients should trim trailing spaces before parsing.

Encryption: AES-256-GCM, a fresh random 96-bit nonce per message, 128-bit tag.

Associated data (UTF-8):

```
"ai-usage/v2|" + sourceId + "|" + epoch + "|" + seq + "|" + generatedAt
```

Integers are base-10 without leading zeros or signs.

Wire format (JSON, the only body of `PUT /v2/snapshot` and of `GET /v2/snapshot`):

```json
{ "v": 2, "epoch": 1, "seq": 42, "generatedAt": 1790000000000,
  "nonce": "<base64url, 12 bytes>", "ciphertext": "<base64url, ciphertext||tag>" }
```

All base64 is RFC 4648 §5 base64url **without padding**.

`seq` and `generatedAt` are visible to the relay in plaintext so that it can enforce ordering, and they are authenticated through the associated data, so the relay cannot alter them. After decryption the phone **must** check that the inner `sequence` and `generatedAt` equal the envelope values.

Nonce reuse: at one upload per minute a source produces ~525,000 messages per year, far below the 2^32 random-nonce bound for a single GCM key. Key rotation resets the count.

### 3. What the relay stores

Per source: source ID, SHA-256 hashes of the writer token and reader tokens, the latest envelope (nonce and ciphertext), `epoch`, `seq`, `generatedAt`, envelope size, `created_at`, `uploaded_at`, `last_seen_at` (relay clock), device IDs with pairing time, the hash of at most one pending pairing code with its expiry and wrong-guess count, and the retention alarm time. No provider names, quota values, IP addresses or user identifiers are stored. Rate limiting uses the client IP transiently (Cloudflare Rate Limiting counters / in-memory on Node) and never persists it.

### 4. Replay and freshness

Relay (rejects with `409`, or `400` for a `generatedAt` in the future):

- `epoch` must be ≥ the stored epoch.
- `seq` must be strictly greater than the stored `seq`.
- `generatedAt` must be ≥ the stored `generatedAt` and ≤ relay time + 5 minutes (`400` otherwise).
- These watermarks survive snapshot retention purges (same rule as v1, `docs/relay-lifecycle.md`).

Phone (the relay is not trusted, so these checks are mandatory):

1. Envelope epoch must equal the epoch stored at pairing. A higher epoch means the source key was rotated: show "re-pair required". A lower one is ignored.
2. GCM decryption must succeed; otherwise discard (tampering or wrong key).
3. Inner `sequence`/`generatedAt` must equal the envelope's.
4. `seq` must be greater than the last accepted `seq`; otherwise keep the current data (the relay may replay or roll back).
5. The inner snapshot passes the same allowlist validation as v1, and per-provider `sampledAt` must not go backwards. The relay can no longer check `sampledAt` because it can't read it; this moves to the phone.
6. Staleness is shown from `generatedAt` against the phone's clock, exactly as today. A relay that withholds new uploads can only make data look old, never fresh.

### 5. Credentials, pairing, rotation, re-pair, loss

Tokens are opaque bearer strings `"<sourceId>.<secret>"` where `secret` is 32 random bytes base64url. The sourceId prefix lets the hosted relay route to the source's Durable Object without a global index. Only `SHA-256(secret)` is stored.

**Source IDs are MACed by the relay:** 16 bytes = 8 random bytes ‖ the first 8 bytes of `HMAC-SHA256(serverSecret, "meterkat/source-id|" ‖ random)`. The hosted Worker verifies the MAC before it touches any Durable Object, so forged tokens or pairing requests with made-up IDs cost one HMAC and never instantiate storage. Clients treat the ID as opaque. Rotating the server secret invalidates every source (equivalent to deleting all of them), so it is reserved for compromise.

| Credential | Held by | Allows |
| --- | --- | --- |
| writer token | companion | upload, create pairing code, list/revoke devices, revoke all, delete source |
| reader token | one phone | read the latest envelope, revoke itself |
| source key `K` | companion + paired phones | decrypt; never sent to the relay |

**Pairing link** (QR content), shown only on the companion's machine:

```
https://meterkat.fabian-duerkop.de/pair?v=2&relay=<origin>&source=<sourceId>&code=<code>#k=<base64url K>&e=<epoch>
```

The link must reach the app over a channel no other app can intercept. A custom scheme such as `aiusage://` is **not** acceptable for v2: any installed app can register the same scheme and receive the key. Phones accept a v2 link only through:

1. the app's own in-app QR scanner, or
2. a **verified Android App Link** for `https://meterkat.fabian-duerkop.de/pair` (`autoVerify`; `/.well-known/assetlinks.json` for package `de.fabianduerkop.meterkat` is hosted on that site).

The in-app scanner is the fallback when App Link verification isn't available. `aiusage://` remains pilot-only legacy for v1 links.

If the app isn't installed, the browser opens the site's `/pair` page. The fragment, and with it the key, is never sent to the web server. The `relay` parameter must be `https://`, or `http://` on loopback for development; the phone rejects anything else.

The phone parses query and fragment, calls `POST /v2/pair {sourceId, code}`, and stores the reader token together with `K` and `epoch` (Android Keystore-wrapped storage on the phone). Codes are single-use, expire after 5 minutes, 72 random bits, and are burned after 5 wrong guesses for that source.

Accepted risk: anyone who knows a source ID can burn its pending code with 5 wrong guesses. Source IDs aren't public (they appear only in the writer's config, paired phones and the QR shown on the user's screen), forged IDs fail the MAC check, and the per-IP pair limit applies. The effect is a nuisance only: the user generates a new code. No per-IP-per-source failure state is kept, because it would mean storing client IPs. Because the key is required, v2 has no manual "type the code" path; users copy the link or scan the QR.

**Re-pair (add or replace a phone):** `pair` creates a new code with the same `K`/epoch. Existing phones are unaffected.

**Revoke one phone:** `DELETE /v2/devices/<id>` (companion) or `DELETE /v2/device` (phone itself). The phone loses relay access immediately. It still knows `K`; if that matters (lost or stolen phone), rotate.

**Rotation:** `companion rotate-key` generates a new `K`, increments the epoch and **saves them first** (marked `revokePending`), then revokes every reader and pending code (`POST /v2/revoke`). If the revoke call fails, running `rotate-key` again retries only the revocation; the new key is never lost. The next snapshot is uploaded under the new epoch. Every phone must re-pair. Rotation is also the remedy for a suspected key leak.

**Loss:** there is no recovery and no escrow. If the companion loses its state (writer token or `K`), the user registers a new source and re-pairs; the old source expires through stale-source cleanup or can be deleted by the operator. If a phone loses its data, it re-pairs.

**Deletion:** `DELETE /v2/source` (writer) removes the source, its devices, its code and the stored envelope. On the hosted relay this calls `deleteAll()` on the source's Durable Object. The companion's `delete` command also removes its local key and credentials.

### 6. Self-service registration and abuse limits

Anonymous registration uses a stateless, HMAC-signed **proof-of-work challenge**. Turnstile needs a browser and doesn't fit a CLI companion; PoW costs a legitimate user about a second once, and makes mass registration expensive.

1. `GET /v2/challenge` → `{ challenge, bits, expiresAt }`. `challenge` is `base64url(JSON{sid, exp, bits}) + "." + base64url(HMAC-SHA256(serverSecret, payload))`. `sid` is the server-chosen future source ID; `exp` is 10 minutes ahead.
2. The client finds the smallest decimal `solution` (`"0"`, `"1"`, …) such that `SHA-256(UTF-8(challenge + "." + solution))` has at least `bits` leading zero bits.
3. `POST /v2/sources {challenge, solution}` → `201 {sourceId, writerToken}`. The relay verifies the HMAC, expiry and work, then initialises source `sid`. A challenge can't be used twice because the source `sid` already exists (`409`).

An operator (or a closed self-hosted relay) may instead send `Authorization: Bearer <admin token>` to `POST /v2/sources` with an empty body.

Limits:

| Limit | Hosted default | Where |
| --- | --- | --- |
| all `/v2` requests per client | 120 / min | Workers Rate Limiting (approximate, per location) |
| challenges per client | 20 / min | Workers Rate Limiting |
| registrations per client | 5 / min | Workers Rate Limiting |
| registrations, all clients | 60 / min per location | Workers Rate Limiting (key `global`) |
| pair attempts per client | 10 / min | Workers Rate Limiting |
| forged source IDs | rejected before storage | source-ID MAC |
| PoW difficulty | 20 bits (~1 M hashes) | `POW_BITS` |
| request body | 16 KiB | router |
| ciphertext | ≤ 12 KiB | envelope validation |
| accepted uploads per source | 1 per 20 s (`429` otherwise) | source |
| paired devices per source | 10 | source |
| wrong pairing guesses | 5 per code, then the code is burned | source |
| snapshot retention | 72 h without upload → ciphertext cleared | source alarm |
| stale source | 90 days without upload → source deleted | source alarm |
| unused source | 72 h after registration with no upload and no paired phone → deleted | source alarm |

"Client" means the IPv4 address, or the /64 prefix for IPv6 (one host usually controls a whole /64). `POW_BITS` must be an integer from 0 to 32; the Worker answers `503` when it or the server secret is missing or invalid. Request bodies are read as a stream and cut off at 16 KiB regardless of `Content-Length`. Malformed input is `400`; unexpected failures are `500`, never disguised as client errors.

The Node relay applies the same per-source limits. Its registration is closed (admin token only) unless `RELAY_OPEN_REGISTRATION=1`; its IP limiter uses the socket peer.

### 7. Hosted architecture

Cloudflare Worker (`services/relay-worker`) with one SQLite-backed **Durable Object per source** (`getByName(sourceId)`). The Worker does stateless work (routing, rate limits, PoW verification, body limits, envelope shape checks, token hashing) and calls the DO over RPC. The DO runs the same per-source SQL module as the Node relay (`services/relay/v2/source.ts`), giving strong per-source consistency for sequence checks and single-use pairing, and an alarm per source for retention instead of a global sweep.

D1 was considered. A single D1 database adds a global write hot spot and needs a cron sweep; per-source DOs match the access pattern (every request is scoped to one source). D1 also needs an extra API-token permission.

### 8. Versioning and migration

- `/v1/*` is unchanged on the Node relay. The hosted Worker serves only `/v2/*` and `/health`.
- The companion keeps uploading v1 when its `config.json` has no `protocol: 2` (existing pilot installs). `register` creates v2 sources by default; `register --v1` keeps the operator flow.
- A phone migrates by re-pairing with a v2 link. There is no in-place upgrade, because v1 never distributed a key.
- `pnpm dev` uses v2 since the Android client supports it; `AI_USAGE_PROTOCOL=1 pnpm dev` keeps a v1 source for relay tests. The Android app no longer speaks v1 and no longer registers `aiusage://`.

## Consequences

- The relay operator can no longer read quota data. Abuse handling is limited to metadata (sizes, rates) and deletion.
- Per-provider sample replay checks move from the relay to the phone.
- Phones of one source share a key; per-phone cryptographic revocation requires rotation and re-pairing all phones.
- Manual code entry without the link is not possible in v2.
- The companion deletes its local pairing page (which contains `K`) once the code has expired.
- The companion's `generatedAt` is monotonic (`max(now, previous + 1)`), so a small clock step back does not stall uploads with `409`.
- Test vectors in [`protocol/v2-test-vectors.json`](../../protocol/v2-test-vectors.json) pin HKDF, AAD, AES-GCM, padding, link parsing and PoW for the Kotlin implementation. The protocol reference for client authors is [`protocol/v2.md`](../../protocol/v2.md).
