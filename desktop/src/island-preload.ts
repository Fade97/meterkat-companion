// Exposes only the island's update stream, its position and clicks to its sandboxed page.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { ISLAND_CHANNEL, ISLAND_HIT_CHANNEL, ISLAND_TOGGLE_CHANNEL, type IslandApi, type IslandUpdate } from "./ipc.js";

const api: IslandApi = {
  onUpdate(listener) {
    const wrapped = (_event: IpcRendererEvent, update: IslandUpdate) => listener(update);
    ipcRenderer.on(ISLAND_CHANNEL, wrapped);
    return () => { ipcRenderer.off(ISLAND_CHANNEL, wrapped); };
  },
  hitArea: area => ipcRenderer.send(ISLAND_HIT_CHANNEL, area),
  toggle: () => ipcRenderer.send(ISLAND_TOGGLE_CHANNEL),
};
contextBridge.exposeInMainWorld("meterkatIsland", api);
