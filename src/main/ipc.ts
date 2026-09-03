import { ipcMain, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-contract'
import { saveProfile, openProfile, exportPng, readDraft, writeDraft } from './dialogs'

/** Registers exactly four handlers. Nothing else is reachable from the renderer. */
export function registerIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.saveProfile, async (_e, json: string, suggestedName: string) => {
    const win = getWindow()
    if (!win) return { canceled: true }
    return saveProfile(win, json, suggestedName)
  })

  ipcMain.handle(IPC.openProfile, async () => {
    const win = getWindow()
    if (!win) return { canceled: true }
    return openProfile(win)
  })

  ipcMain.handle(IPC.exportPng, async (_e, bytes: Uint8Array, suggestedName: string) => {
    const win = getWindow()
    if (!win) return { canceled: true }
    return exportPng(win, bytes, suggestedName)
  })

  ipcMain.handle(IPC.getAppVersion, () => app.getVersion())

  // No window needed: these touch only the app's own userData directory.
  ipcMain.handle(IPC.draftGet, () => readDraft())
  ipcMain.handle(IPC.draftSet, (_e, json: string | null) => writeDraft(json))
}
