import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isSea } from "node:sea";
import { dirname, join } from "node:path";
import { fromCodexLimits, type ProviderUsage } from "../shared/snapshot.js";
import { accountFingerprint } from "./account.js";
import { childEnv } from "./runtime.js";
import { findExecutable } from "./setup.js";

// A packaged companion's execPath is the companion itself, which would treat codex.js as an unknown command and exit.
const nodeFor = (env: NodeJS.ProcessEnv, platform: NodeJS.Platform, packaged: boolean) => {
  const node = packaged ? findExecutable("node", env, platform) : process.execPath;
  if (!node) throw new Error("Codex needs Node.js on PATH; set AI_USAGE_CODEX_BIN to its native executable");
  return node;
};

// codex.js only starts the native binary its platform package ships, without hiding the console. Under a parent
// without a console (the Electron desktop app) Windows gives that binary a visible window on every sync, so the
// native binary is started directly, the way codex.js would find it: nested or hoisted package, then bundled vendor.
const WINDOWS_TRIPLE: Partial<Record<string, string>> = { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" };
export function nativeCodexBeside(script: string, arch: string = process.arch) {
  const triple = WINDOWS_TRIPLE[arch]; if (!triple) return undefined;
  const root = dirname(dirname(script)); const platformPackage = `codex-win32-${arch}`;
  return [join(root, "node_modules", "@openai", platformPackage), join(dirname(root), platformPackage), root]
    .map(base => join(base, "vendor", triple, "bin", "codex.exe")).find(file => existsSync(file));
}

export function codexCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, packaged = isSea(), arch: string = process.arch): { command: string; args: string[] } {
  const viaScript = (script: string) => {
    const native = platform === "win32" ? nativeCodexBeside(script, arch) : undefined;
    return native ? { command: native, args: [] } : { command: nodeFor(env, platform, packaged), args: [script] };
  };
  const configured = env.AI_USAGE_CODEX_BIN;
  if (configured) return configured.endsWith(".js") ? viaScript(configured) : { command: configured, args: [] };
  if (platform === "win32") {
    for (const directory of (env.PATH ?? env.Path ?? "").split(";")) {
      if (!directory) continue;
      if (existsSync(join(directory, "codex.exe"))) return { command: join(directory, "codex.exe"), args: [] };
      const script = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
      if (existsSync(script)) return viaScript(script);
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
    /** Quota already read; only the account fingerprint is still pending, and losing it never loses the quota. */
    let usage: ProviderUsage | undefined;
    const finish = (error?: Error, result?: ProviderUsage) => {
      if (settled) return; settled = true; clearTimeout(timer); child.stdin.end(); child.kill();
      if (!result && usage) resolve(usage); else error ? reject(error) : resolve(result!);
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
            usage = fromCodexLimits(message.result);
            if (usage.state !== "ok") return finish(undefined, usage);
            send({ id: 3, method: "account/read", params: {} });
          }
          if (message.id === 3) {
            // ChatGPT account (workspace) ID + e-mail: the subscription this quota belongs to (#68).
            const account = message.error ? undefined : accountFingerprint("codex", message.result?.workspaceRouting?.chatgptAccountId, message.result?.account?.email);
            return finish(undefined, account ? { ...usage!, account } : usage);
          }
        } catch { /* Non-protocol startup output is ignored; never forwarded. */ }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "ai_usage_quota_reader", title: "AI usage", version: "0.1.0" } } });
  });
}
