import { relayJson, registrationFields } from "./relay-response.js";
import { registerV2 } from "./relay-v2.js";
import { readState, relayUrl, removeState, writeState, type Config } from "./state.js";

export const HOSTED_RELAY = "https://relay.meterkat.fdu.gg";
export const STAGING_RELAY = "https://relay-staging.meterkat.fdu.gg";
/** Earlier hostnames of the same hosted relays (until 2026-11), mapped to the current ones. */
const LEGACY_HOSTED_RELAYS: Record<string, string> = {
  "https://meterkat-relay.fabian-duerkop.de": HOSTED_RELAY,
  "https://meterkat-relay-staging.fabian-duerkop.de": STAGING_RELAY,
};
/** Relay for `setup` without --relay: AI_USAGE_RELAY (e.g. staging) or the hosted production relay. */
export const defaultRelay = (env: NodeJS.ProcessEnv = process.env) => env.AI_USAGE_RELAY ? relayUrl(env.AI_USAGE_RELAY) : HOSTED_RELAY;
const isHostedRelay = (relay: string) => relay === HOSTED_RELAY || relay === STAGING_RELAY || relay in LEGACY_HOSTED_RELAYS;
/** Moves a registration from an earlier hosted-relay hostname to the current one. Both serve the same relay, so the
 *  source, its tokens and paired phones are unaffected; only new pairing links carry the new hostname. */
export function migrateHostedRelay() {
  const config = readState<Config>("config.json");
  const relay = config && Object.hasOwn(LEGACY_HOSTED_RELAYS, config.relay) ? LEGACY_HOSTED_RELAYS[config.relay] : undefined;
  if (config && relay) writeState("config.json", { ...config, relay });
}

export type RegistrationOptions = {
  /** Operator credential for closed self-hosted relays. Never sent to the hosted Meterkat relays. */
  adminToken?: string;
  /** Protocol v1 (private pilot, operator-provisioned, plaintext snapshots). */
  v1?: boolean;
  onProofOfWork?: () => void;
};

// Single integration point for relay registration, used by `register` and `setup`. The default is protocol v2:
// anonymous proof-of-work registration (docs/protocol/v2.md) with a locally generated source key.
export async function registerWithRelay(relayOrigin: string, options: RegistrationOptions = {}, fetchImpl: typeof fetch = fetch): Promise<Config> {
  const relay = relayUrl(relayOrigin);
  if (options.v1) {
    if (!options.adminToken) throw new Error("Protocol v1 registration requires RELAY_ADMIN_TOKEN");
    const response = await fetchImpl(`${relay}/v1/sources`, { method: "POST", headers: { Authorization: `Bearer ${options.adminToken}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (!response.ok) throw new Error(`Relay request failed (${response.status})`);
    const config = { relay, ...registrationFields(await relayJson(response), false) };
    writeState("config.json", config); return config;
  }
  const adminToken = isHostedRelay(relay) ? undefined : options.adminToken;
  if (!adminToken) options.onProofOfWork?.();
  const config = await registerV2(relay, adminToken);
  writeState("config.json", config); removeState("snapshot.json");
  return config;
}
