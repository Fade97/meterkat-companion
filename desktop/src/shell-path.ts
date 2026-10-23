import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute } from "node:path";

// A desktop session (autostart entry, app launcher) does not read ~/.profile or ~/.bashrc, so tools installed
// with npm, nvm or ~/.local/bin are missing from PATH. Ask the user's login shell once, like a terminal would.
const MARKER = "__METERKAT_PATH__";
type Run = (command: string, args: string[]) => { stdout: string | null; status: number | null };
const realRun: Run = (command, args) => spawnSync(command, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] });

export function loginShellPath(env: NodeJS.ProcessEnv = process.env, run: Run = realRun) {
  const shell = env.SHELL;
  if (!shell || !isAbsolute(shell)) return undefined;
  const result = run(shell, ["-ilc", `printf '${MARKER}%s${MARKER}' "$PATH"`]);
  const match = new RegExp(`${MARKER}(.*?)${MARKER}`, "s").exec(result.stdout ?? "");
  return match?.[1] || undefined;
}

/** `current` first, then directories only the login shell knows; relative entries are dropped. */
export function mergePath(current: string | undefined, extra: string | undefined) {
  const parts = [...(current ?? "").split(delimiter), ...(extra ?? "").split(delimiter)].filter(p => p && isAbsolute(p));
  return [...new Set(parts)].join(delimiter);
}
