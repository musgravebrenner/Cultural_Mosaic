import { useStore } from './store'
import { parseProfile } from '../domain/validate'

/**
 * An autosaved working draft, so Resume survives closing the app.
 *
 * Deliberately localStorage rather than a file. This is a per-machine convenience for
 * one in-progress quiz, not the user's artwork -- Save writes the real document, and
 * that is the only thing the app treats as durable. Every access is wrapped, because
 * localStorage genuinely throws in some contexts (cleared site data, a browser set to
 * block storage) and a failed autosave must never take the app down with it.
 *
 * The draft is validated through the same parseProfile as a file on disk. A draft
 * written by an older build is exactly the case the migration chain exists for, and
 * trusting it just because the app wrote it is how you end up with a corrupt store that
 * cannot be cleared from inside the UI.
 */

const KEY = 'cultural-mosaic:draft:v1'
const SAVE_DEBOUNCE_MS = 400

export interface DraftSummary {
  readonly answered: number
  readonly title: string
  readonly savedAt: string
}

export function readDraftSummary(): DraftSummary | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = parseProfile(JSON.parse(raw))
    if (!parsed.ok) return null
    return {
      answered: parsed.profile.answers.length,
      title: parsed.profile.title,
      savedAt: parsed.profile.updatedAt,
    }
  } catch {
    return null
  }
}

/** Load the draft into the store. Returns false if there was nothing usable. */
export function loadDraft(): boolean {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return false
    const parsed = parseProfile(JSON.parse(raw))
    if (!parsed.ok || parsed.profile.answers.length === 0) return false
    // loadProfile switches to the studio; the caller decides where to go next.
    useStore.getState().loadProfile(parsed.profile)
    return true
  } catch {
    return false
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* nothing to do: the draft is a convenience, not state we depend on */
  }
}

let timer: number | undefined

function write(): void {
  try {
    const s = useStore.getState()
    if (s.answers.length === 0) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify(s.toProfile('draft')))
  } catch {
    /* storage unavailable or full; the in-memory document is unaffected */
  }
}

/**
 * Subscribe to document changes and autosave, debounced.
 *
 * Debounced because dragging a slider fires a store update per notch, and serializing
 * the whole profile on each one would put a JSON round-trip on the input path. Returns
 * an unsubscribe function.
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

export const DRAFT_KEY = KEY
