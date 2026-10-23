import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fromCodexLimits, type ProviderUsage } from "../shared/snapshot.js";
import { childEnv } from "./runtime.js";

export function codexCommand(): { command: string; args: string[] } {
  const configured = process.env.AI_USAGE_CODEX_BIN;
  if (configured) return configured.endsWith(".js") ? { command: process.execPath, args: [configured] } : { command: configured, args: [] };
  if (process.platform === "win32") {
    for (const directory of (process.env.PATH ?? "").split(delimiter)) {
      if (existsSync(join(directory, "codex.exe"))) return { command: join(directory, "codex.exe"), args: [] };
      const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(script)) return { command: process.execPath, args: [script] };
    }
    throw new Error("Codex not found; set AI_USAGE_CODEX_BIN to its native executable or codex.js");
  }
  return { command: "codex", args: [] };
}

/** Native runtime owns sign-in. No inference, auth-file reads or token refresh implementation here. */
export function readCodexUsage(timeoutMs = 20_000): Promise<ProviderUsage> {
  return new Promise((resolve, reject) => {
    const bin = codexCommand();
    const child = spawn(bin.command, [...bin.args, "app-server", "--listen", "stdio://"], { env: childEnv(bin), stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let settled = false; let buffer = "";
    const finish = (error?: Error, result?: ProviderUsage) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      error ? reject(error) : resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("Codex quota request timed out")), timeoutMs);
    const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
    child.once("error", () => finish(new Error("Codex runtime unavailable")));
    child.stdin.on("error", () => finish(new Error("Codex runtime disconnected")));
    child.once("exit", () => finish(new Error("Codex runtime exited before quota response")));
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString(); if (buffer.length > 2_000_000) return finish(new Error("Codex response too large"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            if (message.error) return finish(new Error("Codex initialization failed"));
            send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read" });
          }
          if (message.id === 2) {
            if (message.error) return finish(new Error("Codex quota unavailable; check native sign-in"));
            return finish(undefined, fromCodexLimits(message.result));
          }
        } catch { /* Non-protocol startup output is ignored; never forwarded. */ }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ai_usage_quota_reader", title: "AI usage", version: "0.1.0" } } });
  });
}
