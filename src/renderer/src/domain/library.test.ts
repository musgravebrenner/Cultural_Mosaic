import { describe, it, expect } from 'vitest'
import { ANCHORS, LIBRARY, ANTAGONISMS, LIBRARY_BY_ID } from './library'
import { CATEGORY_OF_FACET, FACETS_BY_CATEGORY, CATEGORIES, CATEGORY_INDEX } from './taxonomy'
import { normalizeMix } from '../layout/polar'

/**
 * These catch the data-entry mistakes that would otherwise surface as one
 * mysteriously-misplaced tile in week three, by which point you would be debugging
 * the placement math instead of the typo that actually caused it.
 */

describe('library integrity', () => {
  it('has 21 pairs', () => {
    expect(LIBRARY).toHaveLength(21)
  })

  it('has the documented per-category counts', () => {
    const counts = { demographic: 0, geographic: 0, associative: 0 }
    for (const p of LIBRARY) counts[p.category]++
    // Restructured from a 30-pair library (itself distilled from an 86-pair draft):
    // exactly 7 regular orientation questions per category, with the pairs that used
    // to do anchor duty under a spectrum disguise moved out to ANCHORS instead.
    expect(counts).toEqual({ demographic: 7, geographic: 7, associative: 7 })
  })

  it('has unique ids', () => {
    const ids = LIBRARY.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(LIBRARY_BY_ID.size).toBe(LIBRARY.length)
  })

  it('declares a category consistent with its Table 1 facet', () => {
    for (const p of LIBRARY) {
      expect(p.facet, `${p.id} must use a real Table 1 facet`).not.toBe('custom')
      if (p.facet === 'custom') continue
      expect(CATEGORY_OF_FACET[p.facet], `${p.id} facet/category mismatch`).toBe(p.category)
    }
  })

  /**
   * Union of LIBRARY and ANCHORS, not LIBRARY alone: religion, life-events, standing
   * and embodied are now covered entirely by their anchor (ANCH-A-04/01/02/03), since
   * the regular spectrum question that used to stand in for each was either retired
   * or replaced. A fact-type question is still a question for this purpose.
   */
  it('covers every one of the 15 Table 1 facets', () => {
    const seen = new Set([...LIBRARY.map((p) => p.facet), ...ANCHORS.map((a) => a.facet)])
    for (const c of CATEGORIES) {
      for (const f of FACETS_BY_CATEGORY[c]) {
        expect(seen.has(f), `no pairs or anchors authored for facet "${f}"`).toBe(true)
      }
    }
  })

  it('is marked as library data, and every id encodes its category', () => {
    const prefix = { demographic: 'D-', geographic: 'G-', associative: 'A-' }
    for (const p of LIBRARY) {
      expect(p.source).toBe('library')
      expect(p.id.startsWith(prefix[p.category]), `${p.id} prefix/category mismatch`).toBe(true)
    }
  })
})

describe('pole labels', () => {
  it('are non-empty, trimmed, and within 1-44 chars', () => {
    for (const p of LIBRARY) {
      for (const [side, label] of [
        ['poleA', p.poleA],
        ['poleB', p.poleB],
      ] as const) {
        expect(label.length, `${p.id}.${side} empty`).toBeGreaterThan(0)
        expect(label, `${p.id}.${side} not trimmed`).toBe(label.trim())
        expect(label.length, `${p.id}.${side} too long: "${label}"`).toBeLessThanOrEqual(44)
        // Rule 6: no control characters, no collapsed double spaces.
        expect(label, `${p.id}.${side} has double spaces`).not.toMatch(/ {2}/)
        const ctrl = Array.from(label).some((ch) => {
          const c = ch.codePointAt(0) ?? 0
          return c < 32 || c === 127
        })
        expect(ctrl, `${p.id}.${side} has control characters`).toBe(false)
      }
    }
  })

  it('differ within a pair, case-insensitively', () => {
    for (const p of LIBRARY) {
      expect(p.poleA.toLowerCase(), `${p.id} poles identical`).not.toBe(p.poleB.toLowerCase())
    }
  })

  it('has no exactly-duplicated pole pair across the library', () => {
    const seen = new Map<string, string>()
    for (const p of LIBRARY) {
      const key = `${p.poleA.toLowerCase()}||${p.poleB.toLowerCase()}`
      const prior = seen.get(key)
      expect(prior, `${p.id} duplicates ${prior ?? ''}`).toBeUndefined()
      seen.set(key, p.id)
    }
  })
})

describe('category mix vectors', () => {
  it('are non-negative and sum to exactly 1', () => {
    for (const p of LIBRARY) {
      const sum = p.mix[0] + p.mix[1] + p.mix[2]
      for (const [i, v] of p.mix.entries()) {
        expect(v, `${p.id} mix[${i}] negative`).toBeGreaterThanOrEqual(0)
        expect(v, `${p.id} mix[${i}] > 1`).toBeLessThanOrEqual(1)
      }
      // Authored L1-normalized. A mix that does not sum to 1 is a typo, and it would
      // silently shift both the hue and the placement angle.
      expect(sum, `${p.id} mix sums to ${sum}, not 1`).toBeCloseTo(1, 10)
    }
  })

  it('is never all-zero', () => {
    for (const p of LIBRARY) {
      expect(Math.max(...p.mix), `${p.id} mix is all zero`).toBeGreaterThan(0)
    }
  })

  /**
   * Deliberately NOT "the declared category is the argmax of the mix". `category` is a
   * UI-grouping label derived from the pair's Table 1 facet; `mix` is what drives hue
   * and placement. A pair may legitimately be filed under one tile while its content
   * leans toward another category -- that is exactly the cross-category blend the model
   * exists to represent, and it is what lands the pair near a sector boundary.
   *
   * A-AVO-06 (Subsistence from the land / Provision from the store) is the live example:
   * an Avocation by facet, hence Associative by category, but majority Geographic by
   * content. It should render cyan and sit near the G/A seam. Requiring argmax to match
   * would forbid it.
   *
   * What actually needs guarding is that the declared category is *present* in the mix,
   * so a pair is never filed under a tile whose category it barely contains.
   */
  it('gives its declared primary category a meaningful share of the mix', () => {
    const idx = { demographic: 0, geographic: 1, associative: 2 } as const
    for (const p of LIBRARY) {
      const own = p.mix[idx[p.category]] ?? 0
      expect(own, `${p.id} declares ${p.category} but weights it only ${own}`)
        .toBeGreaterThanOrEqual(0.25)
    }
  })

  it('files any pair whose content out-leans its tile as a genuine blend', () => {
    // Not a failure condition -- a documentation assertion. If this count changes,
    // someone edited a mix and should confirm the blend was intended.
    const idx = { demographic: 0, geographic: 1, associative: 2 } as const
    const blended = LIBRARY.filter((p) => (p.mix[idx[p.category]] ?? 0) < Math.max(...p.mix))
    // A-AVO-06, the previous sole example, was cut in the distillation to 30 pairs.
    expect(blended.map((p) => p.id)).toEqual([])
  })
})

describe('polar skew', () => {
  it('sums to zero so it redistributes rather than adds weight', () => {
    for (const p of LIBRARY) {
      if (!p.skew) continue
      const sum = p.skew[0] + p.skew[1] + p.skew[2]
      expect(sum, `${p.id} skew sums to ${sum}, not 0`).toBeCloseTo(0, 10)
    }
  })

  it('keeps both poles non-negative and non-degenerate after application', () => {
    for (const p of LIBRARY) {
      if (!p.skew) continue
      for (const lean of [-1, 1]) {
        const raw = p.mix.map((m, i) => m + lean * p.skew![i]!)
        const clamped = raw.map((v) => Math.max(0, v))
        const total = clamped[0]! + clamped[1]! + clamped[2]!
        expect(total, `${p.id} at lean=${lean} collapses to a zero vector`).toBeGreaterThan(0.2)
        /**
         * A component whose authored base is 0 MUST go negative on one side for any
         * nonzero skew, and clamping it to 0 is the semantically correct outcome:
         * "this pole has none of this category". G-REG-01 is the live example -- its
         * associative base is 0 and pole B gains a chosen-belonging component, so pole
         * A necessarily computes to -0.10 and clamps.
         *
         * So this bound is not "never negative". It catches a skew so large that the
         * authored centre must be wrong -- an excursion deeper than the component could
         * possibly justify.
         */
        expect(Math.min(...raw), `${p.id} skew drives mix to ${Math.min(...raw)}`)
          .toBeGreaterThan(-0.25)
      }
    }
  })
})

describe('immutability', () => {
  it('is within [0,1]', () => {
    for (const p of LIBRARY) {
      expect(p.immutability, `${p.id}`).toBeGreaterThanOrEqual(0)
      expect(p.immutability, `${p.id}`).toBeLessThanOrEqual(1)
    }
  })

  /**
   * The distribution is deliberately shaped: few anchors (so load spans are long and
   * the result reads as a truss), a thick middle band (material to build with), and a
   * well-populated fluid core (loads to carry). A drift here quietly changes what all
   * the artwork looks like, so it is asserted rather than left to chance.
   *
   * Thresholds are scaled for the 21-pair regular set (down from the 30-pair library's
   * 13/10/7), not the 30-pair library's own numbers -- ANCHORS now carries the bulk of
   * what used to be the library's anchor share, on purpose (see the note below).
   */
  it('has a healthy rim / middle / core distribution', () => {
    const anchors = LIBRARY.filter((p) => p.immutability >= 0.75)
    const mass = LIBRARY.filter((p) => p.immutability > 0.45 && p.immutability < 0.75)
    const loads = LIBRARY.filter((p) => p.immutability <= 0.45)

    // Shape guards, not exact counts. Current: 8 / 7 / 6.
    expect(anchors.length, 'anchor candidates').toBeGreaterThanOrEqual(6)
    expect(anchors.length, 'too many anchor candidates').toBeLessThanOrEqual(12)
    expect(mass.length, 'structural mass band').toBeGreaterThanOrEqual(5)
    expect(loads.length, 'load candidates').toBeGreaterThanOrEqual(4)
    expect(anchors.length + mass.length + loads.length).toBe(LIBRARY.length)
  })

  /**
   * EVERY category must be able to anchor, and Associative is the one that could not.
   *
   * Chao & Moon define the associative category by ongoing choice, so a library built
   * only from Table 1's associative tiles has nothing fixed in it -- and since radius
   * comes from immutability, the entire Associative third of the disc could never reach
   * the rim. Every load path had to terminate on the Demographic or Geographic arc,
   * which forced the DOMINANT morphology on people whose actual anchors are the
   * permanent things they chose.
   *
   * Checked over LIBRARY union ANCHORS: none of the 7 regular Associative pairs clears
   * the anchor threshold any more (they all moved to ANCHORS, e.g. ANCH-A-01 "raised a
   * child"), so the category's rim access now runs entirely through its anchors -- by
   * design, not by accident, matching IRREVERSIBLE_FACETS's own rationale.
   */
  it('lets every category produce a rim anchor', () => {
    const combined: { category: (typeof CATEGORIES)[number]; immutability: number }[] = [
      ...LIBRARY,
      ...ANCHORS,
    ]
    for (const c of CATEGORIES) {
      const own = combined.filter((p) => p.category === c && p.immutability >= 0.75)
      expect(own.length, `${c} has no possible rim anchor`).toBeGreaterThan(0)
    }
  })

  /**
   * ...and at least one of them must be able to reach the rim rather than merely sit in
   * the anchor BAND. Radius is immutability modulated by purity, so a high-immutability
   * pair whose hue is a blend gets pulled inward: an anchor category needs at least one
   * pair -- or, for an AnchorPair, at least one OPTION -- that is both fixed and
   * single-category.
   */
  it('gives every category a pure anchor, so the rim is reachable in every sector', () => {
    for (const c of CATEGORIES) {
      const i = CATEGORY_INDEX[c]
      const fromPairs = LIBRARY.some(
        (p) => p.category === c && p.immutability >= 0.75 && normalizeMix(p.mix)[i]! >= 0.9,
      )
      const fromAnchors = ANCHORS.some(
        (a) =>
          a.category === c &&
          a.immutability >= 0.75 &&
          a.options.some((o) => normalizeMix(o.hue)[i]! >= 0.9),
      )
      expect(fromPairs || fromAnchors, `${c} cannot reach the rim`).toBe(true)
    }
  })

  it('keeps every avocation in the fluid core band', () => {
    for (const p of LIBRARY.filter((p) => p.facet === 'avocations')) {
      expect(p.immutability, `${p.id} avocation should be fluid`).toBeLessThanOrEqual(0.45)
    }
  })
})

describe('authoring rules', () => {
  it('documents a reason for every pair flagged risky', () => {
    for (const p of LIBRARY) {
      if (p.risky === undefined) continue
      expect(p.risky.length, `${p.id} risky flag needs a reason`).toBeGreaterThan(40)
    }
  })

  /**
   * Rule 1 guard. Not exhaustive -- it cannot be -- but it catches the specific
   * category-membership framings that were explicitly cut, so a future edit that
   * reintroduces one fails here rather than reaching a grader.
   */
  it('has no category-membership pairs', () => {
    const banned = [
      /^male$/i, /^female$/i, /^man$/i, /^woman$/i,
      /^young$/i, /^old$/i,
      /^white$/i, /^black$/i, /^asian$/i, /^hispanic$/i, /^non-?white$/i,
      /^christian$/i, /^muslim$/i, /^jewish$/i, /^hindu$/i, /^buddhist$/i, /^atheist$/i,
      /^republican$/i, /^democrat$/i, /^conservative$/i, /^liberal$/i,
      /^immigrant$/i, /^native-?born$/i,
      /^religious$/i, /^secular$/i,
    ]
    for (const p of LIBRARY) {
      for (const label of [p.poleA, p.poleB]) {
        for (const re of banned) {
          expect(re.test(label.trim()), `${p.id}: "${label}" is a category membership`).toBe(false)
        }
      }
    }
  })

  it('has no pole phrased as the negation of the other', () => {
    // Rule 2: no pole may read as the absence or deficit of the other.
    for (const p of LIBRARY) {
      const a = p.poleA.toLowerCase()
      const b = p.poleB.toLowerCase()
      expect(b, `${p.id} poleB negates poleA`).not.toBe(`not ${a}`)
      expect(a, `${p.id} poleA negates poleB`).not.toBe(`not ${b}`)
    }
  })
})

describe('antagonisms', () => {
  it('reference pairs that exist', () => {
    for (const t of ANTAGONISMS) {
      expect(LIBRARY_BY_ID.has(t.a), `unknown antagonism id ${t.a}`).toBe(true)
      expect(LIBRARY_BY_ID.has(t.b), `unknown antagonism id ${t.b}`).toBe(true)
    }
  })

  it('never pit a pair against itself', () => {
    for (const t of ANTAGONISMS) expect(t.a).not.toBe(t.b)
  })

  it('has weights in (0,1] and a stated reason', () => {
    for (const t of ANTAGONISMS) {
      expect(t.weight, `${t.a}/${t.b}`).toBeGreaterThan(0)
      expect(t.weight, `${t.a}/${t.b}`).toBeLessThanOrEqual(1)
      expect(t.why.length, `${t.a}/${t.b} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('lists each unordered pair at most once', () => {
    const seen = new Set<string>()
    for (const t of ANTAGONISMS) {
      const key = [t.a, t.b].sort().join('||')
      expect(seen.has(key), `duplicate antagonism ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('has enough entries to be a meaningful signal', () => {
    // Trimmed from 18 to 6 alongside the library distillation -- most of the originals
    // referenced a pair that got cut. 6 among 30 pairs (one in ten) is the same rough
    // density as 18 among 86 (one in five) was generous by comparison; either way the
    // test that matters more is the one below, that every surviving antagonism actually
    // resolves to two real pairs.
    expect(ANTAGONISMS.length).toBeGreaterThanOrEqual(5)
  })
})
