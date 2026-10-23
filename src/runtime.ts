/**
 * Environment for a provider child. A `.js` entry point runs with process.execPath, which inside the desktop app
 * is Electron: it only behaves like Node with ELECTRON_RUN_AS_NODE, set for that child alone.
 */
export function childEnv(bin: { command: string }, env: NodeJS.ProcessEnv = process.env, electron = !!process.versions.electron): NodeJS.ProcessEnv {
  return electron && bin.command === process.execPath ? { ...env, ELECTRON_RUN_AS_NODE: "1" } : env;
}
