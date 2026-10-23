import { createPublicKey, verify } from "node:crypto";

// Ed25519 public keys (SPKI DER, base64) trusted to sign a release's SHA256SUMS. The private key never enters this
// repository or CI; the maintainer signs locally with scripts/publish-release.ts.
// Rotation adds the new key here first and removes the old one a release later (docs/releasing.md).
export const RELEASE_PUBLIC_KEYS: readonly string[] = [
  "MCowBQYDK2VwAyEAsfoAgmlN/MNRT0/+INbbeSy/9oDUfK5CWQMZmUg0hNc=",
];

/** True when `signature` (base64 text of SHA256SUMS.sig) is a valid Ed25519 signature of `data` by a trusted key. */
export function verifySignature(data: Buffer, signature: string, keys: readonly string[] = RELEASE_PUBLIC_KEYS) {
  const raw = Buffer.from(signature.trim(), "base64");
  if (raw.length !== 64) return false;
  return keys.some(key => {
    try { return verify(null, data, createPublicKey({ key: Buffer.from(key, "base64"), format: "der", type: "spki" }), raw); } catch { return false; }
  });
}
