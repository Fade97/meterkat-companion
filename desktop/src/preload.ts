// Exposes the narrow MeterkatApi to the sandboxed window; nothing else from Electron or Node reaches the page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CHANNEL, type AppState, type MeterkatApi, type View } from "./ipc.js";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);
function subscribe<T>(channel: string, listener: (value: T) => void) {
  const wrapped = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => { ipcRenderer.off(channel, wrapped); };
}

const api: MeterkatApi = {
  state: () => invoke(CHANNEL.state),
  onState: listener => subscribe<AppState>(CHANNEL.stateChanged, listener),
  onNavigate: listener => subscribe<View>(CHANNEL.navigate, listener),
  detectProviders: () => invoke(CHANNEL.detect),
  register: relay => invoke(CHANNEL.register, relay),
  syncNow: () => invoke(CHANNEL.sync),
  startPairing: () => invoke(CHANNEL.startPairing),
  stopPairing: () => invoke(CHANNEL.stopPairing),
  devices: () => invoke(CHANNEL.devices),
  revokeDevice: id => invoke(CHANNEL.revoke, id),
  revokeAll: () => invoke(CHANNEL.revokeAll),
  setAutostart: enabled => invoke(CHANNEL.autostart, enabled),
  setIsland: enabled => invoke(CHANNEL.island, enabled),
  setBarMode: mode => invoke(CHANNEL.barMode, mode),
  takeOver: () => invoke(CHANNEL.takeOver),
  checkUpdate: () => invoke(CHANNEL.checkUpdate),
  installUpdate: () => invoke(CHANNEL.installUpdate),
  setAutomaticUpdates: enabled => invoke(CHANNEL.automaticUpdates, enabled),
  open: link => invoke(CHANNEL.open, link),
  hide: () => void invoke(CHANNEL.hide),
  quit: () => void invoke(CHANNEL.quit),
};
contextBridge.exposeInMainWorld("meterkat", api);
