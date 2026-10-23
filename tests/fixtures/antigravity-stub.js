// Test stand-in for the native CLI process. Default: the documented ERROR envelope the real signed-out CLI 1.4.5
// printed. AGY_STUB_MODE=usage emits the verified 1.4.5 `/usage` layout with synthetic groups and values only.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
if (process.env.AGY_STUB_LOG) appendFileSync(process.env.AGY_STUB_LOG, JSON.stringify(args) + "\n");
// What the child sees: working directory and the display/browser variables (presence only).
if (process.env.AGY_STUB_ENV_LOG) appendFileSync(process.env.AGY_STUB_ENV_LOG, JSON.stringify({ cwd: process.cwd(), display: "DISPLAY" in process.env, wayland: "WAYLAND_DISPLAY" in process.env, browser: process.env.BROWSER ?? null }) + "\n");
// An orphan in its own process group that inherits the pipes: `close` never fires for the parent's child.
if (process.env.AGY_STUB_ORPHAN && args[0] !== "--version") {
  const orphan = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
  writeFileSync(process.env.AGY_STUB_ORPHAN, String(orphan.pid));
}
if (args[0] === "--version") { console.log(process.env.AGY_STUB_VERSION ?? "1.4.5"); process.exit(0); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const mode = process.env.AGY_STUB_MODE;
const usage = (turns, tokens) => ({ input_tokens: tokens, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: tokens });
const reset = new Date(Date.now() + 3 * 86_400_000).toISOString().replace(/\.\d+Z$/, "Z");
const payload = turns => ({
  conversation_id: "", status: "SUCCESS", response: "Alpha Models\tWeekly Limit Remaining\t75%\t" + reset + "\n", duration_seconds: 0, num_turns: turns, usage: usage(turns, turns ? 1234 : 0),
  command: { name: "usage", data: { description: "Synthetic description.", groups: [
    { name: "Alpha Models", description: "Models within this group: Alpha One", buckets: [{ id: "alpha-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.75, reset_time: reset }] },
    { name: "Beta and Gamma models", description: "Models within this group: Beta, Gamma", buckets: [{ id: "9z-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 1, reset_time: reset }] },
    { name: "Broken", buckets: [{ id: "broken", window: "weekly", remaining_fraction: 1.5, reset_time: reset }, { id: "past", window: "weekly", remaining_fraction: 0.5, reset_time: "2020-01-01T00:00:00Z" }] },
  ] } },
});
if (process.env.AGY_STUB_HANG) setInterval(() => {}, 1000);
else if (mode === "auth") { console.error("Please visit https://accounts.google.com/o/oauth2/auth?client_id=synthetic to sign in"); setInterval(() => {}, 1000); }
else if (mode === "auth-split") { process.stderr.write("Please visit https://accounts.goo"); await sleep(150); process.stderr.write("gle.com/o/oauth2/auth?client_id=synthetic\n"); setInterval(() => {}, 1000); }
else if (mode === "noise") { process.stderr.write("Tip: run agy and use /logout or login again to switch accounts.\n"); await sleep(100); console.log(JSON.stringify(payload(0))); process.exit(0); }
else if (mode === "usage") { console.log(JSON.stringify(payload(0))); process.exit(0); }
else if (mode === "inference") { console.log(JSON.stringify(payload(1))); process.exit(0); }
else {
  console.log(JSON.stringify({ conversation_id: "", status: "ERROR", response: "", error: "authentication failed or timed out", duration_seconds: 0, num_turns: 0, usage: usage(0, 0) }));
  process.exit(1);
}
