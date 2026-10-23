// Maintainer-only: publishes companion binaries built by this repository's release workflow as a GitHub release
// of this repository. Runs locally with an authenticated `gh`; the signing key never lives in Actions.
//
//   pnpm publish:release companion-v1.0.0                 # download the tag's workflow artifacts, verify, sign, create a DRAFT
//   pnpm publish:release companion-v1.0.0 --run 12345     # use a specific (e.g. workflow_dispatch) run
//   pnpm publish:release companion-v1.0.0 --dir <folder>  # use local `pnpm package` output instead (no attestations)
//   pnpm publish:release companion-v1.0.0 --publish       # re-verify the existing draft and make it public
//
// Pass --run <id> to choose a run explicitly (e.g. workflow_dispatch); without it only the tag's push run is used.
// Downloaded binaries must carry a build-provenance attestation from this repository's release workflow for the
// tagged commit (`gh attestation verify`); otherwise nothing is signed.
// Options: --targets linux-x64,windows-x64 (default: all), --repo <owner/name> (default Fade97/meterkat-companion),
// --source <owner/name> (default Fade97/meterkat-companion). Versions with a hyphen become GitHub prereleases, which
// the updater ignores unless asked for them explicitly.
//
// Signing key: COMPANION_RELEASE_SIGNING_KEY (PKCS#8 PEM) from the environment, otherwise read from a HashiCorp Vault
// KV v2 secret (`secret/services/meterkat-release`, key COMPANION_RELEASE_SIGNING_KEY) at VAULT_ADDR with VAULT_TOKEN or
// a scoped read-only token in ~/.config/vault/meterkat-release-token.
// The key is held in memory only. A signature that the embedded release keys cannot verify is never uploaded.
import { createHash, createPrivateKey, sign } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { RELEASE_PUBLIC_KEYS, verifySignature } from "../src/release-key.js";
import { checksumFor, parseVersion, releaseAssetName, SIGNATURE_ASSET, SUMS_ASSET, TAG_PREFIX } from "../src/update.js";

const ALL_TARGETS = ["linux-x64", "linux-arm64", "windows-x64"];
// Secrets are taken out of the environment once, so no child process (gh, the unsigned CI binary) inherits them.
const SECRET_VARS = ["COMPANION_RELEASE_SIGNING_KEY", "VAULT_TOKEN"] as const;
const secrets: Partial<Record<typeof SECRET_VARS[number], string>> = {};
for (const name of SECRET_VARS) { if (process.env[name]) secrets[name] = process.env[name]; delete process.env[name]; }
const ghEnv = () => Object.fromEntries(Object.entries(process.env).filter(([name]) => !(SECRET_VARS as readonly string[]).includes(name) && !name.startsWith("VAULT_")));
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

function gh(args: string[], options: { json?: boolean } = {}) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"], env: ghEnv() });
  if (result.status !== 0) throw new Error(`gh ${args[0]} ${args[1] ?? ""} failed (${result.status})`);
  return options.json ? JSON.parse(result.stdout) : result.stdout;
}

/** Names every release must contain for the selected targets (binaries plus Linux archives). */
export function expectedAssets(version: string, targets: string[]) {
  return targets.flatMap(target => {
    const [os, arch] = target.split("-") as [string, string];
    const name = releaseAssetName(version, os === "windows" ? "win32" : "linux", arch);
    return os === "linux" ? [name, `${name}.tar.gz`] : [name];
  }).sort();
}

/** Canonical SHA256SUMS for `names` in `dir`; a workflow-provided list must agree with it exactly. */
export function checksumList(dir: string, names: string[]) {
  const sums = names.map(name => `${sha256(join(dir, name))}  ${name}`).join("\n") + "\n";
  const provided = join(dir, SUMS_ASSET);
  if (existsSync(provided)) {
    const workflow = readFileSync(provided, "utf8");
    for (const name of names) if (checksumFor(workflow, name) !== checksumFor(sums, name)) throw new Error(`${name} does not match the workflow's SHA256SUMS`);
  }
  return sums;
}

export function signSums(sums: string, privateKeyPem: string, keys: readonly string[] = RELEASE_PUBLIC_KEYS) {
  const signature = sign(null, Buffer.from(sums), createPrivateKey(privateKeyPem)).toString("base64") + "\n";
  if (!verifySignature(Buffer.from(sums), signature, keys)) throw new Error("Signing key does not match any release key embedded in the companion");
  return signature;
}

async function signingKey() {
  if (secrets.COMPANION_RELEASE_SIGNING_KEY) return secrets.COMPANION_RELEASE_SIGNING_KEY;
  const tokenFile = join(homedir(), ".config", "vault", "meterkat-release-token");
  const token = secrets.VAULT_TOKEN ?? (existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : undefined);
  if (!token) throw new Error(`Set COMPANION_RELEASE_SIGNING_KEY or VAULT_TOKEN, or create ${tokenFile}`);
  const vault = process.env.VAULT_ADDR;
  if (!vault) throw new Error("Set VAULT_ADDR to read the signing key from Vault");
  // Periodic token: using it renews its period (best effort; a failure surfaces as 403 on the read below).
  await fetch(`${vault}/v1/auth/token/renew-self`, { method: "POST", headers: { "X-Vault-Token": token }, signal: AbortSignal.timeout(15_000), redirect: "error" }).catch(() => undefined);
  const response = await fetch(`${vault}/v1/secret/data/services/meterkat-release`, { headers: { "X-Vault-Token": token }, signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!response.ok) throw new Error(`Vault read failed (${response.status})`);
  const key = (await response.json() as any)?.data?.data?.COMPANION_RELEASE_SIGNING_KEY;
  if (typeof key !== "string") throw new Error("COMPANION_RELEASE_SIGNING_KEY missing in Vault");
  return key;
}

// Only a successful tag-push run built from exactly the tagged commit is accepted (not a branch or manual run).
function findRun(source: string, tag: string) {
  const commit = String(gh(["api", `repos/${source}/commits/${encodeURIComponent(tag)}`, "--jq", ".sha"])).trim();
  const runs = gh(["run", "list", "-R", source, "--workflow", "release.yml", "--json", "databaseId,headBranch,headSha,event,conclusion", "-L", "50"], { json: true }) as { databaseId: number; headBranch: string; headSha: string; event: string; conclusion: string }[];
  const run = runs.find(r => r.headBranch === tag && r.event === "push" && r.headSha === commit && r.conclusion === "success");
  if (!run) throw new Error(`No successful release run for ${tag}; pass --run <id> or --dir`);
  return String(run.databaseId);
}

/** Every file must be attested by `source`'s release workflow on a GitHub-hosted runner, built from the tagged commit. */
function verifyProvenance(dir: string, names: string[], source: string, tag: string) {
  const commit = String(gh(["api", `repos/${source}/commits/${encodeURIComponent(tag)}`, "--jq", ".sha"])).trim();
  for (const name of names) {
    gh(["attestation", "verify", join(dir, name), "--repo", source, "--signer-workflow", `${source}/.github/workflows/release.yml`,
      "--source-digest", commit, "--deny-self-hosted-runners"]);
  }
  console.log(`Build provenance verified for ${names.length} files (${source}@${commit.slice(0, 12)}).`);
}

async function createDraft(tag: string, version: string, dir: string, targets: string[], repo: string, source?: string) {
  const names = expectedAssets(version, targets);
  const present = new Set(readdirSync(dir));
  const missing = names.filter(n => !present.has(n));
  if (missing.length) throw new Error(`Missing release files: ${missing.join(", ")}`);
  if (source) verifyProvenance(dir, names, source, tag);
  const sums = checksumList(dir, names);
  // A binary for this machine must report the tag's version before anything is uploaded.
  const host = releaseAssetName(version, process.platform, process.arch);
  if (present.has(host)) {
    // The CI binary is not trusted yet: minimal environment, throwaway state directory, time limit.
    const state = mkdtempSync(join(tmpdir(), "meterkat-check-"));
    try {
      const result = spawnSync(join(dir, host), ["version"], { encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "", AI_USAGE_NO_UPDATE: "1", AI_USAGE_STATE_DIR: state, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "" } : {}) } });
      if (result.status !== 0 || result.stdout.trim() !== version) throw new Error(`${host} does not report version ${version}`);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }
  const out = mkdtempSync(join(tmpdir(), "meterkat-release-"));
  try {
    writeFileSync(join(out, SUMS_ASSET), sums); writeFileSync(join(out, SIGNATURE_ASSET), signSums(sums, await signingKey()));
    const prerelease = parseVersion(version)!.pre ? ["--prerelease"] : [];
    gh(["release", "create", tag, ...names.map(n => join(dir, n)), join(out, SUMS_ASSET), join(out, SIGNATURE_ASSET), "-R", repo, "--draft", ...prerelease,
      "--title", `Meterkat companion ${version}`, "--notes", releaseNotes(version)]);
  } finally { rmSync(out, { recursive: true, force: true }); }
  console.log(`Draft ${tag} created in ${repo} with ${names.length} files, SHA256SUMS and ${SIGNATURE_ASSET}. Review it, then rerun with --publish.`);
}

async function publishDraft(tag: string, repo: string) {
  const releases = gh(["api", `repos/${repo}/releases?per_page=50`], { json: true }) as any[];
  const draft = releases.find(r => r.tag_name === tag);
  if (!draft) throw new Error(`No release ${tag} in ${repo}; create the draft first`);
  if (!draft.draft) throw new Error(`${tag} is already public`);
  // Re-verify exactly what is attached to the draft: signature over SHA256SUMS, and every asset's digest.
  const dir = mkdtempSync(join(tmpdir(), "meterkat-publish-"));
  try {
    gh(["release", "download", tag, "-R", repo, "-p", SUMS_ASSET, "-p", SIGNATURE_ASSET, "-D", dir]);
    const sums = readFileSync(join(dir, SUMS_ASSET));
    if (!verifySignature(sums, readFileSync(join(dir, SIGNATURE_ASSET), "utf8"))) throw new Error("Draft signature does not verify with the embedded release keys");
    for (const asset of draft.assets as { name: string; digest?: string }[]) {
      if (asset.name === SUMS_ASSET || asset.name === SIGNATURE_ASSET) continue;
      const expected = checksumFor(sums.toString("utf8"), asset.name);
      if (!expected || asset.digest !== `sha256:${expected}`) throw new Error(`${asset.name} does not match the signed SHA256SUMS`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  gh(["release", "edit", tag, "-R", repo, "--draft=false"]);
  console.log(`${tag} is now public in ${repo}.`);
}

// Version-specific notes (fixes, changes) from docs/releases/companion-<version>.md come first when that file exists.
const releaseNotes = (version: string) => versionNotes(version) + `Single-file Meterkat companion ${version} for Windows and Linux (no separate Node.js needed).

- Windows: run \`meterkat-companion-${version}-windows-x64.exe setup\` from a terminal. The build is not code-signed: in SmartScreen choose **More info → Run anyway**.
- Linux: \`tar -xzf meterkat-companion-${version}-linux-<arch>.tar.gz && ./meterkat setup\`.

Installed companions update themselves after checking the Ed25519 signature on SHA256SUMS. To verify by hand: \`sha256sum -c SHA256SUMS --ignore-missing\`; the signature check is described in [docs/installation.md](https://github.com/Fade97/meterkat-companion/blob/main/docs/installation.md#verify-a-download-by-hand). Build provenance: \`gh attestation verify <file> -R Fade97/meterkat-companion\`.

The companion is open source under the MIT licence (\`meterkat licenses\`). The hosted relay is a separate free service under its [terms of use](https://meterkat.fabian-duerkop.de/terms).`;

function versionNotes(version: string) {
  const file = join(import.meta.dirname, "..", "docs", "releases", `companion-${version}.md`);
  return existsSync(file) ? `${readFileSync(file, "utf8").trim()}\n\n` : "";
}

if (process.argv[1] && resolve(process.argv[1]).endsWith(join("scripts", "publish-release.ts"))) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    run: { type: "string" }, dir: { type: "string" }, targets: { type: "string" }, publish: { type: "boolean", default: false },
    repo: { type: "string", default: "Fade97/meterkat-companion" }, source: { type: "string", default: "Fade97/meterkat-companion" },
  } });
  const tag = positionals[0] ?? "";
  const version = tag.startsWith(TAG_PREFIX) ? tag.slice(TAG_PREFIX.length) : "";
  if (!parseVersion(version)) throw new Error(`Usage: publish-release.ts ${TAG_PREFIX}<semver> [--run id | --dir folder] [--targets …] [--publish]`);
  if (values.publish) await publishDraft(tag, values.repo!);
  else {
    const targets = values.targets ? values.targets.split(",") : ALL_TARGETS;
    if (targets.some(t => !ALL_TARGETS.includes(t))) throw new Error(`Targets must be among ${ALL_TARGETS.join(", ")}`);
    let dir = values.dir ? resolve(values.dir) : "";
    const download = !dir;
    if (download) {
      dir = mkdtempSync(join(tmpdir(), "meterkat-artifacts-"));
      gh(["run", "download", values.run ?? findRun(values.source!, tag), "-R", values.source!, "-n", "meterkat-companion-release", "-D", dir]);
    }
    try { await createDraft(tag, version, dir, targets, values.repo!, download ? values.source! : undefined); }
    finally { if (download) rmSync(dir, { recursive: true, force: true }); }
  }
}
