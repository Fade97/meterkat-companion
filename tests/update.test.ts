import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { allowedDownloadUrl, checksumFor, compareVersions, download, latestRelease, recoverInterruptedSwap, releaseAssetName, rollback, sidePaths, swapExecutable, update, updateSettings, type Fetch, type Runner } from "../src/update.js";
import { realpathSync, symlinkSync } from "node:fs";
import { stripPeSignature, thirdPartyNotices } from "../scripts/package.js";
import { RELEASE_PUBLIC_KEYS, verifySignature } from "../src/release-key.js";

// A throwaway signing key stands in for the real release key, which never enters the repository.
const signing = generateKeyPairSync("ed25519");
const testKey = signing.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const signSums = (sums: string, key = signing.privateKey) => sign(null, Buffer.from(sums), key).toString("base64") + "\n";

// No network and no real executables: fetch is a routing table, and "binaries" are text files whose
// content says which version they report (or that they crash) when the fake runner starts them.
const runner: Runner = file => { const body = readFileSync(file, "utf8"); return body.startsWith("crash") ? { status: 1, stdout: "" } : { status: 0, stdout: `${body.split(":")[1]}\n` }; };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
function sandbox(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-update-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AI_USAGE_STATE_DIR; process.env.AI_USAGE_STATE_DIR = join(dir, "state");
  t.after(() => { if (previous === undefined) delete process.env.AI_USAGE_STATE_DIR; else process.env.AI_USAGE_STATE_DIR = previous; });
  const target = join(dir, "meterkat"); writeFileSync(target, "binary:1.0.0");
  return { dir, target };
}
function releaseServer(releases: unknown[], files: Record<string, string>): Fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/releases?")) return Response.json(releases);
    const api = /\/assets\/(.+)$/.exec(url);
    if (api) return new Response(null, { status: 302, headers: { location: `https://release-assets.githubusercontent.com/${api[1]}` } });
    const name = decodeURIComponent(url.split("/").pop()!);
    return name in files ? new Response(files[name]) : new Response("missing", { status: 404 });
  }) as Fetch;
}
const asset = (name: string, body: string, digest = true) => ({ name, size: Buffer.byteLength(body), url: `https://api.github.com/repos/o/r/releases/assets/${encodeURIComponent(name)}`, digest: digest ? `sha256:${sha(body)}` : null });
function release(version: string, body = `binary:${version}`, sumsBody?: string, signature?: string) {
  const name = releaseAssetName(version, "linux", "x64");
  const sums = sumsBody ?? `${sha(body)}  ${name}\n`; const sig = signature ?? signSums(sums);
  return { json: { tag_name: `companion-v${version}`, draft: false, prerelease: false, assets: [asset(name, body), asset("SHA256SUMS", sums), asset("SHA256SUMS.sig", sig)] }, files: { [name]: body, SHA256SUMS: sums, "SHA256SUMS.sig": sig } };
}

test("versions compare by semver precedence and asset names carry version, OS and arch", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-rc.1") > 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  // Semver 2.0 prerelease precedence: numeric identifiers numerically, numeric < alphanumeric, longer wins.
  assert.ok(compareVersions("1.0.0-test.10", "1.0.0-test.9") > 0);
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-1") > 0);
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha") > 0);
  assert.ok(compareVersions("1.0.0-beta", "1.0.0-alpha.9") > 0);
  assert.equal(releaseAssetName("1.0.0", "win32", "x64"), "meterkat-companion-1.0.0-windows-x64.exe");
  assert.equal(releaseAssetName("1.0.0", "linux", "arm64"), "meterkat-companion-1.0.0-linux-arm64");
  assert.equal(checksumFor(`${"a".repeat(64)}  x\n${"b".repeat(64)} *meterkat\n`, "meterkat"), "b".repeat(64));
});

test("release discovery ignores drafts, prereleases, other tags and picks the highest companion version", async () => {
  const list = [release("1.2.0").json, { ...release("9.0.0").json, draft: true }, { ...release("3.0.0-rc.1").json, prerelease: false }, { ...release("1.10.0").json, tag_name: "android-v5.0.0" }, release("1.3.0").json];
  assert.equal((await latestRelease(releaseServer(list, {}), "o/r"))?.version, "1.3.0");
});

test("prereleases are ignored unless explicitly requested, judged by the version and not the API flag", async () => {
  const list = [release("1.0.0").json, { ...release("1.1.0-test.1").json, prerelease: false }, { ...release("0.9.0").json, prerelease: true }];
  assert.equal((await latestRelease(releaseServer(list, {}), "o/r", false))?.version, "1.0.0");
  assert.equal((await latestRelease(releaseServer(list, {}), "o/r", true))?.version, "1.1.0-test.1");
});

test("embedded release key verifies only well-formed Ed25519 signatures", () => {
  assert.equal(RELEASE_PUBLIC_KEYS.length >= 1, true);
  assert.equal(verifySignature(Buffer.from("x"), signSums("x"), [testKey]), true);
  assert.equal(verifySignature(Buffer.from("x"), signSums("x")), false);
  assert.equal(verifySignature(Buffer.from("x"), "not base64 at all", [testKey]), false);
  assert.equal(verifySignature(Buffer.from("x"), "", [testKey, "garbage"]), false);
});

test("swap replaces the binary, keeps the previous one and can roll back", t => {
  const { target } = sandbox(t); const { staged, previous } = sidePaths(target);
  writeFileSync(staged, "binary:1.1.0");
  assert.equal(swapExecutable(target, staged, "1.1.0", runner), "updated");
  assert.equal(readFileSync(target, "utf8"), "binary:1.1.0");
  assert.equal(readFileSync(previous, "utf8"), "binary:1.0.0");
  rollback(target);
  assert.equal(readFileSync(target, "utf8"), "binary:1.0.0");
});

test("swap discards a binary that fails its start check before or after the swap", t => {
  const { target } = sandbox(t); const { staged, failed } = sidePaths(target);
  writeFileSync(staged, "crash");
  assert.equal(swapExecutable(target, staged, "1.1.0", runner), "rolled-back");
  assert.equal(readFileSync(target, "utf8"), "binary:1.0.0"); assert.equal(existsSync(staged), false);
  // Starts fine as the staged copy, then fails at the final path: the previous binary is restored.
  let calls = 0; const flaky: Runner = file => ++calls === 1 ? runner(file, ["version"]) : { status: 1, stdout: "" };
  writeFileSync(staged, "binary:1.1.0");
  assert.equal(swapExecutable(target, staged, "1.1.0", flaky), "rolled-back");
  assert.equal(readFileSync(target, "utf8"), "binary:1.0.0");
  assert.equal(readFileSync(failed, "utf8"), "binary:1.1.0");
});

test("update applies a newer release only when size, published digest and SHA256SUMS agree", async t => {
  const { target } = sandbox(t);
  const good = release("1.1.0");
  const result = await update(target, { fetch: releaseServer([good.json], good.files), runner, current: "1.0.0", platform: "linux", arch: "x64", keys: [testKey] });
  assert.equal(result.status, "updated"); assert.equal(readFileSync(target, "utf8"), "binary:1.1.0");
  assert.equal((await update(target, { fetch: releaseServer([good.json], good.files), runner, current: "1.1.0", platform: "linux", arch: "x64", keys: [testKey] })).status, "current");
});

test("update rejects tampered downloads and leaves the installed binary untouched", async t => {
  const { target } = sandbox(t); const { staged } = sidePaths(target);
  const options = { runner, current: "1.0.0", platform: "linux" as const, arch: "x64", keys: [testKey] };
  // SHA256SUMS lists a different binary than the one served.
  const wrongSum = release("1.1.0", "binary:1.1.0", `${sha("other")}  ${releaseAssetName("1.1.0", "linux", "x64")}\n`);
  await assert.rejects(update(target, { ...options, fetch: releaseServer([wrongSum.json], wrongSum.files) }), /Checksum mismatch/);
  // The served bytes differ from what GitHub recorded for the asset (same length).
  const swapped = release("1.1.0");
  await assert.rejects(update(target, { ...options, fetch: releaseServer([swapped.json], { ...swapped.files, [releaseAssetName("1.1.0", "linux", "x64")]: "binary:6.6.6" }) }), /Checksum mismatch|larger|Incomplete/);
  // No checksum list or no signature at all: nothing is downloaded.
  const bare = release("1.1.0"); bare.json.assets = bare.json.assets.slice(0, 1);
  assert.equal((await update(target, { ...options, fetch: releaseServer([bare.json], bare.files) })).status, "unavailable");
  const unsigned = release("1.1.0"); unsigned.json.assets = unsigned.json.assets.slice(0, 2);
  assert.equal((await update(target, { ...options, fetch: releaseServer([unsigned.json], unsigned.files) })).status, "unavailable");
  // Consistent checksums signed by an unknown key, or a signature over different contents, are refused.
  const forged = release("1.1.0", "binary:1.1.0", undefined, signSums(`${sha("binary:1.1.0")}  ${releaseAssetName("1.1.0", "linux", "x64")}\n`, generateKeyPairSync("ed25519").privateKey));
  await assert.rejects(update(target, { ...options, fetch: releaseServer([forged.json], forged.files) }), /signature/);
  const resigned = release("1.1.0", "binary:1.1.0", undefined, signSums("other contents"));
  await assert.rejects(update(target, { ...options, fetch: releaseServer([resigned.json], resigned.files) }), /signature/);
  assert.equal(readFileSync(target, "utf8"), "binary:1.0.0"); assert.equal(existsSync(staged), false);
});

test("Windows packaging strips the Authenticode table so the build is unsigned rather than corrupt", () => {
  const pe = Buffer.alloc(512); pe.writeUInt32LE(0x40, 0x3c); pe.write("PE\0\0", 0x40, "latin1");
  pe.writeUInt16LE(0x20b, 0x58); const security = 0x58 + 112 + 32;
  pe.writeUInt32LE(400, security); pe.writeUInt32LE(112, security + 4);
  const stripped = stripPeSignature(pe);
  assert.equal(stripped.length, 400); assert.equal(stripped.readUInt32LE(security), 0); assert.equal(stripped.readUInt32LE(security + 4), 0);
  assert.throws(() => stripPeSignature(Buffer.alloc(128)), /Not a PE/);
});

test("publishing requires every target file, agrees with the workflow checksums and signs only with an embedded key", async t => {
  const { checksumList, expectedAssets, signSums: signRelease } = await import("../scripts/publish-release.js");
  assert.deepEqual(expectedAssets("1.0.0", ["windows-x64", "linux-x64"], false), ["meterkat-companion-1.0.0-linux-x64", "meterkat-companion-1.0.0-linux-x64.tar.gz", "meterkat-companion-1.0.0-windows-x64.exe"].sort());
  // Desktop builds exist for linux-x64 and windows-x64 only.
  assert.deepEqual(expectedAssets("1.0.0", ["windows-x64", "linux-arm64"]), ["meterkat-companion-1.0.0-linux-arm64", "meterkat-companion-1.0.0-linux-arm64.tar.gz", "meterkat-companion-1.0.0-windows-x64.exe", "meterkat-desktop-1.0.0-windows-x64-setup.exe"].sort());
  const { dir } = sandbox(t);
  const names = expectedAssets("1.0.0", ["linux-x64"]);
  for (const name of names) writeFileSync(join(dir, name), `content of ${name}`);
  const sums = checksumList(dir, names);
  assert.equal(checksumFor(sums, names[0]!), sha(`content of ${names[0]}`));
  writeFileSync(join(dir, "SHA256SUMS"), sums.replace(/^[0-9a-f]{64}/, "0".repeat(64)));
  assert.throws(() => checksumList(dir, names), /does not match/);
  const pem = signing.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  assert.equal(verifySignature(Buffer.from(sums), signRelease(sums, pem, [testKey]), [testKey]), true);
  // A key the companion does not trust is rejected before anything could be uploaded.
  assert.throws(() => signRelease(sums, pem), /does not match/);
});

test("downloads stay on GitHub hosts, including every redirect hop", async t => {
  assert.equal(allowedDownloadUrl("https://api.github.com/repos/o/r/releases/assets/1"), true);
  assert.equal(allowedDownloadUrl("https://release-assets.githubusercontent.com/x"), true);
  assert.equal(allowedDownloadUrl("http://api.github.com/x"), false);
  assert.equal(allowedDownloadUrl("https://api.github.com.evil.example/x"), false);
  assert.equal(allowedDownloadUrl("https://user:pw@github.com/x"), false);
  const { dir } = sandbox(t);
  const evil = (async () => new Response(null, { status: 302, headers: { location: "https://evil.example/payload" } })) as unknown as Fetch;
  await assert.rejects(download(evil, { name: "x", size: 4, url: "https://api.github.com/repos/o/r/releases/assets/1" }, join(dir, "x")), /Unexpected download location/);
  await assert.rejects(download(evil, { name: "x", size: 4, url: "https://evil.example/asset" }, join(dir, "x")), /Unexpected download location/);
});

test("staging files are created exclusively; a planted symlink is replaced, not written through", { skip: process.platform === "win32" && "symlinks need privileges" }, async t => {
  const { dir } = sandbox(t);
  const victim = join(dir, "victim"); writeFileSync(victim, "keep");
  const staged = join(dir, "staged"); symlinkSync(victim, staged);
  const body = "binary:9.9.9";
  const server = releaseServer([], { "a": body });
  await download(server, { name: "a", size: body.length, url: "https://api.github.com/repos/o/r/releases/assets/a" }, staged);
  assert.equal(readFileSync(victim, "utf8"), "keep"); assert.equal(readFileSync(staged, "utf8"), body);
});

test("Linux swap keeps the target in place throughout; Windows swap renames and recovers an interrupted swap", t => {
  const { target } = sandbox(t); const { staged, previous } = sidePaths(target);
  // The runner observes that `target` exists at every start check on Linux.
  const seen: boolean[] = []; const watching: Runner = (file, args) => { seen.push(existsSync(target)); return runner(file, args); };
  writeFileSync(staged, "binary:1.1.0");
  assert.equal(swapExecutable(target, staged, "1.1.0", watching, "linux"), "updated");
  assert.deepEqual(seen, [true, true]); assert.equal(readFileSync(previous, "utf8"), "binary:1.0.0");
  writeFileSync(staged, "binary:1.2.0");
  assert.equal(swapExecutable(target, staged, "1.2.0", runner, "win32"), "updated");
  assert.equal(readFileSync(previous, "utf8"), "binary:1.1.0");
  // Crash between the two Windows renames: target missing, .old present. Parked copies are cleaned up.
  rmSync(target); writeFileSync(`${previous}.1700000000000`, "parked");
  assert.equal(recoverInterruptedSwap(target), true);
  assert.equal(readFileSync(target, "utf8"), "binary:1.1.0"); assert.equal(existsSync(`${previous}.1700000000000`), false);
  assert.equal(recoverInterruptedSwap(target), false);
});

test("a version that failed its start check is skipped by automatic checks but not by an explicit update", async t => {
  const { target } = sandbox(t);
  const bad = release("1.1.0", "crash"); let downloads = 0;
  const counting = (async (input: string | URL | Request, init?: RequestInit) => { if (String(input).includes("/assets/")) downloads++; return releaseServer([bad.json], bad.files)(input, init); }) as Fetch;
  const options = { fetch: counting, runner, current: "1.0.0", platform: "linux" as const, arch: "x64", keys: [testKey] };
  assert.equal((await update(target, options)).status, "rolled-back");
  assert.equal(updateSettings().skipped, "1.1.0");
  downloads = 0;
  assert.equal((await update(target, { ...options, automatic: true })).status, "current"); assert.equal(downloads, 0);
  assert.equal((await update(target, options)).status, "rolled-back"); assert.ok(downloads > 0);
  assert.equal(readFileSync(target, "utf8"), "binary:1.0.0");
});

test("packaging collects licence notices for the embedded runtime and every bundled package", () => {
  // Inputs as esbuild reports them: real paths relative to the repository root, wherever pnpm put the store
  // (this checkout's node_modules, or a parent workspace's).
  const root = fileURLToPath(new URL("..", import.meta.url));
  const packageDir = (name: string, from: string) => realpathSync(dirname(createRequire(from).resolve(`${name}/package.json`)));
  const qrcode = packageDir("qrcode", import.meta.url); const pngjs = packageDir("pngjs", join(qrcode, "package.json"));
  const input = (dir: string, file: string) => relative(root, join(dir, file)).replaceAll("\\", "/");
  const notices = thirdPartyNotices(["src/cli.ts", input(qrcode, "lib/index.js"), input(pngjs, "lib/png.js")]);
  assert.match(notices, /^Node\.js \d+\.\d+\.\d+ \(embedded runtime\)$/m);
  assert.match(notices, /^qrcode 1\.5\.4 \(MIT\)$/m);
  assert.match(notices, /^pngjs 5\.0\.0 \(MIT\)$/m);
  assert.throws(() => thirdPartyNotices(["node_modules/no-such-package/index.js"]), "an unknown bundled package fails the build");
});
