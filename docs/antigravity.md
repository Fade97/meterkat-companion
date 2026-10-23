# Antigravity quota collection

Status (2026-10-22): **collector live** for the official CLI `agy` ≥ 1.1.11, verified with 1.4.5 on a signed-in Linux host. Antigravity is an *optional* provider: the companion only reports it once a real quota read has worked, and only while the CLI stays installed. The phone shows it with its own glyph and one meter per quota bucket.

## What is officially documented

| Source | Statement |
|---|---|
| [CLI `/usage` docs](https://www.antigravity.google/docs/cli/commands/usage) | `/usage` (alias `/quota`) opens an interactive "Model Quotas" panel and refreshes quota status from the backend. The docs list no flags, no JSON fields and no reset semantics. |
| [CHANGELOG 1.1.11](https://github.com/google-antigravity/antigravity-cli/blob/main/CHANGELOG.md) | Print mode answers `-p "/usage"`, `/quota`, `/credits`, `/model`, `/effort` and `/skills` with one tab-separated record per line, or with "a structured payload under `--output-format json` and `stream-json`", "without starting an agent turn, spending quota, or leaving a conversation behind". Other interactive-only slash commands are refused explicitly. |
| CHANGELOG 1.2.15 | `-p "/usage"` shows local reset times on a terminal. "piped and `--json` output still use UTC timestamps". |
| CHANGELOG 1.2.7 | Removed a duplicate remaining-quota percentage line from the `/usage` panel. |
| [Headless docs](https://antigravity.google/docs/cli/headless) | Documents the run envelope (`conversation_id`, `status`, `response`, `error`, `duration_seconds`, `num_turns`, `structured_output`, `json_schema`, `usage`). Headless runs use cached credentials. Users must "authenticate once with an interactive `agy` session first". |
| [Status line docs](https://antigravity.google/docs/cli/statusline) | The TUI gives custom status-line commands a `quota` object keyed by model or bucket ID, with `remaining_fraction`, `reset_time` and optional `reset_in_seconds`. This only runs inside an interactive TUI session, and the same payload includes `email`. It is not the `/usage` export. |
| [CLI README](https://github.com/google-antigravity/antigravity-cli) | Install with `curl -fsSL https://antigravity.google/cli/install.sh \| bash` (Windows: `install.ps1`/`install.cmd`) and start with `agy`. Auth uses the system keyring and falls back to Google Sign-In. Remote/SSH sessions print an authorization URL. `/logout` signs out. |

**Still not documented by Google:** the `command` payload below, and which plans or accounts are eligible. The parser therefore accepts only the verified layout and treats anything else as unknown. [Terms questions](https://discuss.ai.google.dev/t/is-it-permitted-for-a-third-party-desktop-utility-to-display-quota-data-from-the-antigravity-cli-statusline/178823) about third-party display of quota data have no Google answer so far. Running the official CLI with its own session is a different case from reusing its OAuth credentials, which the Terms prohibit. This app never does the latter.

## Verified `/usage` payload (CLI 1.4.5, signed in)

Captured on 2026-10-22 on the companion host (Linux x64, official installer, Google Sign-In done natively by Fabian). The first capture was structure-only (`probe-antigravity`: `outcome: ok`, `zeroInference: true`). Values were then inspected in memory only, to map the semantics. No real values appear in this repository.

`agy -p "/usage" --output-format json` prints one JSON line:

```text
{
  conversation_id: ""                      // empty: no conversation is created
  status: "SUCCESS"
  response: string                         // same rows as TSV: group \t bucket name \t NN% \t ISO time
  duration_seconds: integer
  num_turns: 0
  usage: { input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens: 0 }
  command: {
    name: "usage"
    data: {
      description: string                  // "Within each group, models share a weekly limit. …"
      groups: [ {
        name: string                       // e.g. "Gemini Models", "Claude and GPT models"
        description: string                // "Models within this group: …"
        buckets: [ {
          id: string                       // e.g. "gemini-weekly", "3p-weekly"
          name: string                     // "Weekly Limit Remaining"
          window: string                   // "weekly"
          remaining_fraction: number       // 0..1, remaining (TSV shows it as a percentage)
          reset_time: string               // ISO 8601 UTC, second precision
        } ]
      } ]
    }
  }
}
```

Observed on this account: two groups with one weekly bucket each. Quota is per **group** (shared by the models listed in the group description), not per model. On an unused account `remaining_fraction` is `1` and `reset_time` is now + 7 days, so the window only starts with use.

**Zero inference verified:** two consecutive runs both reported `num_turns: 0` and `total_tokens: 0` with an empty `conversation_id`. The quota values stayed the same, and no new entry appeared under `~/.gemini/antigravity-cli/conversations/`, in `history.jsonl` or in `conversation_summaries.db`. A signed-in run writes nothing to stderr and takes about 1–4 s. `--version` takes about 0.3 s.

## Mapping to Meterkat meters

`fromAntigravityUsage` in `src/antigravity.ts`:

| Payload | Meter |
|---|---|
| each `groups[].buckets[]` | one meter (at most 6, in payload order) |
| `bucket.id` | meter ID, normalized to `[a-z][a-z0-9_-]{0,31}`. IDs that don't start with a letter get a `q-` prefix (`3p-weekly` → `q-3p-weekly`). |
| `group.name` + `bucket.window` | label `Gemini Models (weekly)`, cut to 32 code points (never inside a surrogate pair) of the allowed label set. The window comes from the payload, so no 5h or weekly window is invented. If a label is already taken (several buckets in one group, or two groups with the same name), the bucket name is added (`Alpha Daily Limit (weekly)`), then a number. |
| `1 − remaining_fraction` | `usedPercent` (one decimal) |
| `reset_time` | `resetsAt` |

Unknown values are left out instead of guessed: a bucket without a numeric `remaining_fraction` in 0..1, or without a parseable future `reset_time`, gets no meter. Without any valid meter, or with a non-`SUCCESS` status, the read counts as unavailable. A run that reports turns or tokens is not trusted either (`num_turns`/`total_tokens` must be 0).

## Collection behaviour

`readAntigravityUsage` runs on every companion sync (every 60 s):

1. Unless it is backing off, run `agy --version`. The first `x.y.z` anywhere in the output is the version. A missing CLI, an unrecognised version output or a version older than 1.1.11 throws: older versions would send `/usage` to the model as a prompt.
2. **Inference latch:** if this CLI version ever answered `/usage` with `num_turns` or `total_tokens` above 0, it is not run in print mode again. The version is stored as `inferenceSeenVersion` in `antigravity.json`, and one value-free line goes to stderr (`Antigravity CLI <version> ran a model turn for /usage; quota collection is paused until the CLI version changes.`). Any other `--version` output clears the latch. The probe honours it too (`outcome: inference_latched`).
3. Run `agy -p "/usage" --output-format json --print-timeout 20s` in a fresh empty temporary directory (no inherited project config or agent rules; removed afterwards), in its own process group, with stdin closed. The child gets no `DISPLAY`/`WAYLAND_DISPLAY` and `BROWSER=true` (a no-op), so a signed-out desktop host does not open a sign-in tab. Keyring access goes through D-Bus and still works (verified live). Stop it after 20 s or 256 kB.
4. **Always resolves:** the run settles on `close`, at the timeout, or 3 s after a kill or exit, even when an orphaned grandchild keeps the pipes open; the pipes are then destroyed. The kill is `kill(-pgid, SIGKILL)` on Unix and `taskkill /PID <pid> /T /F` on Windows. One stuck CLI therefore cannot hold up `collect()` and with it Claude and Codex.
5. **Signed out:** the CLI prints a Google authorization URL to stderr and waits about 60 s for a pasted code. Stderr is matched as a rolling tail of at most 512 characters in memory, never stored or logged, so a URL split across chunks is still found. Only the Google OAuth URL (`https://accounts.google.com/…oauth|signin…`) or an explicit prompt ("please sign in", "enter the authorization code", "authentication required", …) counts; a stray "login" in a harmless message does not end a good run. On a match the process group is killed at once and the provider becomes `auth_required`. The stub tests cover this path. It was not repeated live, because that would mean signing the host out.
6. Failures back off 5, 10, 20, 40, then 60 minutes. A sign-in prompt keeps doubling up to 24 hours, so a signed-out host starts the CLI at most about once a day (on Windows and macOS, where the browser switch above has no effect, this bounds any sign-in tab). The state is `antigravity.json` in the state directory. The first successful read resets it, and so does a successful `probe-antigravity`: run it after signing in to skip the remaining wait. While backing off the CLI is not started at all.

`collect` treats Antigravity as optional:

- Until the first successful read, failures leave it out of the snapshot entirely. Hosts without `agy`, or signed out from the start, keep sending only Claude and Codex.
- After that, a failed read keeps the last meters with their original observation time (stale on the phone), marked `auth_required` or `unavailable`.
- If the CLI disappears or becomes too old, the provider is dropped again.
- The reader is **on by default**. Meterkat v1.0 phones accept 1–12 providers. Phones from the private pilot (old package ID, exactly two providers) have to be reinstalled for v1.0 anyway, so no installation that receives Antigravity data can reject it. `AI_USAGE_ANTIGRAVITY=off` disables the reader, for example for an old pilot build still in use .

Nothing reads, copies or refreshes Antigravity credentials. The native CLI owns sign-in. `setup` and `inspect` use the same reader, so a signed-in CLI shows up as "signed in, quota readable".

## Probe

```sh
pnpm companion probe-antigravity      # or: meterkat probe-antigravity
```

A one-off structural diagnostic for new CLI versions. It reports `installed`, `version`, `outcome` (`ok`, `auth_required`, `error_envelope`, `timeout`, `too_large`, `no_json`, `inference_latched`), the envelope `status`, `zeroInference` and a structural summary. The summary shows types, array lengths and allowlisted key names; other keys are masked as `<keyN>`; the cap is 32 keys per object and depth 6. It never includes values, error text or stderr. Nothing is sent to the relay. Use it first when a CLI update changes the payload, before you adapt the parser.

## Evidence

| Check | Result |
|---|---|
| Signed-out 1.4.5 (earlier, throwaway `HOME`) | OAuth URL on stderr, about 60 s wait for a code, then an ERROR envelope with `num_turns: 0` and exit code 1 |
| Signed-in probe | `outcome: ok`, `status: SUCCESS`, `zeroInference: true` |
| Zero inference | 2 runs: unchanged values, no conversation, history or summary entries |
| Live reader | `state: ok`, 2 meters, about 4 s |
| `inspect` | `claude`, `codex`, `antigravity` all `ok` |
| Staging relay E2E | temporary v2 source → `once` (3/3 providers) → pair → read and decrypt → Antigravity meters present, relay data contains no plaintext → source deleted |
| Node tests | parser (mapping, unknown/expired buckets, limits, code-point cuts, duplicate labels), reader (synthetic stub: payload, sign-in prompt split across chunks, harmless "login" text, backoff up to 24 h, inference latch and its release on a version change, empty cwd and child environment, unrecognised/old/missing CLI), a stuck child with an orphan holding the pipes (timeout and auth kill both resolve), `collect` optional-provider lifecycle, probe |
| Review round (2026-10-22) | Live after the changes: probe `ok`, `zeroInference: true`; `inspect` antigravity `ok`, 2 meters (empty cwd, no display variables). No temporary directories left behind. |

## Open

- Plan eligibility and other account tiers: the bucket layout may differ (more groups, other windows). The parser handles up to 6 buckets with the window in the label. Anything else stays unknown.
- Windows: `agy` is started without a shell, from `PATH` or `AI_USAGE_ANTIGRAVITY_BIN`. If the installer only puts a `.cmd`/`.ps1` shim on `PATH`, Node cannot start it without a shell (ENOENT, or EINVAL for an explicit `.cmd` path). That counts as "CLI not found": the reader fails safe and Antigravity is simply not reported. `setup`/`inspect` then say "CLI not found"; point `AI_USAGE_ANTIGRAVITY_BIN` at the real `.exe`. A shell is deliberately not used. The `taskkill` tree kill and the shim behaviour are not tested live on Windows.
- Google has not answered whether third-party display is allowed (see the Terms link above).
