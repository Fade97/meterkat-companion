import { createHash } from "node:crypto";
import { hostname } from "node:os";

/**
 * Opaque subscription fingerprint (#68): the same on every computer signed in to the same account, so a phone paired
 * with several companions shows that subscription once. Account ID and e-mail never leave this computer; only this
 * truncated hash does, inside the end-to-end encrypted snapshot. Without an account ID there is no fingerprint.
 */
export function accountFingerprint(provider: string, accountId: unknown, email: unknown): string | undefined {
  if (typeof accountId !== "string" || !accountId.trim()) return undefined;
  const mail = typeof email === "string" ? email.trim().toLowerCase() : "";
  return createHash("sha256").update(`meterkat-account/v1|${provider}|${accountId.trim()}|${mail}`).digest().subarray(0, 16).toString("base64url");
}

/** Label for this computer on the phone: AI_USAGE_NAME, else the short host name, reduced to the snapshot's label characters. */
export function companionName(env: NodeJS.ProcessEnv = process.env, host = hostname()): string | undefined {
  const raw = env.AI_USAGE_NAME?.trim() || host.split(".")[0] || "";
  return raw.replace(/[^\p{L}\p{N} _().:+/-]/gu, "").slice(0, 32).trim() || undefined;
}
