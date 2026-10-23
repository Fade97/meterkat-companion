# Meterkat companion: installation, setup and updates (Windows and Linux)

The companion runs on the computer where Claude Code and/or Codex are signed in. It reads their quota reports and sends sanitized snapshots to the relay, where your phone picks them up. Everything is user-scoped: no administrator/root rights, nothing starts automatically unless you agree.

## Install the single-file companion (recommended)

Download from the public releases page [github.com/Fade97/meterkat-releases/releases](https://github.com/Fade97/meterkat-releases/releases) (tags `companion-v<version>`). From 1.0.2 on, the binaries are built from this repository by its [release workflow](../.github/workflows/release.yml) and carry a build-provenance attestation (`gh attestation verify <file> -R Fade97/meterkat-companion`); 1.0.1 and earlier were built before the source was published. Each file is self-contained, so you don't need a separate Node.js:

| System | File |
| --- | --- |
| Windows 10/11 (x64) | `meterkat-companion-<version>-windows-x64.exe` |
| Linux x64 (glibc 2.28+) | `meterkat-companion-<version>-linux-x64.tar.gz` (or the bare binary) |
| Linux arm64 (glibc 2.28+) | `meterkat-companion-<version>-linux-arm64.tar.gz` (or the bare binary) |

### Windows

1. Download the `.exe`, open a terminal (PowerShell) in the download folder and run `.\meterkat-companion-<version>-windows-x64.exe setup`.
2. The builds are **not code-signed**. If Windows SmartScreen shows "Windows protected your PC", click **More info → Run anyway**. Double-clicking opens a console window that closes when it finishes; prefer the terminal. Check the download against the signed `SHA256SUMS` first if you like (`Get-FileHash <file>`, see [Verify a download by hand](#verify-a-download-by-hand)).
3. `setup` copies itself to `%LOCALAPPDATA%\Programs\Meterkat\meterkat.exe` and continues from there. After that you can delete the download.

### Linux

```sh
tar -xzf meterkat-companion-<version>-linux-x64.tar.gz   # contains the executable `meterkat`, LICENSE and THIRD_PARTY_NOTICES.txt
./meterkat setup
```

`setup` installs to `~/.local/bin/meterkat`. Most distributions have that folder on `PATH`, so `meterkat <command>` works afterwards.

### What `setup` does

`meterkat setup --dry-run` prints the plan and changes nothing: no files, no relay calls, no provider checks. Without `--dry-run`, setup walks through five steps:

1. **AI tools.** Finds `claude`, `codex` and `agy` (Antigravity) on `PATH` (or via `AI_USAGE_CLAUDE_BIN` / `AI_USAGE_CODEX_BIN` / `AI_USAGE_ANTIGRAVITY_BIN`) and reads one native quota report from each, so you can see that sign-in works. Antigravity is optional: it is only collected once a signed-in `agy` (1.1.11 or newer) answers, see [antigravity.md](antigravity.md).
2. **Program.** Installs the running executable to the stable path above through the same swap the updater uses. A newer installed copy (for example one that already updated itself) is kept unless you pass `--force`.
3. **Relay.** Reuses an existing registration. Otherwise it registers a new protocol v2 source ([protocol](../protocol/v2.md)) with `https://meterkat-relay.fabian-duerkop.de`, with `AI_USAGE_RELAY`, or with `--relay <origin>` (e.g. staging `https://meterkat-relay-staging.fabian-duerkop.de`). Registration is anonymous: the companion solves a short proof of work (a few seconds), and the end-to-end encryption key is generated locally and never sent to the relay. Setup never uses an operator token; closed self-hosted relays use `register` with `RELAY_ADMIN_TOKEN` (see below).
4. **Autostart (optional).** Setup asks before enabling it (systemd user unit / per-user Run entry, see below). Pass `--autostart` to agree without a prompt, or `--no-autostart` to skip. A non-interactive run without `--autostart` never enables it.
5. **Phone.** Creates a single-use pairing code (expires in 5 minutes) and shows the v2 pairing link `https://meterkat.fabian-duerkop.de/pair?v=2&…#k=…` as a QR code in the terminal and on the local pairing page (opened unless `--no-open`; it deletes itself after expiry). Scan it with the Meterkat app on your own phone. The link carries your encryption key, so don't share or screenshot it. Run `meterkat pair` for a new code. Tap the link on the phone (it opens the app through a verified App Link) or use **Scan QR code** in the app. The Android app speaks only protocol v2; v1 sources (`register --v1`) can no longer pair with it.

Later commands: `meterkat inspect` (availability only, no quota values), `meterkat run` (foreground), `meterkat autostart status|install|remove`, `meterkat revoke`, `meterkat version`, `meterkat --help`. The destructive `meterkat delete` (type `delete` to confirm) and `meterkat rotate-key` (y/N) ask first; they accept only `--yes`, which skips the question and is required in scripts or other non-interactive runs. Any other argument is refused before anything changes (1.0.0 ignored extra arguments, so `delete --help` deleted the source; fixed in 1.0.1).

### Updates

Packaged builds keep themselves current. Once a day the running companion asks `Fade97/meterkat-releases` (public GitHub API, no credentials) for the newest published, non-prerelease `companion-v*` release. Prereleases (judged by the version, e.g. `1.1.0-rc.1`, not by GitHub's flag) are only considered with `meterkat update --prerelease` or `AI_USAGE_UPDATE_PRERELEASE=1` (testing). `AI_USAGE_UPDATE_REPO` points to another releases repository. Updates are checked like this:

- **Sources:** only `api.github.com`, `github.com` and `*.githubusercontent.com` over HTTPS, checked on every redirect.
- **Verification:** `SHA256SUMS.sig` must be a valid Ed25519 signature over `SHA256SUMS` by a release key embedded in the companion. Releases without a signature, or with an invalid one, are refused. The download must then match its signed checksum and the size and SHA-256 GitHub recorded for the asset; otherwise it is discarded.
- **Swap:** the new file is staged next to the installed one (`meterkat.new`, created exclusively) and must answer `version` correctly. Linux keeps a hard-link backup (`meterkat.old`) and replaces the binary in one atomic rename. Windows renames the running exe to `meterkat.old.exe` and moves the new one in; an interrupted swap is repaired on the next start. If the new binary fails the check at the final path, the old one is restored automatically, and that version is skipped by later automatic checks (a newer release is tried again).
- **Restart:** a systemd unit restarts the companion within a minute. A Windows sign-in instance starts the new version in the background. A companion run by hand prints a hint to restart it.
- **Autostart:** never changed by an update. Because the path stays the same, an installed unit or Run entry keeps working.
- **Commands:** `meterkat update check` (report only), `meterkat update` (apply now), `meterkat update rollback` (go back to `.old`), `meterkat update status`.
- **Opt-out:** `meterkat update disable` (`enable` to undo) or `AI_USAGE_NO_UPDATE=1`. Manual `update` still works.

### Verify a download by hand

The release public key (also embedded in [`src/release-key.ts`](../src/release-key.ts)):

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAsfoAgmlN/MNRT0/+INbbeSy/9oDUfK5CWQMZmUg0hNc=
-----END PUBLIC KEY-----
```

Save it as `meterkat-release.pub`, download `SHA256SUMS` and `SHA256SUMS.sig` next to the binary, then:

```sh
base64 -d SHA256SUMS.sig > SHA256SUMS.sig.bin
openssl pkeyutl -verify -pubin -inkey meterkat-release.pub -rawin -in SHA256SUMS -sigfile SHA256SUMS.sig.bin
sha256sum -c SHA256SUMS --ignore-missing
```

## Rename from "AI usage"

Older installations keep working:

- **State:** the existing `ai-usage` state directory (relay credential, pairing, snapshots) is used as long as no `meterkat` directory exists.
- **Autostart:** a managed `ai-usage-companion.service` or `AIUsageCompanion` Run entry is replaced by `meterkat-companion.service` / `MeterkatCompanion` on the next `autostart install` (or `setup`), and `autostart status` points it out. An unmanaged legacy unit, such as the private pilot's, is never touched; installing next to it is refused so two companions don't share one state.
- **Bundle:** `ai-usage.cjs` and `pnpm companion` remain as aliases of `meterkat`.

## From source (development, Node bundle)

The steps below install the bundled JavaScript file and run it with your own Node.js. They don't update themselves.

### Prerequisites

- Node.js 22.13+ installed for your user.
- Signed-in native `claude` and/or `codex` CLIs .
- A relay origin. Plain `register` creates a protocol v2 source ([ADR 0001](adr/0001-relay-protocol-v2.md)), the only protocol the Android app speaks. Release builds of the app accept the hosted relay without setup; a self-hosted relay must be allowed in the app under **Advanced: custom relay**. `--v1` with an operator `RELAY_ADMIN_TOKEN` remains only for relay tests; phones can't pair with v1 sources any more.

### 1. Build and install the bundle

```sh
pnpm install --frozen-lockfile
pnpm bundle
```

Linux copies to `${XDG_DATA_HOME:-~/.local/share}/ai-usage/companion/ai-usage.cjs`:

```sh
scripts/install.sh install
```

Windows copies to `%LOCALAPPDATA%\Programs\ai-usage\ai-usage.cjs`:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 install
```

Both scripts use the `node` found on PATH; set `AI_USAGE_NODE` to an absolute `node`/`node.exe` path to choose another one. Paths with spaces are supported.

### 2. Register and pair

Run with the installed bundle (`B` = path printed by the install script, `N` = Node path):

```sh
"$N" "$B" register https://your-relay.example   # protocol v2 (proof of work); a closed relay takes RELAY_ADMIN_TOKEN
"$N" "$B" pair
"$N" "$B" inspect                                # provider availability only, no quota values
```

The scoped relay credential is stored in the user state directory (Linux `~/.local/state/meterkat`, Windows `%LOCALAPPDATA%\meterkat`; an existing `ai-usage` directory is kept, override with `AI_USAGE_STATE_DIR`). The admin token is never stored or written into autostart entries.

## Autostart (opt-in, both install types)

For the single-file companion the executable itself is the launcher (`ExecStart="…/meterkat" run`, Run entry `"…\\meterkat.exe" background …`); everything else below applies unchanged.

```sh
"$N" "$B" autostart install
"$N" "$B" autostart status    # JSON: installed, enabled, active, matches, problems
"$N" "$B" autostart remove
```

`install` refuses to run before `register`, and from TypeScript sources (`pnpm meterkat`) — it always targets the absolute Node executable and bundle path used to invoke it. Run `install` again after moving the bundle or changing the Node installation; `status` reports drift.

The install scripts also accept `install --autostart` (Linux) / `install -Autostart` (Windows).

### Linux: systemd user unit

- Writes `${XDG_CONFIG_HOME:-~/.config}/systemd/user/meterkat-companion.service` (mode 600), then `systemctl --user daemon-reload`, `enable` and `restart`. Reinstalling after moving Node or the bundle therefore replaces a running old process.
- Runs `node <bundle> run` with `Restart=on-failure`, `UMask=0077`, `NoNewPrivileges=yes`; logs go to `journalctl --user -u meterkat-companion`.
- systemd user services do not inherit the login shell PATH. The unit gets a deliberate PATH: Node's directory, directories of `AI_USAGE_CLAUDE_BIN`/`AI_USAGE_CODEX_BIN`, directories on the current PATH that contain `claude` or `codex`, `~/.local/bin`, and `/usr/local/bin:/usr/bin:/bin`. No other environment is captured. `AI_USAGE_STATE_DIR`, `AI_USAGE_CLAUDE_BIN` and `AI_USAGE_CODEX_BIN` are forwarded only when set during `install`; the state directory is resolved to an absolute path so startup cannot change its meaning.
- Values are quoted for systemd: `\`, `"` and `%` (specifiers) are escaped everywhere; `$` is doubled only in `ExecStart=`, because `Environment=` does not expand variables. Quotes and control characters in paths are rejected.
- `remove` runs `disable --now` first and keeps the unit file if that fails, so a failed removal never leaves an unmanaged running service.
- The unit starts with a marker line. An existing unit without it (for example an operator-managed unit) is never overwritten, disabled or removed; install and remove fail instead.
- Without an active login session user services stop. To run before login: `loginctl enable-linger "$USER"` (your decision; not done automatically).

### Windows: per-user Run entry

- Adds `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value `MeterkatCompanion` via `reg.exe` (argv only, no shell): `"<node.exe>" "<bundle>" background "<state>\autostart.json"`.
- The sign-in environment does not contain overrides that were set only in the installing shell. `install` therefore writes `autostart.json` (private, in the resolved state directory) with the resolved `AI_USAGE_STATE_DIR` and, when set, `AI_USAGE_CLAUDE_BIN`/`AI_USAGE_CODEX_BIN`. `background` restores only these keys; no relay/admin tokens or other environment are stored.
- At sign-in `background` starts a detached, hidden `run` process and exits; a short console flash is possible. A PID file in the state directory prevents a second instance within the same boot. Output goes to `companion.log` in the state directory (status lines only; restarted beyond 1 MB).
- The Run entry inherits your user environment, so native tools on your user PATH are found. Start immediately with `"$N" "$B" background`.
- Reinstalling changes the next sign-in only; a companion already running keeps its previous settings until it is stopped.
- `remove` deletes the Run value and `autostart.json`; a running companion continues until sign-out (or end `node.exe` in Task Manager). The PowerShell uninstall keeps the bundle if autostart removal fails.
- Restrict the state folder's ACL to your user.

## Uninstall

```sh
scripts/install.sh uninstall
powershell -ExecutionPolicy Bypass -File scripts\install.ps1 uninstall
```

This removes autostart and the installed bundle. Pairing and source state is kept so a reinstall keeps working. To retire the companion completely, run `"$N" "$B" revoke` first, then delete the state directory manually.

## Verification

`tests/update.test.ts` covers release selection (prereleases opt-in), signature and checksum/digest rejection, the publish script's file/checksum/key checks, the swap with start checks, rollback and Windows signature stripping; `tests/setup.test.ts` covers the dry run, consent and reuse of existing registration/installation. The release workflow (`.github/workflows/release.yml`) builds every target and runs `version`, `inspect` and `setup --dry-run` on Linux x64, Windows x64 and Linux arm64 (QEMU). `tests/autostart.test.ts` covers unit/Run generation, quoting with spaces, `%` and `$`, deliberate PATH, secret exclusion, foreign-unit protection, state preservation and the background lock, using temporary directories and a recording command runner. Tests never call `systemctl` or `reg.exe`. CI runs them on Ubuntu and Windows; a real sign-in/reboot check on each OS is still a manual step.
