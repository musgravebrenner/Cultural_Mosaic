/**
 * The complete IPC surface. Four channels, all request/response (`invoke`/`handle`).
 * There is deliberately no main -> renderer push channel: no subscription API on the
 * bridge means no listener-leak surface and no removeListener hygiene to get wrong.
 *
 * The solver runs in a renderer Web Worker, so NO solver data crosses IPC at all.
 * The only capability the renderer lacks is filesystem access, so the only things
 * that cross are file dialogs.
 */
export const IPC = {
  saveProfile: 'profile:save',
  openProfile: 'profile:open',
  exportPng: 'artwork:export-png',
  getAppVersion: 'app:version',
} as const

export interface SaveResult {
  canceled: boolean
  filePath?: string
  error?: string
}

export interface OpenResult {
  canceled: boolean
  filePath?: string
  contents?: string
  error?: string
}

/** The shape exposed on `window.mosaic` by the preload script. */
export interface MosaicBridge {
  saveProfile(json: string, suggestedName: string): Promise<SaveResult>
  openProfile(): Promise<OpenResult>
  exportPng(bytes: Uint8Array, suggestedName: string): Promise<SaveResult>
  getAppVersion(): Promise<string>
}
