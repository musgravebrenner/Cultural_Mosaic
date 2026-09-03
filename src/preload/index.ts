import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type { MosaicBridge } from '../shared/ipc-contract'

/**
 * Named functions, never a generic invoke(channel, ...args). A generic passthrough
 * re-exposes every handler main will ever register to anything that reaches `window`,
 * and destroys the type safety that is the point of doing this in TypeScript.
 *
 * Six channels: three file dialogs, the app version, and the two draft accessors. The
 * draft pair touches only the app's own userData directory on a path main chooses, so
 * it adds no path surface.
 */
const bridge: MosaicBridge = {
  saveProfile: (json, suggestedName) => ipcRenderer.invoke(IPC.saveProfile, json, suggestedName),
  openProfile: () => ipcRenderer.invoke(IPC.openProfile),
  exportPng: (bytes, suggestedName) => ipcRenderer.invoke(IPC.exportPng, bytes, suggestedName),
  getAppVersion: () => ipcRenderer.invoke(IPC.getAppVersion),
  draftGet: () => ipcRenderer.invoke(IPC.draftGet),
  draftSet: (json) => ipcRenderer.invoke(IPC.draftSet, json),
}

contextBridge.exposeInMainWorld('mosaic', bridge)
