import { LIBRARY } from './library'
import { CATEGORIES, FACETS_BY_CATEGORY } from './taxonomy'
import type { WordPair } from './types'

/**
 * The order the quiz walks the library in.
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
 *    D-ETH-01, D-GEN-01 and D-RAC-01 ask how much heritage, gender and race organize
 *    your self-concept. They are the model's strongest rim anchors (immutability 0.80 to
 *    0.90) and they are the non-essentialist way to get those anchors -- but they are
 *    also the most personal questions in the set, and asking a stranger to rate how much
 *    their race matters as question three of seventy-nine reads as a test rather than a
 *    portrait. Placed at the end, after sixty-odd questions about climate, craft and
 *    family, they arrive in a context that has already established what the instrument
 *    is doing. Every one of them is skippable.
 *
 *    This costs nothing structurally: placement depends on the answers, never on the
 *    order they were given in.
 */
export const CENTRALITY_LAST: readonly string[] = ['D-ETH-01', 'D-GEN-01', 'D-RAC-01']

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

/** True for the deferred, explicitly-skippable centrality questions. */
export function isCentralityQuestion(pairId: string): boolean {
  return CENTRALITY_LAST.includes(pairId)
}

/**
 * Per-facet copy shown above the question.
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

/** The next unanswered question, or -1 when every one has been visited. */
export function firstUnansweredIndex(answeredPairIds: ReadonlySet<string>): number {
  for (let i = 0; i < QUIZ_ORDER.length; i++) {
    if (!answeredPairIds.has(QUIZ_ORDER[i]!)) return i
  }
  return -1
}

export function pairAt(index: number): WordPair | undefined {
  const id = QUIZ_ORDER[index]
  if (id === undefined) return undefined
  return LIBRARY.find((p) => p.id === id)
}
