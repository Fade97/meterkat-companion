# Publishing a companion release (maintainers)

Binaries are built by this repository's [release workflow](../.github/workflows/release.yml) on GitHub-hosted runners, which attests each file's build provenance. They are published as releases of this repository, with an Ed25519-signed `SHA256SUMS`. The signing key never exists in GitHub Actions; the maintainer signs and publishes locally. Releases up to 1.0.1 are in the archived [Fade97/meterkat-releases](https://github.com/Fade97/meterkat-releases).

1. Push a tag `companion-v<semver>` in the source repository, or start *Release* manually with a version. The workflow builds and smoke-tests every target, attests every binary (`actions/attest-build-provenance`) and uploads the `meterkat-companion-release` artifact (binaries plus `SHA256SUMS`). It publishes nothing.
2. On a machine with an authenticated `gh` and access to the signing key, run `pnpm publish:release companion-v<semver>`. The key comes from `COMPANION_RELEASE_SIGNING_KEY`, or from a HashiCorp Vault KV v2 secret (`VAULT_ADDR`, with `VAULT_TOKEN` or a scoped read-only token in `~/.config/vault/meterkat-release-token`). Without `--run` it only accepts a successful tag-push run built from exactly the tagged commit (`--run <id>` for a manual run, `--dir <folder>` for local `pnpm package` output, `--targets` for a subset). The script:
   - downloads the artifact and requires every target file;
   - requires a build-provenance attestation for every file from this repository's `release.yml`, on a GitHub-hosted runner, for the tagged commit (`gh attestation verify`);
   - recomputes `SHA256SUMS` and requires it to match the workflow's;
   - runs the local binary's `version` with a minimal environment (no secrets, throwaway state, time limit); `VAULT_TOKEN` and the signing key are removed from the environment before `gh` or any binary runs;
   - signs with `COMPANION_RELEASE_SIGNING_KEY`;
   - refuses to upload unless an embedded key verifies the signature;
   - creates a **draft** release (versions with a hyphen become prereleases).
   If the workflow built everything but could not upload the artifact (Actions artifact storage quota, as for 1.0.0), package locally from the tagged commit instead: `git checkout companion-v<semver>`, `pnpm package --target <t> --version <semver>` for `linux-x64`, `linux-arm64` and `windows-x64`, then `pnpm publish:release companion-v<semver> --dir output/dist`. Local builds carry no attestation.
3. Review the draft, then run `pnpm publish:release companion-v<semver> --publish`. That re-checks the draft's signature and every asset digest against the signed list, then makes it public. Installed companions pick it up within a day.

Every binary embeds the companion's [MIT licence](../LICENSE) and the licence notices of Node.js and each bundled npm package (`meterkat licenses`); the Linux archives also contain them as `LICENSE` and `THIRD_PARTY_NOTICES.txt`. When bumping the runtime in `scripts/runtime.json`, replace `scripts/node-LICENSE` with the `LICENSE` of the same Node tag. Version-specific release notes go in `docs/releases/companion-<version>.md`.

## Signing key rotation

- **Planned rotation:**
  1. Generate a new Ed25519 key (`node -e` with `crypto.generateKeyPairSync("ed25519")`; private key as PKCS#8 PEM, public key as base64 SPKI DER).
  2. Add the new public key to `RELEASE_PUBLIC_KEYS` ([`src/release-key.ts`](../src/release-key.ts)) next to the old one, and publish that companion release still signed with the **old** key.
  3. Once most installations run it, replace the stored `COMPANION_RELEASE_SIGNING_KEY`, sign the next release with the new key, and remove the old public key in that release.
- **Compromised key:**
  1. Remove it from `RELEASE_PUBLIC_KEYS` and delete it from storage.
  2. Publish a release signed with a fresh key. Installed companions only trust their embedded keys, so they **cannot** auto-update to it.
  3. Announce a manual reinstall from the releases page (then verify by hand as above), and meanwhile delete any release signed with the compromised key.
