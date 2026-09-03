import { dialog, app } from 'electron'
import type { BrowserWindow } from 'electron'
import { writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { SaveResult, OpenResult, DraftResult } from '../shared/ipc-contract'

/**
 * The ONLY module in the app that touches `fs`.
 *
 * Main receives a string (or bytes) to write, or returns a string it read. It never
 * receives a path from the renderer -- the user picks the path via the OS dialog and
 * main is the only party that ever knows it. That is a meaningfully stronger property
 * than validating renderer-supplied paths, because there is no path surface at all.
 */

const PROFILE_FILTERS = [{ name: 'Cultural Mosaic Profile', extensions: ['json'] }]
const PNG_FILTERS = [{ name: 'PNG Image', extensions: ['png'] }]

function defaultDir(): string {
  return app.getPath('documents')
}

export async function saveProfile(
  win: BrowserWindow,
  json: string,
  suggestedName: string,
): Promise<SaveResult> {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Save Mosaic Profile',
    defaultPath: join(defaultDir(), suggestedName),
    filters: PROFILE_FILTERS,
  })
  if (canceled || !filePath) return { canceled: true }
  try {
    await writeFile(filePath, json, 'utf8')
    return { canceled: false, filePath }
  } catch (err) {
    return { canceled: false, error: (err as Error).message }
  }
}

export async function openProfile(win: BrowserWindow): Promise<OpenResult> {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'Open Mosaic Profile',
    defaultPath: defaultDir(),
    filters: PROFILE_FILTERS,
    properties: ['openFile'],
  })
  const chosen = filePaths[0]
  if (canceled || !chosen) return { canceled: true }
  try {
    const contents = await readFile(chosen, 'utf8')
    return { canceled: false, filePath: chosen, contents }
  } catch (err) {
    return { canceled: false, error: (err as Error).message }
  }
}

/**
 * The autosaved draft, in the app's own userData directory.
 *
 * The path is chosen HERE and never accepted from the renderer, so this stays consistent
 * with the rest of the fs surface: main decides where things live.
 */
function draftPath(): string {
  return join(app.getPath('userData'), 'draft.mosaic.json')
}

export async function readDraft(): Promise<DraftResult> {
  try {
    return { contents: await readFile(draftPath(), 'utf8') }
  } catch (err) {
    // A missing draft is the normal first-run case, not an error worth surfacing.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return { error: (err as Error).message }
  }
}

export async function writeDraft(json: string | null): Promise<DraftResult> {
  try {
    if (json === null) {
      await rm(draftPath(), { force: true })
      return {}
    }
    await writeFile(draftPath(), json, 'utf8')
    return {}
  } catch (err) {
    return { error: (err as Error).message }
  }
}

export async function exportPng(
  win: BrowserWindow,
  bytes: Uint8Array,
  suggestedName: string,
): Promise<SaveResult> {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export Artwork',
    defaultPath: join(defaultDir(), suggestedName),
    filters: PNG_FILTERS,
  })
  if (canceled || !filePath) return { canceled: true }
  try {
    await writeFile(filePath, bytes)
    return { canceled: false, filePath }
  } catch (err) {
    return { canceled: false, error: (err as Error).message }
  }
}
