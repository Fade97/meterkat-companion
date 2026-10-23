import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromClaudeReport, type ProviderUsage } from "../shared/snapshot.js";

/** Execute only the native local /usage command, never an inference prompt. Native CLI owns auth. */
export function readClaudeUsage(timeoutMs = 25_000): Promise<ProviderUsage> {
  return new Promise((resolve, reject) => {
    const directory = mkdtempSync(join(tmpdir(), "ai-usage-report-"));
    const command = process.env.AI_USAGE_CLAUDE_BIN ?? (process.platform === "win32" ? "claude.exe" : "claude");
    const child = spawn(command, ["--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", "", "--no-session-persistence", "--max-turns", "1", "--verbose", "--output-format", "stream-json", "-p", "/usage"], { cwd: directory, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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
