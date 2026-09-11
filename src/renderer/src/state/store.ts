import { create } from 'zustand'
import type {
  AnchorAnswer,
  AnchorPair,
  GridSize,
  LayoutConfig,
  LeanIndex,
  MosaicProfile,
  RenderConfig,
  SolverSettings,
  TileAnswer,
  WordPair,
} from '../domain/types'
import { LEAN_CENTER, strengthFromLean } from '../domain/types'
import { ANCHOR_BY_ID, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import { DEFAULT_LAYOUT } from '../layout/polar'
import { QUIZ_LENGTH, ANCHOR_LENGTH, firstUnansweredIndex } from '../domain/quiz'

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
  /**
   * BESO by default.
   *
   * Both modes work, but they do different things to a tile seed and only one of them
   * does what the mosaic wants. The volume target is deliberately set BELOW the material
   * the answers deposit, so something has to be given up and the physics decides what --
   * that is where chipping comes from. BESO handles it: its evolutionary schedule removes
   * the globally least-useful elements from a nearly solid field, so the inter-tile
   * bridges are never thinned to nothing and every load keeps its path to an anchor.
   * Measured on the sample profile: zero islands and zero stranded loads across ninety
   * iterations, reaching the target by iteration 60.
   *
   * SIMP eats the thin bridges first, because by sensitivity they are the cheapest thing
   * in the domain, and then cannot rebuild them -- a stranded load contributes zero to
   * every sensitivity, so no gradient points back toward the bridge. It strands ten of
   * sixteen loads and freezes. It is still available and still correct within its floor;
   * see SolverConfig.volumeFloor.
   */
  mode: 'beso',
  volumeFraction: 'derived',
  penalty: 3,
  // Must stay at or below the minimum deposit sigma in element widths, or the filter
  // erases the seed structure before the optimizer can act on it and every profile
  // produces the same art.
  filterRadius: 2.2,
  iterations: 100,
  moveLimit: 0.2,
  erosionRate: 0.02,
  seed: 1,
})

export const DEFAULT_RENDER: RenderConfig = Object.freeze({
  solidLo: 0.25,
  solidHi: 0.6,
  theme: 'ink',
  showScaffolding: true,
  // Off by default: a first-time mosaic should be a picture, not a diagram.
  showAnchorLabels: false,
  showPoleLabels: false,
  // 0.45 rather than 0.35 because the edge accent is now gated on coverage, which
  // costs 10-30% of its strength in the visually dominant band. Saved profiles keep
  // whatever they stored and render marginally softer.
  /**
   * Off by default.
   *
   * The edge accent darkens along the density gradient, which was a nice inked quality
   * on smooth blobs. With discrete tiles every tile boundary IS a density gradient, so
   * it drew a frame around all of them and the mosaic read as a grid of bordered
   * swatches instead of areas of colour. Tile identity comes from hue and saturation;
   * it does not need an outline. Still a dial for anyone who wants the ink look on the
   * optimized structure.
   */
  edgeAccent: 0,
})

/**
 * Which screen the app is on. The quiz is the on-ramp: 21 library rows is a wall to
 * open onto, whereas one question at a time builds the same profile without the user
 * having to know the taxonomy first.
 */
export type AppMode = 'splash' | 'quiz' | 'studio'

interface State {
  // --- navigation ---
  mode: AppMode
  /**
   * Position across the WHOLE quiz run: `[0, QUIZ_LENGTH)` is a regular question
   * (`pairAt`), `[QUIZ_LENGTH, QUIZ_LENGTH + ANCHOR_LENGTH)` is an anchor
   * (`anchorAt(quizIndex - QUIZ_LENGTH)`). One linear index for both phases, so
   * Quiz.tsx's navigation (Back/Next/Finish) does not need to know which phase it is
   * in beyond choosing which screen to render.
   */
  quizIndex: number

  // --- document ---
  title: string
  answers: TileAnswer[]
  anchorAnswers: AnchorAnswer[]
  /** Custom pairs only; library pairs resolve through LIBRARY_BY_ID. */
  customPairs: WordPair[]
  layout: LayoutConfig
  solver: SolverSettings
  render: RenderConfig
  dirty: boolean

  // --- transient UI ---
  search: string
  expandedFacets: Set<string>
  hoveredAnswerId: string | null
  running: boolean

  // --- actions ---
  pairById: (id: string) => WordPair | undefined
  allPairs: () => Map<string, WordPair>
  anchorById: (id: string) => AnchorPair | undefined
  allAnchors: () => Map<string, AnchorPair>
  addAnswer: (pairId: string) => void
  removeAnswer: (answerId: string) => void
  setLean: (answerId: string, leanIndex: LeanIndex) => void
  setImmutabilityOverride: (answerId: string, v: number | undefined) => void
  addCustomPair: (p: Omit<WordPair, 'id' | 'source'>) => string
  clearProfile: () => void
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
  /** Record an answer for the pair at the current quiz position. Strength is derived. */
  answerQuiz: (pairId: string, leanIndex: LeanIndex) => void
  skipQuiz: (pairId: string) => void
  /** Record a choice for the anchor at the current quiz position. */
  answerAnchor: (anchorId: string, optionId: string) => void
  /** Removes any existing choice for this anchor -- anchors are optional. */
  skipAnchor: (anchorId: string) => void
}

/**
 * A worked example profile, deliberately mixed so the mosaic shows all three roles at
 * once: pinned rim anchors, a thick middle band of structural mass, and fluid hub loads.
 * Includes D-RAC-02 (the canonical magenta blend, on the Demographic/Associative seam),
 * G-URB-05 (the cyan exemplar on the Geographic/Associative seam) and A-FAM-03 (the
 * widest skew in the library). Every regular pair in the library gets an answer, so the
 * sample also doubles as a demonstration of the full 21-question instrument; strength
 * is derived from lean, not authored here.
 */
const SAMPLE: readonly [string, LeanIndex][] = [
  ['D-AGE-01', 5],
  ['D-AGE-05', 2],
  ['D-ETH-01', 1],
  ['D-ETH-03', 4],
  ['D-GEN-01', 2],
  // Dead centre (leanIndex 3) is Dormant now, which would make these two -- the
  // magenta and cyan exemplars named above -- deposit nothing and vanish from the
  // rendered sample. One notch off keeps each a visible, still-recognizable blend
  // (G-URB-05 has no skew, so its hue is identical at every lean; D-RAC-02 shifts only
  // slightly toward its poleA reading).
  ['D-RAC-02', 2],
  ['D-RAC-03', 6],
  ['G-CLI-01', 0],
  ['G-TMP-01', 5],
  ['G-CST-01', 0],
  ['G-URB-01', 6],
  ['G-URB-05', 4],
  ['G-REG-01', 1],
  ['G-REG-06', 4],
  ['A-FAM-01', 4],
  ['A-FAM-03', 1],
  ['A-EMP-02', 5],
  ['A-PRO-01', 1],
  ['A-POL-03', 2],
  ['A-AVO-02', 1],
  ['A-AVO-04', 5],
]

/** A few anchors, one per category, so the sample also shows the anchor mechanic. */
const SAMPLE_ANCHORS: readonly [string, string][] = [
  ['ANCH-D-01', 'male'],
  ['ANCH-G-01', 'never-left'],
  ['ANCH-A-01', 'raised'],
  ['ANCH-A-04', 'not-joined'],
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
  anchorAnswers: [],
  customPairs: [],
  layout: DEFAULT_LAYOUT,
  solver: DEFAULT_SOLVER,
  render: DEFAULT_RENDER,
  dirty: false,

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

  anchorById: (id) => ANCHOR_BY_ID.get(id),

  allAnchors: () => new Map<string, AnchorPair>(ANCHOR_BY_ID),

  /** One answer per pairId, enforced: you have one position on urban-versus-rural. */
  addAnswer: (pairId) =>
    set((s) => {
      if (s.answers.some((a) => a.pairId === pairId)) return s
      const answer: TileAnswer = {
        answerId: newId('ans'),
        pairId,
        leanIndex: LEAN_CENTER,
        strength: strengthFromLean(LEAN_CENTER),
        addedAt: Date.now(),
      }
      return { answers: [...s.answers, answer], dirty: true }
    }),

  removeAnswer: (answerId) =>
    set((s) => ({ answers: s.answers.filter((a) => a.answerId !== answerId), dirty: true })),

  setLean: (answerId, leanIndex) =>
    set((s) => ({
      answers: s.answers.map((a) =>
        a.answerId === answerId ? { ...a, leanIndex, strength: strengthFromLean(leanIndex) } : a,
      ),
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
    set({ answers: [], anchorAnswers: [], customPairs: [], dirty: true, hoveredAnswerId: null }),

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
    const referencedAnchors = new Set(s.anchorAnswers.map((a) => a.anchorId))
    const anchors: AnchorPair[] = []
    for (const id of [...referencedAnchors].sort()) {
      const a = s.anchorById(id)
      if (a) anchors.push(a)
    }
    const now = new Date().toISOString()
    return {
      schemaVersion: 2,
      kind: 'cultural-mosaic-profile',
      id: newId('mosaic'),
      title: s.title,
      createdAt: now,
      updatedAt: now,
      appVersion,
      pairs,
      answers: s.answers,
      anchors,
      anchorAnswers: s.anchorAnswers,
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
        answers: SAMPLE.map(([pairId, leanIndex], k) => ({
          answerId: `sample-${pairId}`,
          pairId,
          leanIndex,
          strength: strengthFromLean(leanIndex),
          addedAt: base + k,
        })),
        anchorAnswers: SAMPLE_ANCHORS.map(([anchorId, optionId], k) => ({
          answerId: `sample-${anchorId}`,
          anchorId,
          optionId,
          addedAt: base + k,
        })),
        // The sample is a canonical demo, not user data -- reset solver/layout to the
        // shipped defaults rather than leaving whatever a prior session's tinkering
        // left behind.
        layout: DEFAULT_LAYOUT,
        solver: DEFAULT_SOLVER,
        dirty: true,
        hoveredAnswerId: null,
        mode: 'studio' as AppMode,
      }
    }),

  setMode: (mode) => set({ mode }),

  startQuiz: (fresh) =>
    set((s) => {
      if (fresh) {
        return { mode: 'quiz' as AppMode, quizIndex: 0, answers: [], anchorAnswers: [], dirty: true }
      }
      const answered = new Set(s.answers.map((a) => a.pairId))
      const next = firstUnansweredIndex(answered)
      // A gap in the regular questions wins; once those are all answered, land at the
      // start of the anchor phase rather than trying to compute a "gap" there too --
      // an anchor that was deliberately skipped looks identical to one never visited,
      // so there is no honest notion of a resume point within the anchor phase.
      return { mode: 'quiz' as AppMode, quizIndex: next === -1 ? QUIZ_LENGTH : next }
    }),

  setQuizIndex: (i) =>
    set({ quizIndex: Math.max(0, Math.min(QUIZ_LENGTH + ANCHOR_LENGTH - 1, Math.round(i))) }),

  answerQuiz: (pairId, leanIndex) =>
    set((s) => {
      const strength = strengthFromLean(leanIndex)
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

  answerAnchor: (anchorId, optionId) =>
    set((s) => {
      const existing = s.anchorAnswers.find((a) => a.anchorId === anchorId)
      const anchorAnswers = existing
        ? s.anchorAnswers.map((a) => (a.anchorId === anchorId ? { ...a, optionId } : a))
        : [
            ...s.anchorAnswers,
            { answerId: newId('anc'), anchorId, optionId, addedAt: Date.now() },
          ]
      return { anchorAnswers, dirty: true }
    }),

  skipAnchor: (anchorId) =>
    set((s) => ({
      anchorAnswers: s.anchorAnswers.filter((a) => a.anchorId !== anchorId),
      dirty: true,
    })),

  loadProfile: (p) =>
    set({
      title: p.title,
      answers: p.answers,
      anchorAnswers: p.anchorAnswers,
      customPairs: p.pairs.filter((q) => q.source === 'custom'),
      // Mode, resolution and iteration count are no longer user choices -- the app
      // only ever runs BESO at 96 elements for 100 iterations, so a profile saved
      // under an older build (or with a stale draft) is normalized on load rather
      // than silently reviving a control that no longer exists in the UI. Volume
      // stays whatever the profile chose: it is still a live, per-profile setting,
      // and "reopening reproduces the same artwork" should keep meaning that for it.
      layout: { ...p.layout, gridSize: 96 },
      solver: { ...p.solver, mode: 'beso', iterations: 100 },
      render: p.render,
      dirty: false,
      hoveredAnswerId: null,
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

/** Anchors grouped the same way, for the same browser. Computed once. */
export const ANCHORS_BY_FACET = ((): Map<string, AnchorPair[]> => {
  const m = new Map<string, AnchorPair[]>()
  for (const a of ANCHOR_BY_ID.values()) {
    const key = String(a.facet)
    const list = m.get(key)
    if (list) list.push(a)
    else m.set(key, [a])
  }
  return m
})()
