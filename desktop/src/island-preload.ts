// Exposes only the island's update stream to its sandboxed page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ISLAND_CHANNEL, type IslandApi, type IslandUpdate } from "./ipc.js";

const api: IslandApi = {
  onUpdate(listener) {
    const wrapped = (_event: IpcRendererEvent, update: IslandUpdate) => listener(update);
    ipcRenderer.on(ISLAND_CHANNEL, wrapped);
    return () => { ipcRenderer.off(ISLAND_CHANNEL, wrapped); };
  },
};
contextBridge.exposeInMainWorld("meterkatIsland", api);
