import { describe, it, expect } from 'vitest'
import {
  CENTRALITY_LAST,
  FACET_PREAMBLE,
  QUIZ_LENGTH,
  QUIZ_ORDER,
  firstUnansweredIndex,
  isCentralityQuestion,
  pairAt,
} from './quiz'
import { LIBRARY, LIBRARY_BY_ID } from './library'
import { CATEGORIES, FACETS_BY_CATEGORY } from './taxonomy'

describe('quiz coverage', () => {
  it('walks every library pair exactly once', () => {
    expect(QUIZ_LENGTH).toBe(LIBRARY.length)
    expect(new Set(QUIZ_ORDER).size).toBe(QUIZ_ORDER.length)
    const libIds = new Set(LIBRARY.map((p) => p.id))
    for (const id of QUIZ_ORDER) expect(libIds.has(id), `unknown id ${id}`).toBe(true)
    for (const p of LIBRARY) {
      expect(QUIZ_ORDER.includes(p.id), `${p.id} missing from the quiz`).toBe(true)
    }
  })

  it('resolves a pair at every index', () => {
    for (let i = 0; i < QUIZ_LENGTH; i++) {
      expect(pairAt(i), `index ${i}`).toBeDefined()
    }
    expect(pairAt(-1)).toBeUndefined()
    expect(pairAt(QUIZ_LENGTH)).toBeUndefined()
  })
})

describe('quiz ordering', () => {
  /**
   * Walking the taxonomy in the paper's own order means the framework is legible from
   * the questions themselves rather than needing to be explained first.
   */
  it('groups by category, then by Table 1 facet order', () => {
    const expectedFacets: string[] = []
    for (const c of CATEGORIES) for (const f of FACETS_BY_CATEGORY[c]) expectedFacets.push(f)

    // Ignore the deferred centrality questions, which are intentionally out of order.
    const main = QUIZ_ORDER.filter((id) => !isCentralityQuestion(id))
    const seenOrder: string[] = []
    for (const id of main) {
      const facet = String(LIBRARY_BY_ID.get(id)!.facet)
      if (seenOrder[seenOrder.length - 1] !== facet) seenOrder.push(facet)
    }
    // Each facet appears as one contiguous block...
    expect(new Set(seenOrder).size).toBe(seenOrder.length)
    // ...and the blocks run in Table 1 order.
    expect(seenOrder).toEqual(expectedFacets.filter((f) => seenOrder.includes(f)))
  })

  /**
   * The design constraint this module exists to enforce. Asking a stranger to rate how
   * much their race matters as question three reads as a test; after sixty questions
   * about climate, craft and family, it arrives in an established context.
   */
  it('defers the identity-centrality questions to the very end', () => {
    const tail = QUIZ_ORDER.slice(-CENTRALITY_LAST.length)
    expect([...tail].sort()).toEqual([...CENTRALITY_LAST].sort())
    for (const id of CENTRALITY_LAST) {
      expect(QUIZ_ORDER.indexOf(id)).toBeGreaterThan(QUIZ_LENGTH - CENTRALITY_LAST.length - 1)
    }
  })

  it('defers exactly the pairs that are the strongest rim anchors', () => {
    // These are what make the deferral matter: each is immutability >= 0.80, so each is
    // a rim anchor, and skipping one genuinely costs the mosaic a support.
    for (const id of CENTRALITY_LAST) {
      const p = LIBRARY_BY_ID.get(id)
      expect(p, id).toBeDefined()
      expect(p!.immutability, `${id} immutability`).toBeGreaterThanOrEqual(0.8)
      expect(p!.category, `${id} category`).toBe('demographic')
    }
  })

  it('starts with something impersonal', () => {
    // The first question sets the tone for the whole instrument.
    const first = LIBRARY_BY_ID.get(QUIZ_ORDER[0]!)!
    expect(isCentralityQuestion(first.id)).toBe(false)
  })

  it('is stable across imports', () => {
    expect(QUIZ_ORDER).toEqual([...QUIZ_ORDER])
  })
})

describe('facet preamble', () => {
  /**
   * Not decoration. D-GEN-02 ("Provide and protect" / "Nurture and sustain") is kept in
   * the library only on the condition that this framing is shown, so that neither pole
   * reads as assigned to a sex.
   */
  it('provides the gender framing that D-GEN-02 is conditional on', () => {
    const copy = FACET_PREAMBLE['gender']
    expect(copy).toBeDefined()
    expect(copy!.toLowerCase()).toContain('expectations')
    expect(copy!.toLowerCase()).toContain('open to everyone')
  })

  it('covers every facet holding a pair flagged risky', () => {
    const riskyFacets = new Set(LIBRARY.filter((p) => p.risky).map((p) => String(p.facet)))
    expect(riskyFacets.size).toBeGreaterThan(0)
    for (const f of riskyFacets) {
      expect(FACET_PREAMBLE[f], `no preamble for risky facet "${f}"`).toBeDefined()
    }
  })
})

describe('resume position', () => {
  it('returns the first gap, not the count', () => {
    // Someone who skipped question two must be taken back to it, not past it.
    const answered = new Set([QUIZ_ORDER[0]!, QUIZ_ORDER[2]!, QUIZ_ORDER[3]!])
    expect(firstUnansweredIndex(answered)).toBe(1)
  })

  it('returns 0 for a fresh start', () => {
    expect(firstUnansweredIndex(new Set())).toBe(0)
  })

  it('returns -1 once every question has been visited', () => {
    expect(firstUnansweredIndex(new Set(QUIZ_ORDER))).toBe(-1)
  })

  it('ignores ids that are not part of the quiz', () => {
    expect(firstUnansweredIndex(new Set(['custom.whatever']))).toBe(0)
  })
})
