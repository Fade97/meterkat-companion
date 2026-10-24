# Meterkat companion: installation, setup and updates (Windows and Linux)

The companion runs on the computer where Claude Code and/or Codex are signed in. It reads their quota reports and sends sanitized snapshots to the relay, where your phone picks them up. Everything is user-scoped: no administrator/root rights, nothing starts automatically unless you agree.

## Install the single-file companion (recommended)

Download from this repository's [releases](https://github.com/Fade97/meterkat-companion/releases) (tags `companion-v<version>`; 1.0.1 and earlier are in the archived [meterkat-releases](https://github.com/Fade97/meterkat-releases/releases)). From 1.0.2 on, the binaries are built from this repository by its [release workflow](../.github/workflows/release.yml) and carry a build-provenance attestation (`gh attestation verify <file> -R Fade97/meterkat-companion`); 1.0.1 and earlier were built before the source was published. Each file is self-contained, so you don't need a separate Node.js:

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

Packaged builds keep themselves current. Once a day the running companion asks `Fade97/meterkat-companion` (public GitHub API, no credentials) for the newest published `companion-v*` release on its update channel:

- **Stable:** releases only. **Beta:** prereleases too (judged by the version, e.g. `1.2.0-beta.1`, not by GitHub's flag), whichever version is highest.
- Choose with `meterkat update channel stable|beta` (no argument shows it) or the dropdown under **Settings → Update channel** in the desktop app; both share the setting. Without a choice, a beta installation stays on Beta and a release on Stable. `meterkat update --prerelease` looks at betas once, `AI_USAGE_UPDATE_PRERELEASE=1` forces Beta.
- Switching back to Stable never downgrades: the installed beta stays until a newer release (e.g. `1.2.0` after `1.2.0-beta.4`).

`AI_USAGE_UPDATE_REPO` points to another releases repository. Updates are checked like this:

- **Sources:** only `api.github.com`, `github.com` and `*.githubusercontent.com` over HTTPS, checked on every redirect.
- **Verification:** `SHA256SUMS.sig` must be a valid Ed25519 signature over `SHA256SUMS` by a release key embedded in the companion. Releases without a signature, or with an invalid one, are refused. The download must then match its signed checksum and the size and SHA-256 GitHub recorded for the asset; otherwise it is discarded.
- **Swap:** the new file is staged next to the installed one (`meterkat.new`, created exclusively) and must answer `version` correctly. Linux keeps a hard-link backup (`meterkat.old`) and replaces the binary in one atomic rename. Windows renames the running exe to `meterkat.old.exe` and moves the new one in; an interrupted swap is repaired on the next start. If the new binary fails the check at the final path, the old one is restored automatically, and that version is skipped by later automatic checks (a newer release is tried again).
- **Restart:** a systemd unit restarts the companion within a minute. A Windows sign-in instance starts the new version in the background. A companion run by hand prints a hint to restart it.
- **Autostart:** never changed by an update. Because the path stays the same, an installed unit or Run entry keeps working.
- **Commands:** `meterkat update check` (report only), `meterkat update` (apply now), `meterkat update rollback` (go back to `.old`), `meterkat update channel [stable|beta]`, `meterkat update status`.
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

## Desktop app (window and tray icon)

An optional alternative to the command line, with the same relay protocol and state. Download from the [releases](https://github.com/Fade97/meterkat-companion/releases) (1.0.3 and later):

- **Windows:** `meterkat-desktop-<version>-windows-x64-setup.exe` installs for your user only (no admin) and starts Meterkat. Not code-signed: SmartScreen → **More info → Run anyway**.
- **Linux:** `meterkat-desktop-<version>-linux-x64.AppImage`; `chmod +x` it and start it. Distributions that block unprivileged user namespaces need `--no-sandbox`.

On first start a short setup checks your AI tools, registers with the relay (hosted relay or your own), offers to start at sign-in and shows the pairing QR code in the window. Afterwards the window shows your quota, paired phones (connect, remove) and settings (start at sign-in, updates, licences).

**Tray:** closing or minimising the window collapses Meterkat into a tray icon; it keeps syncing every minute. The tray menu shows the quota per provider, syncs, opens the window, toggles start at sign-in and quits. Starting Meterkat a second time opens the existing window. GNOME shows tray icons only with the *AppIndicator and KStatusNotifierItem Support* extension; without it, start Meterkat again to bring the window back.

**Start at sign-in** starts Meterkat hidden in the tray: a `Meterkat` entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` on Windows, `~/.config/autostart/meterkat-desktop.desktop` on Linux. It is separate from the CLI autostart below. If the CLI companion already runs as a background service for the same state directory, the app only displays its data and does not upload a second time; **Settings → Let the app sync instead** removes the CLI autostart, stops its process and enables the app's own start at sign-in.

**Updates:** the app updates itself from the same releases with the same checks as the CLI ([Updates](#updates)): `SHA256SUMS` must carry a valid signature by the embedded release key, and the download must match its signed checksum and GitHub's size and digest. Once a day it looks for a newer release on the update channel chosen under **Settings → Update channel** (Stable or Beta; changing it checks again right away) and, with **Settings → Install updates automatically** on, downloads and verifies it in the background:

- **AppImage:** the new AppImage is staged next to yours (`….new.AppImage`) and must report its version (`--meterkat-version`), then replaces your file in one atomic rename at the same path, so start at sign-in and launchers keep working (the file keeps its name). The previous copy (`….old.AppImage`) is deleted after the next start. If the new AppImage fails the check, yours stays untouched and that version is skipped. The folder must be writable for your user; otherwise the app only links to the download.
- **Windows:** the signed installer is downloaded to `%APPDATA%\Meterkat\updates` and runs silently (`--updated /S --force-run`) after Meterkat quits; it starts Meterkat again and is deleted afterwards. A copy run from an unpacked folder (no `Uninstall Meterkat.exe` next to it) only links to the download.
- **Restart:** while Meterkat sits in the tray it restarts into the new version by itself (hidden again). With the window open it waits until you close the window, or choose **Restart to update** in the settings or the tray menu.
- **Opt-out:** the switch is shared with `meterkat update disable|enable` (same state directory). Off, the app still checks daily and offers **Update now**; `AI_USAGE_NO_UPDATE=1` turns off the check as well.

**Island:** while Claude, Codex or T3 Code is in front, a small Meterkat drop hangs from the top edge of that screen. It is ink with the sand mark over light backgrounds and white with the ink mark over dark ones. It opens into a short notice when a quota rises by 10 points or crosses 50, 75 or 90 %, 60, 30, 10, 5 and 1 minutes before a used window resets, and once after the reset. It counts as in front:

- the Claude, Codex, ChatGPT and T3 Code apps
- a terminal (or VS Code/Cursor) running `claude` or `codex`
- a browser tab whose title ends in Claude, Codex or ChatGPT (ChatGPT chats carry only their own title, so only its start page counts)

**Click the drop** (or an open notice) to see every provider at once: each window or quota bucket with its bar, percentage and time to reset. The panel closes when you click it again or move the pointer away from it. The island never takes focus; it takes clicks only while the pointer is on it and lets them through everywhere else. It hides over full-screen apps. Turn it off under **Settings → Show the island** or in the tray menu. It works on Windows and on Linux with X11. Wayland does not tell apps which window is in front, so the island is off there. Linux reads the foreground window with `xprop` and the pointer from the X server (libX11 through [koffi](https://koffi.dev/)); Windows uses Win32 calls through koffi.

**Pinned to the AI window:** **Settings → Island sits at → AI window** (or *Pin island to the AI window* in the tray menu) hangs the drop from the top edge of the AI window in front instead of the screen, centred on it. It follows the window as you move or resize it, within a few milliseconds; the open panel stays put until it closes. Near a screen edge it stays on screen. The system reports the moves: Windows through WinEvent hooks (only on the window in front) and the window's visible frame from DWM, Linux through its own X connection (xcb) and the window manager's frame extents. Should that not start, the island checks the window's position instead, every 150 ms while it moves. The default is *Top of screen*.

**Used or remaining:** **Settings → Coloured bars show** switches every bar and percentage between the used share and what is left, in the window, the island and the tray menu, like the setting in the phone app. It starts on *Used*. `METERKAT_ISLAND_DEMO=1` shows the island with sample notices regardless of the foreground window, for trying it out.

Desktop sessions don't read your shell profile, so on Linux the app asks your login shell (`$SHELL -ilc`) for its `PATH` once at start to find `claude`, `codex` and `agy`. `AI_USAGE_CLAUDE_BIN`, `AI_USAGE_CODEX_BIN` and `AI_USAGE_ANTIGRAVITY_BIN` still override the lookup.

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
- Codex installed with npm is a `codex.js` entry point. The packaged `meterkat.exe` is not Node, so it starts that script with `node.exe` from PATH; without Node on PATH, set `AI_USAGE_CODEX_BIN` to a native `codex.exe`.
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

`tests/update.test.ts` covers release selection (prereleases only on the beta channel, channel defaults and no downgrade back on stable), signature and checksum/digest rejection, the publish script's file/checksum/key checks, the swap with start checks, rollback and Windows signature stripping; `tests/setup.test.ts` covers the dry run, consent and reuse of existing registration/installation. The release workflow (`.github/workflows/release.yml`) builds every target and runs `version`, `inspect` and `setup --dry-run` on Linux x64, Windows x64 and Linux arm64 (QEMU). `tests/autostart.test.ts` covers unit/Run generation, quoting with spaces, `%` and `$`, deliberate PATH, secret exclusion, foreign-unit protection, state preservation and the background lock, using temporary directories and a recording command runner. Tests never call `systemctl` or `reg.exe`. CI runs them on Ubuntu and Windows; a real sign-in/reboot check on each OS is still a manual step. `desktop/tests/self-update.test.ts` covers which installations update themselves, the AppImage swap with start check and skip, refused unsigned/forged/tampered releases and the Windows installer download and arguments.
