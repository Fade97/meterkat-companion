import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

// Starting the app hidden in the tray at sign-in. Windows uses Electron's login items (HKCU Run);
// Linux an XDG autostart entry. Separate from the CLI autostart (systemd unit / Run value), which runs `meterkat run`.
export const LOGIN_ITEM_NAME = "Meterkat";
export const HIDDEN_ARG = "--hidden";
export const DESKTOP_FILE = "meterkat-desktop.desktop";
const MARKER = "# Managed by the Meterkat app.";

/** What runs at sign-in: the AppImage itself (not its temporary mount), or Electron with the app folder in development. */
export function launchCommand(env: NodeJS.ProcessEnv, execPath: string, packaged: boolean, appPath: string): string[] {
  if (env.APPIMAGE) return [env.APPIMAGE, HIDDEN_ARG];
  return packaged ? [execPath, HIDDEN_ARG] : [execPath, appPath, HIDDEN_ARG];
}

export function autostartFile(env: NodeJS.ProcessEnv, home: string) {
  const config = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(home, ".config");
  return join(config, "autostart", DESKTOP_FILE);
}

/** Desktop Entry Exec quoting: every argument double-quoted, with `"`, `` ` ``, `$` and `\` escaped and `%` doubled. */
export function execLine(command: string[]) {
  return command.map(part => {
    if (/[\u0000-\u001f\u007f]/.test(part)) throw new Error("Launch path contains control characters");
    return `"${part.replace(/[\\"`$]/g, c => `\\${c}`).replace(/%/g, "%%")}"`;
  }).join(" ");
}

export function desktopEntry(command: string[]) {
  return [
    "[Desktop Entry]", MARKER, "Type=Application", "Name=Meterkat", "Comment=Sends your AI quota to the Meterkat app on your phone",
    `Exec=${execLine(command)}`, "Terminal=false", "X-GNOME-Autostart-enabled=true", "",
  ].join("\n");
}

export function linuxAutostart(file: string) {
  return {
    enabled: () => { try { return readFileSync(file, "utf8").includes(MARKER); } catch { return false; } },
    set(enabled: boolean, command: string[]) {
      if (!enabled) { if (existsSync(file) && readFileSync(file, "utf8").includes(MARKER)) rmSync(file); return; }
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, desktopEntry(command), { mode: 0o644 }); renameSync(temporary, file);
    },
  };
}
