import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { desktopAssetName, sidePaths, updateSettings, type Fetch, type Release, type Runner } from "../../src/update.js";
import { cleanUp, installation, launch, prepare, UNINSTALLER } from "../src/self-update.js";

// A throwaway key stands in for the release key; fetch is a routing table and "AppImages" are text files that say
// which version they report (or that they crash) when the fake runner starts them.
const signing = generateKeyPairSync("ed25519");
const keys = [signing.publicKey.export({ type: "spki", format: "der" }).toString("base64")];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const runner: Runner = file => { const body = readFileSync(file, "utf8"); return body.startsWith("crash") ? { status: 1, stdout: "" } : { status: 0, stdout: `${body.split(":")[1]}\n` }; };

function server(files: Record<string, string>): Fetch {
  return (async (input: string | URL | Request) => {
    const name = decodeURIComponent(String(input).split("/").pop()!);
    return name in files ? new Response(files[name]) : new Response("missing", { status: 404 });
  }) as Fetch;
}
function release(version: string, target: string, body: string, signature?: string) {
  const name = desktopAssetName(version, target)!;
  const sums = `${sha(body)}  ${name}\n`;
  const files: Record<string, string> = { [name]: body, SHA256SUMS: sums, "SHA256SUMS.sig": signature ?? sign(null, Buffer.from(sums), signing.privateKey).toString("base64") };
  const assets = Object.entries(files).map(([n, b]) => ({ name: n, size: Buffer.byteLength(b), url: `https://api.github.com/repos/o/r/releases/assets/${encodeURIComponent(n)}`, digest: `sha256:${sha(b)}` }));
  return { release: { tag: `companion-v${version}`, version, assets } satisfies Release, fetch: server(files) };
}
function sandbox(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "meterkat-desktop-update-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.AI_USAGE_STATE_DIR; process.env.AI_USAGE_STATE_DIR = join(dir, "state");
  t.after(() => { if (previous === undefined) delete process.env.AI_USAGE_STATE_DIR; else process.env.AI_USAGE_STATE_DIR = previous; });
  const target = join(dir, "meterkat-desktop-1.1.1-linux-x64.AppImage"); writeFileSync(target, "binary:1.1.1");
  return { dir, target };
}

test("only an AppImage in a writable folder and a Windows installation update themselves", () => {
  const probe = (exists: boolean, writable: boolean) => ({ exists: () => exists, writable: () => writable });
  const appImage = { APPIMAGE: "/home/u/Apps/Meterkat.AppImage" };
  assert.deepEqual(installation(appImage, "linux", "x64", "/tmp/.mount_x/meterkat", true, probe(false, true)), { kind: "appimage", target: "/home/u/Apps/Meterkat.AppImage" });
  assert.equal(installation(appImage, "linux", "x64", "/tmp/.mount_x/meterkat", true, probe(false, false)).kind, "manual");
  assert.equal(installation(appImage, "linux", "arm64", "/tmp/.mount_x/meterkat", true, probe(false, true)).kind, "manual");
  assert.equal(installation({ APPIMAGE: "Meterkat.AppImage" }, "linux", "x64", "/x", true, probe(false, true)).kind, "manual");
  assert.equal(installation({}, "linux", "x64", "/opt/meterkat/meterkat", true, probe(true, true)).kind, "manual");
  assert.equal(installation(appImage, "linux", "x64", "/usr/bin/electron", false, probe(true, true)).kind, "manual");
  const exe = "C:\\Users\\u\\AppData\\Local\\Programs\\meterkat-desktop\\Meterkat.exe";
  let asked = "";
  assert.deepEqual(installation({}, "win32", "x64", exe, true, { exists: file => { asked = file; return true; }, writable: () => true }), { kind: "nsis" });
  assert.ok(asked.endsWith(UNINSTALLER));
  assert.equal(installation({}, "win32", "x64", exe, true, probe(false, true)).kind, "manual");
});

test("a verified AppImage replaces the running one at the same path and restarts hidden from the tray", async t => {
  const { dir, target } = sandbox(t);
  const next = release("1.2.0", "linux-x64", "binary:1.2.0");
  const prepared = await prepare(next.release, { kind: "appimage", target }, join(dir, "updates"), { fetch: next.fetch, runner, keys });
  assert.deepEqual(prepared, { kind: "appimage", version: "1.2.0", target });
  assert.equal(readFileSync(target, "utf8"), "binary:1.2.0");
  assert.equal(readFileSync(sidePaths(target).previous, "utf8"), "binary:1.1.1");
  assert.equal(existsSync(sidePaths(target).staged), false);
  assert.deepEqual(readdirSync(dir).filter(name => /\.(sums|sig)$/.test(name)), []);
  assert.deepEqual(launch(prepared, true, ["--no-sandbox"]), { file: target, args: ["--no-sandbox", "--hidden"] });
  assert.deepEqual(launch(prepared, false, ["--hidden", "--updated"]), { file: target, args: [] });
  // After the restart the previous copy is no longer needed.
  cleanUp({ kind: "appimage", target }, join(dir, "updates"));
  assert.equal(existsSync(sidePaths(target).previous), false);
  assert.equal(readFileSync(target, "utf8"), "binary:1.2.0");
});

test("an AppImage that fails its start check is put back and skipped by automatic checks", async t => {
  const { dir, target } = sandbox(t);
  const next = release("1.2.0", "linux-x64", "crash:1.2.0");
  await assert.rejects(prepare(next.release, { kind: "appimage", target }, join(dir, "updates"), { fetch: next.fetch, runner, keys }), /failed its start check/);
  assert.equal(readFileSync(target, "utf8"), "binary:1.1.1");
  assert.equal(existsSync(sidePaths(target).staged), false);
  assert.equal(updateSettings().skipped, "1.2.0");
});

test("unsigned, wrongly signed or tampered releases never touch the installation", async t => {
  const { dir, target } = sandbox(t);
  const forged = release("1.2.0", "linux-x64", "binary:1.2.0", sign(null, Buffer.from("other"), generateKeyPairSync("ed25519").privateKey).toString("base64"));
  await assert.rejects(prepare(forged.release, { kind: "appimage", target }, join(dir, "updates"), { fetch: forged.fetch, runner, keys }), /signature/);
  const good = release("1.2.0", "linux-x64", "binary:1.2.0");
  const tampered: Release = { ...good.release, assets: good.release.assets.map(a => a.name.endsWith(".AppImage") ? { ...a, digest: `sha256:${sha("evil")}` } : a) };
  await assert.rejects(prepare(tampered, { kind: "appimage", target }, join(dir, "updates"), { fetch: good.fetch, runner, keys }), /Checksum mismatch/);
  const unsigned: Release = { ...good.release, assets: good.release.assets.filter(a => a.name !== "SHA256SUMS.sig") };
  await assert.rejects(prepare(unsigned, { kind: "appimage", target }, join(dir, "updates"), { fetch: good.fetch, runner, keys }), /no signed/);
  assert.equal(readFileSync(target, "utf8"), "binary:1.1.1");
  assert.deepEqual(readdirSync(dir).sort(), ["meterkat-desktop-1.1.1-linux-x64.AppImage"]);
  await assert.rejects(prepare(good.release, { kind: "manual", reason: "Development run" }, join(dir, "updates"), { fetch: good.fetch, keys }), /Development run/);
});

test("on Windows the verified installer waits in the download folder and runs silently, then starts the app", async t => {
  const { dir } = sandbox(t);
  const downloads = join(dir, "updates"); mkdirSync(downloads); writeFileSync(join(downloads, "leftover.exe"), "old");
  const next = release("1.2.0", "windows-x64", "installer:1.2.0");
  const prepared = await prepare(next.release, { kind: "nsis" }, downloads, { fetch: next.fetch, keys });
  assert.deepEqual(prepared, { kind: "nsis", version: "1.2.0", installer: join(downloads, "meterkat-desktop-1.2.0-windows-x64-setup.exe") });
  assert.deepEqual(readdirSync(downloads), ["meterkat-desktop-1.2.0-windows-x64-setup.exe"]);
  assert.deepEqual(launch(prepared, true, []), { file: prepared.installer, args: ["--updated", "/S", "--force-run"] });
  cleanUp({ kind: "nsis" }, downloads);
  assert.equal(existsSync(downloads), false);
});
