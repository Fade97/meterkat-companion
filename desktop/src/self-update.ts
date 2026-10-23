// Self-update for the packaged desktop app from the companion's GitHub releases, with the CLI's trust chain
// (src/update.ts): SHA256SUMS signed with an embedded Ed25519 key, then signed checksum, size and GitHub's digest,
// downloads only from GitHub over HTTPS.
// - AppImage (Linux x64): the new AppImage is staged next to the running one, must report its version, then replaces
//   it at the same path (hard-link backup, atomic rename), so the autostart entry and launchers keep working.
// - NSIS installation (Windows x64): the signed installer runs silently once the app has quit and starts it again.
// Anything else (development, unpacked builds, unwritable folder, other architectures) keeps the download link.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { desktopAssetName, downloadVerified, sidePaths, skipVersion, swapExecutable, type Fetch, type Release, type Runner } from "../../src/update.js";
import { HIDDEN_ARG } from "./login-item.js";

/** Prints the version and exits before the app starts; the start check of a staged AppImage. */
export const VERSION_ARG = "--meterkat-version";
/** electron-builder's NSIS installer starts the app with this after a silent update (`--force-run`). */
export const UPDATED_ARG = "--updated";
export const UNINSTALLER = "Uninstall Meterkat.exe";

export type Installation = { kind: "appimage"; target: string } | { kind: "nsis" } | { kind: "manual"; reason: string };
export type Prepared = { kind: "appimage"; version: string; target: string } | { kind: "nsis"; version: string; installer: string };
export type Probe = { exists(file: string): boolean; writable(dir: string): boolean };

const isWritable = (dir: string) => { try { accessSync(dir, constants.W_OK); return true; } catch { return false; } };
const realProbe: Probe = { exists: existsSync, writable: isWritable };

/** How this copy of the app can update itself, if at all. */
export function installation(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, arch: string, execPath: string, packaged: boolean, probe: Probe = realProbe): Installation {
  if (!packaged) return { kind: "manual", reason: "Development run" };
  if (arch !== "x64") return { kind: "manual", reason: `No desktop build for ${arch}` };
  if (platform === "linux" && env.APPIMAGE && isAbsolute(env.APPIMAGE)) {
    return probe.writable(dirname(env.APPIMAGE)) ? { kind: "appimage", target: env.APPIMAGE } : { kind: "manual", reason: "The AppImage's folder is not writable" };
  }
  // The per-user installer puts its uninstaller next to the executable; an unpacked copy has none.
  if (platform === "win32" && probe.exists(join(dirname(execPath), UNINSTALLER))) return { kind: "nsis" };
  return { kind: "manual", reason: "Not installed from a release build" };
}

// An Electron app has no `version` command: VERSION_ARG answers instead. The check renders nothing, so it runs without
// the Chromium sandbox, which some distributions block for AppImages.
export const appImageRunner: Runner = file => {
  const result = spawnSync(file, [VERSION_ARG, "--no-sandbox"], { encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, AI_USAGE_NO_UPDATE: "1" } });
  return { status: result.status, stdout: result.stdout ?? "" };
};

export type PrepareOptions = { fetch?: Fetch; runner?: Runner; keys?: readonly string[] };
/**
 * Downloads and verifies `release` for this installation. An AppImage is swapped in right away (the running app keeps
 * its mounted copy) and takes effect on the next start; an installer waits in `downloads` until `launch`. A version that
 * fails its start check is skipped by later automatic checks, like in the CLI.
 */
export async function prepare(release: Release, install: Installation, downloads: string, options: PrepareOptions = {}): Promise<Prepared> {
  const fetchImpl = options.fetch ?? fetch;
  if (install.kind === "appimage") {
    const { staged } = sidePaths(install.target);
    await downloadVerified(fetchImpl, release, desktopAssetName(release.version, "linux-x64")!, staged, options.keys);
    if (swapExecutable(install.target, staged, release.version, options.runner ?? appImageRunner, "linux") !== "updated") {
      skipVersion(release.version);
      throw new Error(`Meterkat ${release.version} failed its start check; kept this version`);
    }
    return { kind: "appimage", version: release.version, target: install.target };
  }
  if (install.kind === "nsis") {
    rmSync(downloads, { recursive: true, force: true }); mkdirSync(downloads, { recursive: true });
    const name = desktopAssetName(release.version, "windows-x64")!;
    const installer = join(downloads, name);
    await downloadVerified(fetchImpl, release, name, installer, options.keys);
    return { kind: "nsis", version: release.version, installer };
  }
  throw new Error(install.reason);
}

/**
 * What to start as the app quits: the replaced AppImage with the arguments this one got (e.g. `--no-sandbox`, which
 * AppImages need where unprivileged user namespaces are blocked), or the installer, which closes leftovers and
 * restarts the app.
 */
export function launch(prepared: Prepared, hidden: boolean, args: string[]) {
  return prepared.kind === "appimage"
    ? { file: prepared.target, args: [...args.filter(arg => arg !== HIDDEN_ARG && arg !== UPDATED_ARG), ...hidden ? [HIDDEN_ARG] : []] }
    : { file: prepared.installer, args: [UPDATED_ARG, "/S", "--force-run"] };
}

// Electron's main process holds many descriptors without close-on-exec (Chromium closes them itself for its own
// children) and Node passes them all on, among them the AppImage runtime's keep-alive pipe: the old AppImage would stay
// mounted until the new app quits. On Linux a shell closes everything above stderr before it starts the new version.
export const CLOSE_FDS = 'for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done 2>/dev/null; exec "$0" "$@"';
export function spawnDetached(command: { file: string; args: string[] }, platform: NodeJS.Platform = process.platform, cwd: string, shell = "/bin/bash", exists = existsSync) {
  const [file, args] = platform === "linux" && exists(shell) ? [shell, ["-c", CLOSE_FDS, command.file, ...command.args]] : [command.file, command.args];
  spawn(file, args, { detached: true, stdio: "ignore", cwd }).unref();
}

/** After a start: the previous AppImage and any staged or failed copy, or the installer downloads, are no longer needed. */
export function cleanUp(install: Installation, downloads: string) {
  const files = install.kind === "appimage" ? Object.values(sidePaths(install.target)) : install.kind === "nsis" ? [downloads] : [];
  for (const file of files) { try { rmSync(file, { recursive: true, force: true }); } catch { /* in use; next start */ } }
}
