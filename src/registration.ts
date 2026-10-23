import { registerV2 } from "./relay-v2.js";
import { relayUrl, removeState, writeState, type Config } from "./state.js";

export const HOSTED_RELAY = "https://meterkat-relay.fabian-duerkop.de";
export const STAGING_RELAY = "https://meterkat-relay-staging.fabian-duerkop.de";
/** Relay for `setup` without --relay: AI_USAGE_RELAY (e.g. staging) or the hosted production relay. */
export const defaultRelay = (env: NodeJS.ProcessEnv = process.env) => env.AI_USAGE_RELAY ? relayUrl(env.AI_USAGE_RELAY) : HOSTED_RELAY;
const isHostedRelay = (relay: string) => relay === HOSTED_RELAY || relay === STAGING_RELAY;

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
    const config = { relay, ...await response.json() as Omit<Config, "relay"> };
    writeState("config.json", config); return config;
  }
  const adminToken = isHostedRelay(relay) ? undefined : options.adminToken;
  if (!adminToken) options.onProofOfWork?.();
  const config = await registerV2(relay, adminToken);
  writeState("config.json", config); removeState("snapshot.json");
  return config;
}
