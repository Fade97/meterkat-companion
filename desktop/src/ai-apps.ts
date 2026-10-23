// Decides whether the window in the foreground belongs to an AI tool: the Claude, Codex or T3 Code apps, a terminal
// running claude or codex, or a browser tab on Claude, ChatGPT or Codex. Pure, so it is unit-tested.

export type ForegroundWindow = {
  /** Executable (Windows) or WM_CLASS (Linux) of the window's process. */
  app: string;
  title: string;
  /** Executable names (and on Linux command lines) of the processes started inside it; only read for terminals. */
  descendants: string[];
  fullscreen: boolean;
};

const base = (app: string) => app.toLowerCase().replace(/\\/g, "/").split("/").pop()!.replace(/\.exe$/, "").trim();

const AI_APPS = [/^claude$/, /^codex$/, /^t3[ -]?code/, /^chatgpt$/];
const TERMINALS = new Set([
  "windowsterminal", "openconsole", "conhost", "cmd", "powershell", "pwsh", "wezterm-gui", "wezterm", "alacritty", "kitty",
  "ghostty", "warp", "hyper", "tabby", "mintty", "gnome-terminal-server", "gnome-terminal", "konsole", "xterm", "tilix",
  "terminator", "xfce4-terminal", "foot", "urxvt", "st", "ptyxis", "kgx", "code", "cursor", "windsurf",
]);
const BROWSERS = new Set(["chrome", "google-chrome", "msedge", "microsoft-edge", "firefox", "brave", "brave-browser", "vivaldi", "opera", "arc", "zen", "chromium", "librewolf", "floorp", "waterfox", "thorium"]);
// Tool processes inside a terminal: the native binaries, or Node running the npm packages.
const TOOL_PROCESS = /(^|[/\\\s])(claude|codex)(\.exe)?(\s|$)|@anthropic-ai[/\\]claude-code|@openai[/\\]codex/i;
const TOOL_TITLE = /\bclaude code\b|^✳|\bcodex\b/i;
// Browser titles: "<page> - <browser>" (Edge adds a profile: "<page> - Personal - Microsoft Edge"). Claude and
// Codex put their name last in the page title ("My chat - Claude"); ChatGPT only on its start page, not in chats.
const BROWSER_NAME = /^(google chrome|chrome|microsoft\u200b? ?edge|mozilla firefox|firefox|brave|vivaldi|opera|chromium|librewolf|floorp|waterfox|thorium|zen browser|arc)$/i;
const SITE = /^(claude|chatgpt|codex)$/i;

export function isAiWindow(window: ForegroundWindow): boolean {
  const app = base(window.app);
  if (AI_APPS.some(pattern => pattern.test(app))) return true;
  if (TERMINALS.has(app)) return window.descendants.some(name => TOOL_PROCESS.test(name)) || TOOL_TITLE.test(window.title);
  if (BROWSERS.has(app)) {
    const parts = window.title.split(/\s[-–—|·]\s/).map(part => part.trim());
    if (parts.length > 1 && BROWSER_NAME.test(parts.at(-1)!)) parts.pop();
    // The site name, or the site name followed by a browser profile.
    return parts.slice(-2).some(part => SITE.test(part));
  }
  return false;
}

/** Terminals are the only windows whose process tree is worth reading. */
export const isTerminal = (app: string) => TERMINALS.has(base(app));
