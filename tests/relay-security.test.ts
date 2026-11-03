import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relayJson, registrationFields } from '../src/relay-response.js';
import { solveChallenge, registerV2, writerCall, pairingLinkV2 } from '../src/relay-v2.js';

test('reject invalid and excessive work without hashing; enforce computation deadline', () => {
  for (const bits of [256, NaN, -1, 1.5, 23]) assert.throws(() => solveChallenge('challenge', bits), /Unsupported/);
  assert.throws(() => solveChallenge('x'.repeat(2049), 8), /Unsupported/);
  let clock = 0;
  assert.throws(() => solveChallenge('challenge', 22, { now: () => ++clock, timeoutMs: 1 }), /timed out/);
  assert.equal(solveChallenge('challenge', 0), '0');
});

test('reject chunked oversized relay response and cancel stream', async () => {
  let cancelled = false;
  const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(8193)); }, cancel() { cancelled = true; } });
  await assert.rejects(relayJson(new Response(body)), /too large/);
  assert.equal(cancelled, true);
  for (const body of ['null', '[]', '"text"']) await assert.rejects(relayJson(new Response(body)), /Invalid/);
});

test('registration allowlist preserves origin and drops protocol/key injection', () => {
  const sourceId = 'a'.repeat(43), writerToken = 'b'.repeat(43);
  const fields = registrationFields({ sourceId, writerToken, relay: 'http://evil', protocol: 2, sourceKey: 'evil' }, false);
  assert.deepEqual({ relay: 'https://expected', ...fields }, { relay: 'https://expected', sourceId, writerToken });
  assert.throws(() => registrationFields({ sourceId: 'a'.repeat(22), writerToken }, true), /credentials/);
});

test('network entry points reject malformed successful responses', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ sourceId: 'invalid', writerToken: 'bad' });
    await assert.rejects(registerV2('https://relay', 'admin'), /credentials/);
    const config = { relay: 'https://relay', sourceId: 'a'.repeat(22), writerToken: 'b', protocol: 2 as const, sourceKey: 'key', epoch: 1 };
    globalThis.fetch = async () => Response.json({ code: {}, expiresAt: Infinity });
    await assert.rejects(writerCall(config, '/v2/pairing', 'POST'), /pairing/);
    globalThis.fetch = async () => Response.json({ devices: [{ id: '../bad', pairedAt: 1 }] });
    await assert.rejects(writerCall(config, '/v2/devices', 'GET'), /devices/);
  } finally { globalThis.fetch = original; }
});

test('legacy registration cannot persist relay-selected config fields', async t => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { registerWithRelay } = await import('../src/registration.js');
  const { readState } = await import('../src/state.js');
  const directory = mkdtempSync(join(tmpdir(), 'relay-security-'));
  const previous = process.env.AI_USAGE_STATE_DIR;
  process.env.AI_USAGE_STATE_DIR = directory;
  t.after(() => { if (previous === undefined) delete process.env.AI_USAGE_STATE_DIR; else process.env.AI_USAGE_STATE_DIR = previous; rmSync(directory, { recursive: true, force: true }); });
  await registerWithRelay('https://expected.example', { v1: true, adminToken: 'admin' }, async () => Response.json({ sourceId: 'a'.repeat(43), writerToken: 'b'.repeat(43), relay: 'http://attacker', protocol: 2, sourceKey: 'attacker' }));
  assert.deepEqual(readState('config.json'), { relay: 'https://expected.example', sourceId: 'a'.repeat(43), writerToken: 'b'.repeat(43) });
});


test('pairing accepts valid timestamps despite relay clock skew', async () => {
  const original = globalThis.fetch;
  const config = { relay: 'https://relay.example', sourceId: 'a'.repeat(22), writerToken: 'b', protocol: 2 as const, sourceKey: 'A'.repeat(43), epoch: 1 };
  try {
    for (const skew of [-600_000, -2000, 0, 2000, 600_000]) {
      const expiresAt = Date.now() + 300_000 + skew;
      globalThis.fetch = async () => Response.json({ code: 'AbCdEfGhIjKl', expiresAt });
      const pair = await pairingLinkV2(config);
      assert.equal(pair.expiresAt, expiresAt);
      assert.equal(new URL(pair.link).searchParams.get('code'), 'AbCdEfGhIjKl');
    }
  } finally { globalThis.fetch = original; }
});
