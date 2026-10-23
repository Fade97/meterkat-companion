import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, linkSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { COMPANION_VERSION } from "./version.js";
import { readState, writeState } from "./state.js";
import { RELEASE_PUBLIC_KEYS, verifySignature } from "./release-key.js";

// Self-update for the packaged single-file companion from this repository's GitHub releases (binaries built
// by its release workflow, signed by the maintainer). Releases are tagged `companion-v<semver>`; drafts are never visible and
// prereleases are ignored unless explicitly requested. SHA256SUMS must carry a valid Ed25519 signature by an
// embedded release key (SHA256SUMS.sig); the binary must then match its signed checksum, its size and the digest
// GitHub reports. Updating never touches autostart: the binary is replaced at the same path.
export const UPDATE_REPO = process.env.AI_USAGE_UPDATE_REPO ?? "Fade97/meterkat-companion";
export const TAG_PREFIX = "companion-v";
export const SUMS_ASSET = "SHA256SUMS";
export const SIGNATURE_ASSET = "SHA256SUMS.sig";
const MAX_SMALL_BYTES = 64_000;
const MAX_BINARY_BYTES = 300_000_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type Asset = { name: string; size: number; url: string; digest?: string | null };
export type Release = { tag: string; version: string; assets: Asset[] };
export type Fetch = typeof fetch;
export type Runner = (file: string, args: string[]) => { status: number | null; stdout: string };
export type UpdateSettings = { automatic?: boolean; lastCheck?: number; skipped?: string };
export type UpdateResult = { status: "current" | "updated" | "rolled-back" | "unavailable"; version: string; message: string };

export const osName = (platform: NodeJS.Platform) => platform === "win32" ? "windows" : platform;
/** Release asset for one platform, e.g. meterkat-companion-1.0.0-windows-x64.exe; shared with the packaging script. */
export const releaseAssetName = (version: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch) =>
  `meterkat-companion-${version}-${osName(platform)}-${arch}${platform === "win32" ? ".exe" : ""}`;
/** Desktop app builds (desktop/), one per target that has one: an AppImage for linux-x64, an installer for windows-x64. */
export const desktopAssetName = (version: string, target: string) =>
  ({ "linux-x64": `meterkat-desktop-${version}-linux-x64.AppImage`, "windows-x64": `meterkat-desktop-${version}-windows-x64-setup.exe` } as Record<string, string>)[target];

type Version = { core: [number, number, number]; pre: string };
export function parseVersion(value: string): Version | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value);
  return match ? { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ?? "" } : undefined;
}
/** Semver 2.0 precedence: a prerelease sorts before its release; numeric identifiers compare numerically. */
export function compareVersions(a: string, b: string) {
  const x = parseVersion(a); const y = parseVersion(b);
  if (!x || !y) throw new Error("Invalid version");
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1; if (!y.pre) return -1;
  const p = x.pre.split("."); const q = y.pre.split(".");
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    const m = p[i]!; const n = q[i]!; if (m === n) continue;
    const mNum = /^\d+$/.test(m); const nNum = /^\d+$/.test(n);
    if (mNum && nNum) return Number(m) - Number(n);
    if (mNum !== nNum) return mNum ? -1 : 1;
    return m < n ? -1 : 1;
  }
  return p.length - q.length;
}
export const isPrerelease = (version: string) => !!parseVersion(version)?.pre;

// Unauthenticated: the releases repository is public and no credential ever reaches the updater.
const headers = (): Record<string, string> => ({ Accept: "application/vnd.github+json", "User-Agent": `meterkat-companion/${COMPANION_VERSION}` });
/** Prereleases are opt-in (testing): `update --prerelease` or AI_USAGE_UPDATE_PRERELEASE=1. */
export const prereleasesWanted = (env: NodeJS.ProcessEnv = process.env) => env.AI_USAGE_UPDATE_PRERELEASE === "1";

export async function latestRelease(fetchImpl: Fetch = fetch, repo = UPDATE_REPO, prerelease = prereleasesWanted()): Promise<Release | undefined> {
  const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=50`, { headers: headers(), signal: AbortSignal.timeout(20_000), redirect: "error" });
  if (response.status === 404) throw new Error(`Release source ${repo} not found or not public`);
  if (!response.ok) throw new Error(`Release check failed (${response.status})`);
  const list = await response.json() as unknown;
  if (!Array.isArray(list)) throw new Error("Unexpected release list");
  let best: Release | undefined;
  for (const item of list as any[]) {
    if (item?.draft || typeof item?.tag_name !== "string" || !item.tag_name.startsWith(TAG_PREFIX)) continue;
    const version = item.tag_name.slice(TAG_PREFIX.length);
    // Prerelease status comes from the version itself, which the signed SHA256SUMS binds through the asset
    // name (and the binary must report it after the swap), never from the editable API flag.
    if (!parseVersion(version) || (isPrerelease(version) && !prerelease) || (best && compareVersions(version, best.version) <= 0)) continue;
    const assets: Asset[] = (Array.isArray(item.assets) ? item.assets : [])
      .filter((a: any) => typeof a?.name === "string" && typeof a?.url === "string" && Number.isInteger(a?.size))
      .map((a: any) => ({ name: a.name, size: a.size, url: a.url, digest: typeof a.digest === "string" ? a.digest : null }));
    best = { tag: item.tag_name, version, assets };
  }
  return best;
}

export function checksumFor(sums: string, name: string) {
  for (const line of sums.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match && match[2] === name) return match[1]!;
  }
  return undefined;
}

/** Downloads may only touch GitHub's API and its asset storage, over HTTPS. */
export function allowedDownloadUrl(value: string) {
  let url: URL; try { url = new URL(value); } catch { return false; }
  const host = url.hostname.toLowerCase();
  return url.protocol === "https:" && !url.username && !url.password && (host === "api.github.com" || host === "github.com" || host.endsWith(".githubusercontent.com"));
}
// Assets are fetched through their API URL; each redirect hop is checked against the allowlist.
async function fetchAsset(fetchImpl: Fetch, asset: Asset) {
  let url = asset.url;
  for (let hop = 0; hop < 5; hop++) {
    if (!allowedDownloadUrl(url)) throw new Error("Unexpected download location");
    const response = await fetchImpl(url, { headers: { ...headers(), Accept: "application/octet-stream" }, redirect: "manual", signal: AbortSignal.timeout(hop ? 600_000 : 30_000) });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Unexpected download redirect");
      url = new URL(location, url).toString(); continue;
    }
    if (!response.ok) throw new Error(`Download failed (${response.status})`);
    return response;
  }
  throw new Error("Too many download redirects");
}

/** Streams an asset to `file` and returns its SHA-256; aborts once the advertised size is exceeded. */
export async function download(fetchImpl: Fetch, asset: Asset, file: string, maxBytes = MAX_BINARY_BYTES) {
  if (asset.size <= 0 || asset.size > maxBytes) throw new Error("Unexpected asset size");
  const response = await fetchAsset(fetchImpl, asset);
  if (!response.body) throw new Error("Empty download");
  const hash = createHash("sha256"); let received = 0;
  // Exclusive create: a leftover or planted file (or symlink) at the staging path is never written through.
  rmSync(file, { force: true });
  const fd = openSync(file, "wx", 0o700);
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.byteLength; if (received > asset.size) throw new Error("Download larger than advertised");
      hash.update(chunk); writeSync(fd, chunk);
    }
  } finally { closeSync(fd); }
  if (received !== asset.size) throw new Error("Incomplete download");
  return hash.digest("hex");
}

export const sidePaths = (target: string) => {
  const extension = extname(target); const stem = join(dirname(target), basename(target, extension));
  // Keep the .exe extension last so Windows can start the staged copy for the pre-swap check.
  return { staged: `${stem}.new${extension}`, previous: `${stem}.old${extension}`, failed: `${stem}.failed${extension}` };
};

export const realRunner: Runner = (file, args) => {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: 60_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, AI_USAGE_NO_UPDATE: "1" } });
  return { status: result.status, stdout: result.stdout ?? "" };
};
const reportsVersion = (runner: Runner, file: string, version: string) => {
  try { const result = runner(file, ["version"]); return result.status === 0 && result.stdout.trim() === version; } catch { return false; }
};

/**
 * Replaces `target` with the verified `staged` file, never overwriting the running binary in place. The new
 * binary must report `version` before and after the swap; otherwise the previous one is put back and kept for
 * `update rollback`.
 * - Linux: the previous binary is backed up as a hard link, then `rename(staged, target)` replaces it in one
 *   atomic step, so `target` always exists.
 * - Windows cannot replace a running .exe, but can rename it: target → .old, then staged → target. A crash
 *   between both renames leaves an orphaned .old, which `recoverInterruptedSwap` restores on the next start.
 */
export function swapExecutable(target: string, staged: string, version: string, runner: Runner = realRunner, platform: NodeJS.Platform = process.platform): UpdateResult["status"] {
  const { previous, failed } = sidePaths(target);
  if (platform !== "win32") chmodSync(staged, 0o755);
  if (!reportsVersion(runner, staged, version)) { rmSync(staged, { force: true }); return "rolled-back"; }
  parkOrRemove(previous);
  if (platform === "win32") {
    renameSync(target, previous);
    try { renameSync(staged, target); } catch (error) { renameSync(previous, target); throw error; }
  } else {
    linkSync(target, previous); renameSync(staged, target);
  }
  if (reportsVersion(runner, target, version)) return "updated";
  restorePrevious(target, platform);
  return "rolled-back";
}

// A previous binary may still be running on Windows and then cannot be deleted; it is parked instead.
function parkOrRemove(file: string) {
  try { rmSync(file, { force: true }); } catch { renameSync(file, `${file}.${Date.now()}`); }
}
function restorePrevious(target: string, platform: NodeJS.Platform) {
  const { previous, failed } = sidePaths(target);
  parkOrRemove(failed);
  if (platform === "win32") { renameSync(target, failed); renameSync(previous, target); }
  else { linkSync(target, failed); renameSync(previous, target); }
}

/** Restores the binary kept by the last update. */
export function rollback(target: string, platform: NodeJS.Platform = process.platform) {
  if (!existsSync(sidePaths(target).previous)) throw new Error("No previous version to roll back to");
  restorePrevious(target, platform);
  return "Previous version restored. Restart the companion to use it.";
}

/**
 * Startup housekeeping for packaged builds: an interrupted Windows swap leaves `target` missing and `.old`
 * present (the running process may be that very file); put it back. Parked `.old.<time>` and `.failed.<time>`
 * copies from earlier swaps are deleted once nothing runs from them anymore.
 */
export function recoverInterruptedSwap(target: string) {
  const { previous, failed } = sidePaths(target);
  let recovered = false;
  if (!existsSync(target) && existsSync(previous)) { renameSync(previous, target); recovered = true; }
  const parked = [previous, failed].map(f => basename(f));
  try {
    for (const name of readdirSync(dirname(target))) {
      if (parked.some(p => name.startsWith(`${p}.`) && /^\d+$/.test(name.slice(p.length + 1)))) {
        try { rmSync(join(dirname(target), name), { force: true }); } catch { /* still running; retry next start */ }
      }
    }
  } catch { /* directory unreadable: nothing to clean */ }
  return recovered;
}

export const updateSettings = () => readState<UpdateSettings>("update.json") ?? {};
/** Automatic updates are on by default for packaged builds and can be turned off with `update disable` or AI_USAGE_NO_UPDATE=1. */
export const automaticUpdates = (env: NodeJS.ProcessEnv = process.env) => env.AI_USAGE_NO_UPDATE !== "1" && updateSettings().automatic !== false;
export function setAutomatic(automatic: boolean) { writeState("update.json", { ...updateSettings(), automatic }); }

export async function checkForUpdate(fetchImpl: Fetch = fetch, current = COMPANION_VERSION, prerelease = prereleasesWanted()) {
  const release = await latestRelease(fetchImpl, UPDATE_REPO, prerelease);
  return { release, newer: !!release && compareVersions(release.version, current) > 0 };
}
/** A version that failed its start check or was rolled back is not retried automatically; a newer one is. */
export function skipVersion(version: string) { writeState("update.json", { ...updateSettings(), skipped: version }); }

/**
 * Downloads release asset `name` to `file` (created exclusively) and checks it: SHA256SUMS must carry a valid
 * Ed25519 signature by a trusted key, and the file must match its signed checksum, its size and GitHub's digest.
 * A file that fails any check is deleted; the checksum list and signature never outlive the call.
 */
export async function downloadVerified(fetchImpl: Fetch, release: Release, name: string, file: string, keys: readonly string[] = RELEASE_PUBLIC_KEYS) {
  const find = (n: string) => release.assets.find(a => a.name === n);
  const asset = find(name); const sums = find(SUMS_ASSET); const signature = find(SIGNATURE_ASSET);
  if (!asset || !sums || !signature) throw new Error(`Release ${release.version} has no signed ${name}; not installing it.`);
  const sumsFile = `${file}.sums`; const signatureFile = `${file}.sig`;
  try {
    const sumsDigest = await download(fetchImpl, sums, sumsFile, MAX_SMALL_BYTES);
    await download(fetchImpl, signature, signatureFile, MAX_SMALL_BYTES);
    if (sums.digest && sums.digest !== `sha256:${sumsDigest}`) throw new Error("Checksum list does not match its published digest");
    const sumsData = readFileSync(sumsFile);
    if (!verifySignature(sumsData, readFileSync(signatureFile, "utf8"), keys)) throw new Error("Release signature is missing or invalid; update refused");
    const expected = checksumFor(sumsData.toString("utf8"), name);
    if (!expected) throw new Error(`Checksum list has no entry for ${name}`);
    const actual = await download(fetchImpl, asset, file);
    if (actual !== expected || (asset.digest && asset.digest !== `sha256:${actual}`)) throw new Error("Checksum mismatch; update discarded");
  } catch (error) {
    rmSync(file, { force: true }); throw error;
  } finally { rmSync(sumsFile, { force: true }); rmSync(signatureFile, { force: true }); }
}

export type UpdateOptions = { fetch?: Fetch; runner?: Runner; current?: string; platform?: NodeJS.Platform; arch?: string; prerelease?: boolean; keys?: readonly string[]; automatic?: boolean };
export async function update(target: string, options: UpdateOptions = {}): Promise<UpdateResult> {
  const fetchImpl = options.fetch ?? fetch; const current = options.current ?? COMPANION_VERSION;
  const { release, newer } = await checkForUpdate(fetchImpl, current, options.prerelease ?? prereleasesWanted());
  writeState("update.json", { ...updateSettings(), lastCheck: Date.now() });
  if (!release) return { status: "unavailable", version: current, message: "No companion release found." };
  if (!newer) return { status: "current", version: current, message: `Companion ${current} is up to date.` };
  if (options.automatic && updateSettings().skipped === release.version) return { status: "current", version: current, message: `Companion ${release.version} was rolled back earlier; staying on ${current}.` };
  const name = releaseAssetName(release.version, options.platform, options.arch);
  if (![name, SUMS_ASSET, SIGNATURE_ASSET].every(n => release.assets.some(a => a.name === n))) return { status: "unavailable", version: current, message: `Release ${release.version} has no signed ${name}; not installing it.` };
  const { staged } = sidePaths(target);
  await downloadVerified(fetchImpl, release, name, staged, options.keys);
  const status = swapExecutable(target, staged, release.version, options.runner, options.platform);
  if (status !== "updated") skipVersion(release.version);
  return status === "updated"
    ? { status, version: release.version, message: `Updated companion ${current} → ${release.version}.` }
    : { status, version: current, message: `Companion ${release.version} failed its start check; kept ${current}.` };
}
