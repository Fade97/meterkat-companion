# Meterkat companion

The desktop companion for [Meterkat](https://meterkat.fabian-duerkop.de), an Android widget and quiet notification for Claude, Codex and Antigravity subscription quotas. It runs on the Windows or Linux machine where those tools are signed in, asks them for their own usage reports and sends **end-to-end encrypted** snapshots through a relay to your phone. Provider credentials stay with the native tools; the relay only ever sees ciphertext.

Licence: [MIT](LICENSE). The Android app and the hosted relay service are not part of this repository.

## Install

Download the single-file binary for your system from the [releases](https://github.com/Fade97/meterkat-companion/releases) and run `setup`:

```sh
# Linux (x64 or arm64)
tar -xzf meterkat-companion-<version>-linux-x64.tar.gz && ./meterkat setup
```

```powershell
# Windows 10/11 (x64), not code-signed: SmartScreen → More info → Run anyway
.\meterkat-companion-<version>-windows-x64.exe setup
```

Prefer a window? The **desktop app** (`meterkat-desktop-<version>-windows-x64-setup.exe` or `…-linux-x64.AppImage`) does the same with a setup wizard, a pairing QR in the window and a tray icon it collapses into when you close it: [docs/installation.md](docs/installation.md#desktop-app-window-and-tray-icon).

`setup --dry-run` shows the plan without changing anything. Setup checks the AI tools, installs the binary for your user (no admin/root), registers with the relay, optionally enables autostart and shows a pairing QR code for the Meterkat app. Details, autostart, updates and manual verification: [docs/installation.md](docs/installation.md).

Packaged builds update themselves once a day, but only to releases whose `SHA256SUMS` carries a valid Ed25519 signature by a key embedded in [`src/release-key.ts`](src/release-key.ts). From 1.0.2 on, every binary also has a GitHub build-provenance attestation tying it to this repository's [release workflow](.github/workflows/release.yml):

```sh
gh attestation verify meterkat-companion-<version>-linux-x64 -R Fade97/meterkat-companion
```

## What it reads and sends

| Provider | Source | Notes |
| --- | --- | --- |
| Claude | Unmodified `claude` CLI, local `/usage` command in headless JSON mode ([documented report](https://code.claude.com/docs/en/agent-sdk/typescript#sdkusagereport)) | Only `session` and `weekly_all` limits. No inference request. |
| Codex | Native App Server `account/rateLimits/read` ([documented interface](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)) | Five-hour and weekly windows. No inference request, no auth-file handling. |
| Antigravity | Signed-in `agy -p /usage --output-format json` (1.1.11+) | Optional, one meter per quota bucket: [docs/antigravity.md](docs/antigravity.md). |

Snapshots contain only provider IDs and states, used percentages, reset times, quota bucket labels and observation times ([`shared/snapshot.ts`](shared/snapshot.ts)). Passwords, session tokens, emails, prompts and transcripts are never read into a snapshot. `meterkat inspect` reports availability only, without quota values.

Snapshots are encrypted with a 32-byte key generated on your machine; it reaches your phone only in the fragment of the pairing link and is never sent to the relay. The protocol is specified in [protocol/v2.md](protocol/v2.md), with the design rationale in [ADR 0001](docs/adr/0001-relay-protocol-v2.md) and test vectors in [protocol/v2-test-vectors.json](protocol/v2-test-vectors.json).

## Relay

By default the companion uses the hosted relay `https://meterkat-relay.fabian-duerkop.de`, a free service under its own [terms of use](https://meterkat.fabian-duerkop.de/terms) and [privacy policy](https://meterkat.fabian-duerkop.de/privacy). Registration is anonymous (a short proof of work). Use `--relay <origin>` or `AI_USAGE_RELAY` for another relay that speaks protocol v2; the app accepts it under **Advanced: custom relay**.

## Development

Node.js 22.13+ and pnpm:

```sh
pnpm install
pnpm typecheck
pnpm test                  # unit tests + protocol vector check
pnpm meterkat inspect      # run from source
pnpm bundle                # output/ai-usage.cjs for your own Node
pnpm package               # single-file binary for this host (output/dist)
pnpm --filter meterkat-desktop start        # desktop app from source (Electron)
pnpm --filter meterkat-desktop dist:linux   # AppImage in desktop/release (Windows installer: dist:win on Windows)
```

| Path | Contents |
| --- | --- |
| `src/` | CLI, setup, collectors (`claude.ts`, `codex.ts`, `antigravity.ts`), relay client, autostart, self-update |
| `shared/` | Snapshot model and protocol v2 crypto (Web Crypto; also used by the relay and the app's test vectors) |
| `protocol/` | Protocol v2 reference and test vectors |
| `scripts/` | Packaging (Node SEA), release publishing, install scripts for the Node bundle |
| `desktop/` | Desktop app (Electron): window, tray icon, setup wizard; reuses `src/` for collecting, relay and pairing |
| `tests/` | `node:test` suites; CI runs them on Ubuntu and Windows |

Releases: [docs/releasing.md](docs/releasing.md).

## Contributing and security

Issues and pull requests are welcome. Please keep changes focused and include tests; collectors must never send more than the snapshot fields above.

Report vulnerabilities privately, not in public issues: see [SECURITY.md](SECURITY.md).

Meterkat is not affiliated with or endorsed by Anthropic, OpenAI or Google. "Meterkat" and its logo identify the official app and releases; the MIT licence covers the code, not the name.
