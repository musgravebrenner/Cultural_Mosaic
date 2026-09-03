import { useStore } from './store'
import { parseProfile } from '../domain/validate'

/**
 * An autosaved working draft, so Resume survives closing the app.
 *
 * Backed by a FILE in the app's userData directory, not localStorage. That is a
 * correction, not a preference: the renderer is loaded from `file://`, which Chromium
 * treats as an opaque origin for storage. Writes and reads both succeed within a single
 * session, so localStorage looks like it works — but nothing survives a restart, which
 * is the only thing a draft is for. Verified by probe: a key written in one launch was
 * absent from the next.
 *
 * The draft is a per-machine convenience for one in-progress quiz, not the user's
 * artwork. `Save` writes the real document, and that is the only thing the app treats as
 * durable.
 *
 * It is validated through the same `parseProfile` as a file on disk. A draft written by
 * an older build is exactly the case the migration chain exists for, and trusting it
 * just because the app wrote it is how you end up with a corrupt store that cannot be
 * cleared from inside the UI.
 */

const SAVE_DEBOUNCE_MS = 400

export interface DraftSummary {
  readonly answered: number
  readonly title: string
  readonly savedAt: string
}

async function readParsed(): Promise<ReturnType<typeof parseProfile> | null> {
  try {
    const res = await window.mosaic.draftGet()
    if (res.error || !res.contents) return null
    return parseProfile(JSON.parse(res.contents))
  } catch {
    return null
  }
}

export async function readDraftSummary(): Promise<DraftSummary | null> {
  const parsed = await readParsed()
  if (!parsed || !parsed.ok) return null
  return {
    answered: parsed.profile.answers.length,
    title: parsed.profile.title,
    savedAt: parsed.profile.updatedAt,
  }
}

/** Load the draft into the store. Resolves false if there was nothing usable. */
export async function loadDraft(): Promise<boolean> {
  const parsed = await readParsed()
  if (!parsed || !parsed.ok || parsed.profile.answers.length === 0) return false
  // loadProfile switches to the studio; the caller decides where to go next.
  useStore.getState().loadProfile(parsed.profile)
  return true
}

export async function clearDraft(): Promise<void> {
  try {
    await window.mosaic.draftSet(null)
  } catch {
    /* the draft is a convenience, not state the app depends on */
  }
}

let timer: number | undefined

function write(): void {
  void (async () => {
    try {
      const s = useStore.getState()
      await window.mosaic.draftSet(
        s.answers.length === 0 ? null : JSON.stringify(s.toProfile('draft')),
      )
    } catch {
      /* a failed autosave must never take the in-memory document with it */
    }
  })()
}

/**
 * Subscribe to document changes and autosave, debounced.
 *
 * Debounced because dragging a slider fires a store update per notch, and serializing
 * the whole profile plus an IPC round-trip on each one would put real work on the input
 * path. Returns an unsubscribe function.
 */
export function startDraftAutosave(): () => void {
  const unsub = useStore.subscribe((s, prev) => {
    if (s.answers === prev.answers && s.customPairs === prev.customPairs && s.title === prev.title) {
      return
    }
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(write, SAVE_DEBOUNCE_MS)
  })
  return () => {
    if (timer !== undefined) window.clearTimeout(timer)
    unsub()
  }
}

/** Flush any pending autosave immediately. Used before the window closes. */
export function flushDraft(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
  write()
}
