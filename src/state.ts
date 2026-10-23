import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// Installations from before the Meterkat rename keep their `ai-usage` state directory (credentials,
// pairing, snapshots) in place; a fresh installation uses `meterkat`. Nothing is moved under a running companion.
export function defaultStateDirectory(env: NodeJS.ProcessEnv = process.env, home = homedir(), exists: (path: string) => boolean = existsSync) {
  const base = env.LOCALAPPDATA ?? join(home, ".local", "state");
  const current = join(base, "meterkat"); const legacy = join(base, "ai-usage");
  return !exists(current) && exists(legacy) ? legacy : current;
}
export const stateDirectory = () => process.env.AI_USAGE_STATE_DIR ?? defaultStateDirectory();
export function readState<T>(name: string): T | undefined {
  try { return JSON.parse(readFileSync(join(stateDirectory(), name), "utf8")) as T; } catch { return undefined; }
}
export function writeState(name: string, value: unknown) {
  mkdirSync(stateDirectory(), { recursive: true, mode: 0o700 });
  const target = join(stateDirectory(), name); const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, target);
}
export type Config = { relay: string; writerToken: string; sourceId: string };
export function relayUrl(input: string) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new Error("Use a relay origin without credentials, path or query");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("HTTPS is required except for local development");
  return url.origin;
}
export function removeState(name: string) { rmSync(join(stateDirectory(), name), { force: true }); }
