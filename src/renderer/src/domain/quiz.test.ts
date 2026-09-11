import { describe, it, expect } from 'vitest'
import {
  ANCHOR_LENGTH,
  ANCHOR_ORDER,
  CENTRALITY_LAST,
  FACET_PREAMBLE,
  QUIZ_CHOICES,
  QUIZ_LENGTH,
  QUIZ_ORDER,
  anchorAt,
  choiceIndexOf,
  firstUnansweredAnchorIndex,
  firstUnansweredIndex,
  isCentralityQuestion,
  pairAt,
} from './quiz'
import { LEAN_CENTER, LEAN_NOTCHES, STRENGTH_LABELS } from './types'
import { ANCHOR_BY_ID, ANCHORS, LIBRARY, LIBRARY_BY_ID } from './library'
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
   * much their race matters as question three reads as a test; after the rest of the
   * (much shorter) run, it arrives in an established context. This is an ORDERING fact
   * only now -- centrality questions are deferred but still mandatory, unlike anchors.
   */
  it('defers the centrality questions to the very end', () => {
    const tail = QUIZ_ORDER.slice(-CENTRALITY_LAST.length)
    expect([...tail].sort()).toEqual([...CENTRALITY_LAST].sort())
    for (const id of CENTRALITY_LAST) {
      expect(QUIZ_ORDER.indexOf(id)).toBeGreaterThan(QUIZ_LENGTH - CENTRALITY_LAST.length - 1)
    }
  })

  it('keeps the centrality set small', () => {
    expect(CENTRALITY_LAST.length).toBeLessThanOrEqual(4)
    expect(new Set(CENTRALITY_LAST).size).toBe(CENTRALITY_LAST.length)
  })

  it('defers exactly the pairs that are the strongest rim anchors', () => {
    // These are what make the deferral matter: each is immutability >= 0.80, so each is
    // a rim anchor, and answering one late still costs the mosaic nothing structurally.
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

describe('anchor phase', () => {
  it('walks every anchor exactly once', () => {
    expect(ANCHOR_LENGTH).toBe(ANCHORS.length)
    expect(new Set(ANCHOR_ORDER).size).toBe(ANCHOR_ORDER.length)
    for (const id of ANCHOR_ORDER) expect(ANCHOR_BY_ID.has(id), `unknown anchor ${id}`).toBe(true)
    for (const a of ANCHORS) {
      expect(ANCHOR_ORDER.includes(a.id), `${a.id} missing from the anchor phase`).toBe(true)
    }
  })

  it('resolves an anchor at every index', () => {
    for (let i = 0; i < ANCHOR_LENGTH; i++) expect(anchorAt(i), `index ${i}`).toBeDefined()
    expect(anchorAt(-1)).toBeUndefined()
    expect(anchorAt(ANCHOR_LENGTH)).toBeUndefined()
  })

  it('groups Demographic, then Geographic, then Associative', () => {
    const catOrder = ANCHOR_ORDER.map((id) => ANCHOR_BY_ID.get(id)!.category)
    const firstGeo = catOrder.indexOf('geographic')
    const firstAssoc = catOrder.indexOf('associative')
    const lastDemo = catOrder.lastIndexOf('demographic')
    const lastGeo = catOrder.lastIndexOf('geographic')
    expect(lastDemo).toBeLessThan(firstGeo === -1 ? Infinity : firstGeo)
    expect(lastGeo).toBeLessThan(firstAssoc === -1 ? Infinity : firstAssoc)
  })

  it('every anchor has at least two dignified, distinct options', () => {
    for (const a of ANCHORS) {
      expect(a.options.length, a.id).toBeGreaterThanOrEqual(2)
      const ids = a.options.map((o) => o.id)
      expect(new Set(ids).size, `${a.id} duplicate option ids`).toBe(ids.length)
      const labels = a.options.map((o) => o.label.toLowerCase())
      expect(new Set(labels).size, `${a.id} duplicate option labels`).toBe(labels.length)
    }
  })

  it('resumes at the first unanswered anchor', () => {
    const answered = new Set([ANCHOR_ORDER[0]!, ANCHOR_ORDER[2]!])
    expect(firstUnansweredAnchorIndex(answered)).toBe(1)
    expect(firstUnansweredAnchorIndex(new Set())).toBe(0)
    expect(firstUnansweredAnchorIndex(new Set(ANCHOR_ORDER))).toBe(-1)
  })
})

describe('facet preamble', () => {
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

/**
 * The quiz's answer scale. These assertions are the CONTRACT, not a restatement of the
 * table: each one is a property that would be silently wrong if the mapping were edited
 * carelessly, and a wrong mapping produces plausible-looking artwork.
 */
describe('QUIZ_CHOICES', () => {
  it('offers exactly the seven lean notches, in order, once each', () => {
    expect(QUIZ_CHOICES.map((c) => c.leanIndex)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('derives strength from distance off centre, symmetrically', () => {
    const strengths = QUIZ_CHOICES.map((c) => c.strength)
    // Mirror image about the middle: the scale cannot favour one statement over the
    // other, or the artwork would systematically weight poleB answers more heavily.
    expect(strengths).toEqual(strengths.slice().reverse())
    expect(strengths).toEqual([3, 2, 1, 0, 1, 2, 3])
  })

  /**
   * The reversal from the previous design, and the reason a plain slider can now do
   * this job alone. Dead centre used to be forced to Core (the most diffuse STRONG
   * material) with the opt-out carrying "no material at all" separately. Now centre
   * IS the no-material position -- Dormant -- and conviction lives at the extremes,
   * which is both the standard semantic-differential reading and what let the
   * separate "how much does this matter" control be removed entirely.
   */
  it('makes the centre DORMANT, not Core', () => {
    const centre = QUIZ_CHOICES[3]!
    expect(centre.leanIndex).toBe(LEAN_CENTER)
    expect(centre.side).toBe(0)
    expect(centre.strength).toBe(0)
    expect(STRENGTH_LABELS[centre.strength]).toBe('Dormant')
    // Strictly weaker than its immediate neighbours, which are the hedged answers.
    expect(centre.strength).toBeLessThan(QUIZ_CHOICES[2]!.strength)
    expect(centre.strength).toBeLessThan(QUIZ_CHOICES[4]!.strength)
  })

  it('makes both extremes Core', () => {
    expect(QUIZ_CHOICES[0]!.strength).toBe(3)
    expect(QUIZ_CHOICES[6]!.strength).toBe(3)
    expect(STRENGTH_LABELS[3]).toBe('Core')
  })

  it('assigns each side consistently with its lean', () => {
    for (const c of QUIZ_CHOICES) {
      const notch = LEAN_NOTCHES[c.leanIndex]!
      if (c.side < 0) expect(notch, c.degree).toBeLessThan(0)
      else if (c.side > 0) expect(notch, c.degree).toBeGreaterThan(0)
      else expect(notch, c.degree).toBe(0)
    }
  })

  it('round-trips every choice through choiceIndexOf', () => {
    QUIZ_CHOICES.forEach((c, i) => {
      expect(choiceIndexOf(c.leanIndex, c.strength), c.degree).toBe(i)
    })
  })

  it('reports -1 for a lean/strength pair the scale cannot express', () => {
    // Strength is always derived from lean now, so no valid TileAnswer can carry a
    // mismatched pair -- but choiceIndexOf itself stays a plain lookup, and this locks
    // down what it does with one anyway.
    expect(choiceIndexOf(0, 1)).toBe(-1)
    expect(choiceIndexOf(3, 3)).toBe(-1)
  })
})
