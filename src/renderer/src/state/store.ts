import { create } from 'zustand'
import type {
  GridSize,
  LayoutConfig,
  LeanIndex,
  MosaicProfile,
  RenderConfig,
  SolverSettings,
  StrengthLevel,
  TileAnswer,
  WordPair,
} from '../domain/types'
import { LEAN_CENTER } from '../domain/types'
import { LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import { DEFAULT_LAYOUT } from '../layout/polar'
import { QUIZ_LENGTH, firstUnansweredIndex } from '../domain/quiz'

/**
 * Zustand, and the deciding feature is the one people rarely cite: its vanilla API
 * works OUTSIDE React. `useStore.getState()` from inside the rAF loop and
 * `useStore.subscribe(...)` from the solver client are first-class, non-hacky paths --
 * and the renderer and solver client are not components and must not be.
 *
 * A single context holding the profile would re-render every consumer on every slider
 * tick; fixing that means splitting contexts and hand-placing memo, i.e. reimplementing
 * this worse. Redux Toolkit is ceremony for six pieces of state.
 *
 * This store holds the DOCUMENT. Solver frames are stored nowhere near it -- see
 * SolverSession.latestFrame.
 */

export const DEFAULT_SOLVER: SolverSettings = Object.freeze({
  mode: 'simp',
  volumeFraction: 'derived',
  penalty: 3,
  // Must stay at or below the minimum deposit sigma in element widths, or the filter
  // erases the seed structure before the optimizer can act on it and every profile
  // produces the same art.
  filterRadius: 2.2,
  iterations: 120,
  moveLimit: 0.2,
  erosionRate: 0.02,
  seed: 1,
})

export const DEFAULT_RENDER: RenderConfig = Object.freeze({
  upscale: 'mosaic',
  solidLo: 0.25,
  solidHi: 0.6,
  theme: 'ink',
  showScaffolding: true,
  // 0.45 rather than 0.35 because the edge accent is now gated on coverage, which
  // costs 10-30% of its strength in the visually dominant band. Saved profiles keep
  // whatever they stored and render marginally softer.
  edgeAccent: 0.45,
  showGhost: false,
})

export type PanelTab = 'library' | 'profile'

/**
 * Which screen the app is on. The quiz is the on-ramp: 79 library rows is a wall to
 * open onto, whereas one question at a time builds the same profile without the user
 * having to know the taxonomy first.
 */
export type AppMode = 'splash' | 'quiz' | 'studio'

interface State {
  // --- navigation ---
  mode: AppMode
  /** Position in QUIZ_ORDER. */
  quizIndex: number

  // --- document ---
  title: string
  answers: TileAnswer[]
  /** Custom pairs only; library pairs resolve through LIBRARY_BY_ID. */
  customPairs: WordPair[]
  layout: LayoutConfig
  solver: SolverSettings
  render: RenderConfig
  dirty: boolean

  // --- transient UI ---
  tab: PanelTab
  search: string
  expandedFacets: Set<string>
  hoveredAnswerId: string | null
  running: boolean

  // --- actions ---
  pairById: (id: string) => WordPair | undefined
  allPairs: () => Map<string, WordPair>
  addAnswer: (pairId: string) => void
  removeAnswer: (answerId: string) => void
  setLean: (answerId: string, leanIndex: LeanIndex) => void
  setStrength: (answerId: string, strength: StrengthLevel) => void
  setImmutabilityOverride: (answerId: string, v: number | undefined) => void
  addCustomPair: (p: Omit<WordPair, 'id' | 'source'>) => string
  clearProfile: () => void
  setTab: (t: PanelTab) => void
  setSearch: (s: string) => void
  toggleFacet: (f: string) => void
  setHovered: (id: string | null) => void
  setRender: (patch: Partial<RenderConfig>) => void
  setSolver: (patch: Partial<SolverSettings>) => void
  setGridSize: (n: GridSize) => void
  setInvertAnchors: (v: boolean) => void
  setRunning: (v: boolean) => void
  toProfile: (appVersion: string) => MosaicProfile
  loadProfile: (p: MosaicProfile) => void
  loadSample: () => void

  // --- navigation / quiz ---
  setMode: (m: AppMode) => void
  startQuiz: (fresh: boolean) => void
  setQuizIndex: (i: number) => void
  /** Record an answer for the pair at the current quiz position. */
  answerQuiz: (pairId: string, leanIndex: LeanIndex, strength: StrengthLevel) => void
  skipQuiz: (pairId: string) => void
}

/**
 * A worked example profile, deliberately mixed so the mosaic shows all three roles at
 * once: pinned rim anchors, a thick middle band of structural mass, and fluid hub loads.
 * Includes D-RAC-02 (the canonical magenta blend, on the Demographic/Associative seam),
 * G-URB-05 (the cyan exemplar on the Geographic/Associative seam) and A-FAM-03 (the
 * widest skew in the library).
 */
const SAMPLE: readonly [string, LeanIndex, StrengthLevel][] = [
  ['D-AGE-01', 5, 3],
  ['D-ETH-01', 1, 3],
  ['D-GEN-01', 2, 2],
  ['D-RAC-02', 3, 3],
  ['G-CLI-01', 0, 3],
  ['G-CST-01', 0, 3],
  ['G-REG-01', 1, 3],
  ['G-URB-01', 6, 2],
  ['G-URB-05', 3, 2],
  ['A-FAM-03', 1, 3],
  ['A-REL-01', 4, 2],
  ['A-PRO-01', 1, 3],
  ['A-POL-03', 2, 1],
  ['A-AVO-01', 0, 2],
  ['A-AVO-02', 1, 2],
  ['A-AVO-04', 5, 1],
]

let idCounter = 0
function newId(prefix: string): string {
  // crypto.randomUUID is available in the Electron renderer (a secure context), but
  // fall back so the store stays usable under a plain test runner.
  const rnd =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${(idCounter++).toString(36)}`
  return `${prefix}.${rnd}`
}

export const useStore = create<State>((set, get) => ({
  mode: 'splash',
  quizIndex: 0,
  title: 'Untitled mosaic',
  answers: [],
  customPairs: [],
  layout: DEFAULT_LAYOUT,
  solver: DEFAULT_SOLVER,
  render: DEFAULT_RENDER,
  dirty: false,

  tab: 'library',
  search: '',
  expandedFacets: new Set(['age']),
  hoveredAnswerId: null,
  running: false,

  pairById: (id) => LIBRARY_BY_ID.get(id) ?? get().customPairs.find((p) => p.id === id),

  allPairs: () => {
    const m = new Map<string, WordPair>(LIBRARY_BY_ID)
    for (const p of get().customPairs) m.set(p.id, p)
    return m
  },

  /** One answer per pairId, enforced: you have one position on urban-versus-rural. */
  addAnswer: (pairId) =>
    set((s) => {
      if (s.answers.some((a) => a.pairId === pairId)) return s
      const answer: TileAnswer = {
        answerId: newId('ans'),
        pairId,
        leanIndex: LEAN_CENTER,
        strength: 2,
        addedAt: Date.now(),
      }
      return { answers: [...s.answers, answer], dirty: true, tab: 'profile' }
    }),

  removeAnswer: (answerId) =>
    set((s) => ({ answers: s.answers.filter((a) => a.answerId !== answerId), dirty: true })),

  setLean: (answerId, leanIndex) =>
    set((s) => ({
      answers: s.answers.map((a) => (a.answerId === answerId ? { ...a, leanIndex } : a)),
      dirty: true,
    })),

  setStrength: (answerId, strength) =>
    set((s) => ({
      answers: s.answers.map((a) => (a.answerId === answerId ? { ...a, strength } : a)),
      dirty: true,
    })),

  setImmutabilityOverride: (answerId, v) =>
    set((s) => ({
      answers: s.answers.map((a) => {
        if (a.answerId !== answerId) return a
        // exactOptionalPropertyTypes: omit the key rather than storing undefined.
        if (v === undefined) {
          const { immutabilityOverride: _drop, ...rest } = a
          return rest
        }
        return { ...a, immutabilityOverride: Math.min(1, Math.max(0, v)) }
      }),
      dirty: true,
    })),

  addCustomPair: (p) => {
    const id = newId('custom')
    const pair: WordPair = { ...p, id, source: 'custom' }
    set((s) => ({ customPairs: [...s.customPairs, pair], dirty: true }))
    get().addAnswer(id)
    return id
  },

  clearProfile: () =>
    set({ answers: [], customPairs: [], dirty: true, hoveredAnswerId: null }),

  setTab: (tab) => set({ tab }),
  setSearch: (search) => set({ search }),
  toggleFacet: (f) =>
    set((s) => {
      const next = new Set(s.expandedFacets)
      if (next.has(f)) next.delete(f)
      else next.add(f)
      return { expandedFacets: next }
    }),
  setHovered: (hoveredAnswerId) => set({ hoveredAnswerId }),
  setRender: (patch) => set((s) => ({ render: { ...s.render, ...patch } })),
  setSolver: (patch) => set((s) => ({ solver: { ...s.solver, ...patch }, dirty: true })),
  setGridSize: (gridSize) => set((s) => ({ layout: { ...s.layout, gridSize }, dirty: true })),
  setInvertAnchors: (invertAnchors) =>
    set((s) => ({ layout: { ...s.layout, invertAnchors }, dirty: true })),
  setRunning: (running) => set({ running }),

  toProfile: (appVersion) => {
    const s = get()
    // Snapshot EVERY referenced pair, library ones included. Referencing library pairs
    // by id alone would mean that tuning a preset in a later version silently changes
    // every previously-saved artwork.
    const referenced = new Set(s.answers.map((a) => a.pairId))
    const pairs: WordPair[] = []
    for (const id of [...referenced].sort()) {
      const p = s.pairById(id)
      if (p) pairs.push(p)
    }
    const now = new Date().toISOString()
    return {
      schemaVersion: 1,
      kind: 'cultural-mosaic-profile',
      id: newId('mosaic'),
      title: s.title,
      createdAt: now,
      updatedAt: now,
      appVersion,
      pairs,
      answers: s.answers,
      layout: s.layout,
      solver: s.solver,
      render: s.render,
    }
  },

  loadSample: () =>
    set(() => {
      const base = Date.now()
      return {
        title: 'Sample mosaic',
        customPairs: [],
        answers: SAMPLE.map(([pairId, leanIndex, strength], k) => ({
          answerId: `sample-${pairId}`,
          pairId,
          leanIndex,
          strength,
          addedAt: base + k,
        })),
        dirty: true,
        tab: 'profile' as PanelTab,
        hoveredAnswerId: null,
        mode: 'studio' as AppMode,
      }
    }),

  setMode: (mode) => set({ mode }),

  startQuiz: (fresh) =>
    set((s) => {
      if (fresh) {
        return { mode: 'quiz' as AppMode, quizIndex: 0, answers: [], dirty: true }
      }
      const answered = new Set(s.answers.map((a) => a.pairId))
      const next = firstUnansweredIndex(answered)
      // Every question visited: land on the last one rather than out of bounds, so
      // Resume on a finished quiz is a review rather than a dead end.
      return { mode: 'quiz' as AppMode, quizIndex: next === -1 ? QUIZ_LENGTH - 1 : next }
    }),

  setQuizIndex: (i) =>
    set({ quizIndex: Math.max(0, Math.min(QUIZ_LENGTH - 1, Math.round(i))) }),

  answerQuiz: (pairId, leanIndex, strength) =>
    set((s) => {
      const existing = s.answers.find((a) => a.pairId === pairId)
      const answers = existing
        ? s.answers.map((a) => (a.pairId === pairId ? { ...a, leanIndex, strength } : a))
        : [
            ...s.answers,
            {
              answerId: newId('ans'),
              pairId,
              leanIndex,
              strength,
              addedAt: Date.now(),
            },
          ]
      return { answers, dirty: true }
    }),

  /**
   * Skipping REMOVES any prior answer rather than storing a sentinel. An unanswered
   * pair is simply absent from `answers`, which is distinct from Dormant -- Dormant is
   * a kept state meaning "this is not part of me", and it stays in the document so it
   * can be toggled back.
   */
  skipQuiz: (pairId) =>
    set((s) => ({ answers: s.answers.filter((a) => a.pairId !== pairId), dirty: true })),

  loadProfile: (p) =>
    set({
      title: p.title,
      answers: p.answers,
      customPairs: p.pairs.filter((q) => q.source === 'custom'),
      layout: p.layout,
      solver: p.solver,
      render: p.render,
      dirty: false,
      hoveredAnswerId: null,
      tab: 'profile',
      mode: 'studio',
    }),
}))

/** Library grouped for the two-level Table 1 browser. Computed once. */
export const LIBRARY_BY_FACET = ((): Map<string, WordPair[]> => {
  const m = new Map<string, WordPair[]>()
  for (const p of LIBRARY) {
    const key = String(p.facet)
    const list = m.get(key)
    if (list) list.push(p)
    else m.set(key, [p])
  }
  return m
})()
