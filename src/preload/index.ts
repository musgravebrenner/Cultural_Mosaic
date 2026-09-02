import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-contract'
import type { MosaicBridge } from '../shared/ipc-contract'

/**
 * Four *named* functions, never a generic invoke(channel, ...args). A generic
 * passthrough re-exposes every handler main will ever register to anything that
 * reaches `window`, and destroys the type safety that is the point of doing this
 * in TypeScript.
 */
const bridge: MosaicBridge = {
  saveProfile: (json, suggestedName) => ipcRenderer.invoke(IPC.saveProfile, json, suggestedName),
  openProfile: () => ipcRenderer.invoke(IPC.openProfile),
  exportPng: (bytes, suggestedName) => ipcRenderer.invoke(IPC.exportPng, bytes, suggestedName),
  getAppVersion: () => ipcRenderer.invoke(IPC.getAppVersion),
}

contextBridge.exposeInMainWorld('mosaic', bridge)
