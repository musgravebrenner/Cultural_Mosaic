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
  draftGet: 'draft:get',
  draftSet: 'draft:set',
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

/**
 * The autosaved working draft, kept in the app's userData directory.
 *
 * A file rather than localStorage, and that is a correction rather than a preference:
 * the renderer is loaded from file://, which Chromium treats as an OPAQUE origin for
 * storage. Writes succeed and reads succeed within a single session, so localStorage
 * looks like it works -- but nothing survives a restart, which is the only thing a
 * draft is for. Verified by probe: a key written in one launch was absent in the next.
 *
 * Main owns the path (userData/draft.mosaic.json) and the renderer never supplies one,
 * so this adds no path surface.
 */
export interface DraftResult {
  contents?: string
  error?: string
}

/** The shape exposed on `window.mosaic` by the preload script. */
export interface MosaicBridge {
  saveProfile(json: string, suggestedName: string): Promise<SaveResult>
  openProfile(): Promise<OpenResult>
  exportPng(bytes: Uint8Array, suggestedName: string): Promise<SaveResult>
  getAppVersion(): Promise<string>
  draftGet(): Promise<DraftResult>
  /** Pass null to clear the draft. */
  draftSet(json: string | null): Promise<DraftResult>
}
