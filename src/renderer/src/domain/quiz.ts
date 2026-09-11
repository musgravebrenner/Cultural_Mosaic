import { ANCHOR_BY_ID, ANCHORS, LIBRARY } from './library'
import { CATEGORIES, FACETS_BY_CATEGORY } from './taxonomy'
import { strengthFromLean } from './types'
import type { AnchorPair, LeanIndex, StrengthLevel, WordPair } from './types'

/**
 * The order the quiz walks the 21 regular pairs in.
 *
 * Two rules, both deliberate.
 *
 * 1. Table 1 order: category by category, and within each, facet by facet. The quiz is
 *    the first thing a user sees, so walking the taxonomy in the paper's own order means
 *    the framework is legible from the questions themselves rather than needing to be
 *    explained.
 *
 * 2. The identity-CENTRALITY questions go LAST, not first.
 *
 *    D-ETH-01 and D-GEN-01 ask how much heritage and gender organize your self-concept.
 *    They are among the model's strongest rim anchors (immutability 0.85-0.90) and they
 *    are the non-essentialist way to get those anchors -- but they are also the most
 *    personal questions in the set, and asking a stranger to rate how much their
 *    heritage matters as question three reads as a test rather than a portrait. Placed
 *    at the end, after the rest of the (now much shorter) run, they arrive in a context
 *    that has already established what the instrument is doing.
 *
 *    This is a DEFERRED POSITION ONLY, not an exemption from answering. Every regular
 *    question, centrality included, is mandatory now -- see QUIZ_CHOICES below for why
 *    that is safe to require: the scale itself has a real "none of this" position
 *    (dead centre, Dormant), so "this doesn't organize me" has somewhere honest to go
 *    without needing a separate skip. Skipping is reserved for ANCHORS (see quiz.ts's
 *    anchor section below), which ask a fact that may genuinely not exist yet for a
 *    given person (no anchor's opposite is "I have no opinion").
 *
 *    This costs nothing structurally: placement depends on the answers, never on the
 *    order they were given in.
 */
export const CENTRALITY_LAST: readonly string[] = ['D-ETH-01', 'D-GEN-01']

/** Library ids in quiz order. */
export const QUIZ_ORDER: readonly string[] = ((): string[] => {
  const byId = new Map(LIBRARY.map((p) => [p.id, p]))
  const deferred: string[] = []
  const main: string[] = []

  for (const cat of CATEGORIES) {
    for (const facet of FACETS_BY_CATEGORY[cat]) {
      for (const p of LIBRARY) {
        if (p.facet !== facet) continue
        if (CENTRALITY_LAST.includes(p.id)) deferred.push(p.id)
        else main.push(p.id)
      }
    }
  }
  // Preserve the authored order of the deferred set rather than the order they happened
  // to be encountered in.
  const tail = CENTRALITY_LAST.filter((id) => byId.has(id))
  return [...main, ...tail.filter((id) => deferred.includes(id))]
})()

export const QUIZ_LENGTH = QUIZ_ORDER.length

/** True for the deferred, identity-centrality questions -- an ordering fact only. */
export function isCentralityQuestion(pairId: string): boolean {
  return CENTRALITY_LAST.includes(pairId)
}

export function pairAt(index: number): WordPair | undefined {
  const id = QUIZ_ORDER[index]
  if (id === undefined) return undefined
  return LIBRARY.find((p) => p.id === id)
}

/** The next unanswered regular question, or -1 when every one has been visited. */
export function firstUnansweredIndex(answeredPairIds: ReadonlySet<string>): number {
  for (let i = 0; i < QUIZ_ORDER.length; i++) {
    if (!answeredPairIds.has(QUIZ_ORDER[i]!)) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Anchors -- a distinct trailing phase, walked after every regular question.
// ---------------------------------------------------------------------------

/**
 * Anchor ids in a fixed, deliberate order: demographic, then geographic, then
 * associative -- the same Table 1 order the regular quiz uses, just for the smaller
 * fact-based set. `ANCHORS` in library.ts is already authored in this order.
 */
export const ANCHOR_ORDER: readonly string[] = ANCHORS.map((a) => a.id)
export const ANCHOR_LENGTH = ANCHOR_ORDER.length

export function anchorAt(index: number): AnchorPair | undefined {
  const id = ANCHOR_ORDER[index]
  if (id === undefined) return undefined
  return ANCHOR_BY_ID.get(id)
}

/** The next unanswered anchor, or -1 when every one has been visited or skipped. */
export function firstUnansweredAnchorIndex(answeredAnchorIds: ReadonlySet<string>): number {
  for (let i = 0; i < ANCHOR_ORDER.length; i++) {
    if (!answeredAnchorIds.has(ANCHOR_ORDER[i]!)) return i
  }
  return -1
}

/**
 * Per-facet copy shown above a REGULAR question. Anchors get a single fixed intro
 * instead (see Quiz.tsx) rather than reusing this map by facet -- several facets
 * (gender chief among them) carry a regular-question preamble that would directly
 * contradict the anchor asked under the same facet key: D-GEN-01's preamble stresses
 * "expectations, not gender itself," which is exactly what ANCH-D-01 (assigned sex at
 * birth) is NOT asking about.
 *
 * The Gender entry is not decoration: `D-GEN-02` ("Provide and protect" / "Nurture and
 * sustain") is kept in the library only on the condition that this framing is shown, so
 * that neither pole reads as assigned to a sex. See the risk note on that pair.
 */
export const FACET_PREAMBLE: Readonly<Partial<Record<string, string>>> = {
  gender:
    'Gendered expectations — not gender itself. Both poles are open to everyone; these ask what shaped you, not what you are.',
  race: 'How race has been experienced and oriented toward, not what race anyone is.',
  ethnicity: 'Heritage as a relationship, not a category.',
  politics: 'Value orientations only. No parties, no institutions.',
  religion: 'Value orientations only. No named traditions.',
}

/**
 * The quiz's answer scale: seven positions, where ONE click fully answers a question.
 *
 * The studio used to keep lean and strength as independent controls. It no longer
 * does: strength is DERIVED from how far the answer leans (see `strengthFromLean`),
 * which is the standard semantic-differential reading -- the extremes are where
 * conviction lives, and dead centre is where none does. `strength` below is computed
 * from `leanIndex` rather than hand-authored, so the two can never drift apart.
 */
export interface QuizChoice {
  readonly leanIndex: LeanIndex
  readonly strength: StrengthLevel
  /** Shown on the button. */
  readonly degree: string
  /** Which statement this favours: -1 the first, 0 both equally, +1 the second. */
  readonly side: -1 | 0 | 1
}

export const QUIZ_CHOICES: readonly QuizChoice[] = Object.freeze([
  { leanIndex: 0, strength: strengthFromLean(0), degree: 'Strongly', side: -1 },
  { leanIndex: 1, strength: strengthFromLean(1), degree: 'Mostly', side: -1 },
  { leanIndex: 2, strength: strengthFromLean(2), degree: 'Slightly', side: -1 },
  { leanIndex: 3, strength: strengthFromLean(3), degree: 'Both', side: 0 },
  { leanIndex: 4, strength: strengthFromLean(4), degree: 'Slightly', side: 1 },
  { leanIndex: 5, strength: strengthFromLean(5), degree: 'Mostly', side: 1 },
  { leanIndex: 6, strength: strengthFromLean(6), degree: 'Strongly', side: 1 },
] as const)

/** The position matching an existing answer, or -1 if it was not made on this scale. */
export function choiceIndexOf(leanIndex: LeanIndex, strength: StrengthLevel): number {
  return QUIZ_CHOICES.findIndex((c) => c.leanIndex === leanIndex && c.strength === strength)
}
