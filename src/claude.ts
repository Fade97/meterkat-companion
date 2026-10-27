import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromClaudeReport, type ProviderUsage } from "../shared/snapshot.js";
import { accountFingerprint } from "./account.js";

const claudeCommand = () => process.env.AI_USAGE_CLAUDE_BIN ?? (process.platform === "win32" ? "claude.exe" : "claude");

/** Execute only the native local /usage command, never an inference prompt. Native CLI owns auth. */
export async function readClaudeUsage(timeoutMs = 25_000): Promise<ProviderUsage> {
  // Claude Code 2.1.309 intermittently reports `rate_limits: null` for a signed-in account; a second call has it.
  const first = await readUsageOnce(timeoutMs);
  const usage = first.state === "ok" ? first : await readUsageOnce(timeoutMs);
  if (usage.state !== "ok") return usage;
  const account = await readClaudeAccount();
  return account ? { ...usage, account } : usage;
}

// The account rarely changes; one `auth status` per 10 minutes keeps the per-minute poll light (#47).
let cachedAccount: { value: string | undefined; until: number } | undefined;
export function resetClaudeAccountCache() { cachedAccount = undefined; }
/** Fingerprint from the local `claude auth status --json` (organization ID + e-mail). Any failure means no fingerprint. */
export async function readClaudeAccount(timeoutMs = 10_000, now = Date.now()): Promise<string | undefined> {
  if (cachedAccount && cachedAccount.until > now) return cachedAccount.value;
  const value = await new Promise<string | undefined>(resolve => {
    const child = spawn(claudeCommand(), ["auth", "status", "--json"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let output = ""; let settled = false;
    const finish = (result?: string) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); resolve(result); };
    const timer = setTimeout(() => finish(), timeoutMs);
    child.once("error", () => finish());
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); if (output.length > 64_000) finish(); });
    child.once("close", () => {
      try {
        const status = JSON.parse(output);
        finish(status?.loggedIn === true ? accountFingerprint("claude", status.orgId, status.email) : undefined);
      } catch { finish(); }
    });
  });
  cachedAccount = { value, until: now + 600_000 };
  return value;
}
function readUsageOnce(timeoutMs: number): Promise<ProviderUsage> {
  return new Promise((resolve, reject) => {
    const directory = mkdtempSync(join(tmpdir(), "ai-usage-report-"));
    const child = spawn(claudeCommand(), ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--no-session-persistence", "--max-turns", "1", "--verbose", "--output-format", "stream-json", "-p", "/usage"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    let settled = false; let buffer = ""; let result: ProviderUsage | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill();
      // Windows cannot delete a running process's current directory; retry once it exits.
      const cleanup = () => { try { rmSync(directory, { recursive: true, force: true }); } catch { /* OS temp cleanup remains safe. */ } };
      child.once("close", cleanup); if (child.exitCode !== null) cleanup();
      error ? reject(error) : resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Claude quota request timed out")), timeoutMs);
    child.once("error", () => finish(new Error("Claude runtime unavailable")));
    child.once("exit", code => {
      if (code !== 0 || !result) finish(new Error("Claude quota unavailable; check native sign-in and CLI version"));
      else finish();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString(); if (buffer.length > 2_000_000) return finish(new Error("Claude response too large"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.usage_report) result = fromClaudeReport(event);
        } catch { /* Unrelated native messages are neither persisted nor forwarded. */ }
      }
    });
  });
}
