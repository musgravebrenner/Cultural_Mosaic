import { describe, it, expect } from 'vitest'
import { LIBRARY, ANTAGONISMS, LIBRARY_BY_ID } from './library'
import { CATEGORY_OF_FACET, FACETS_BY_CATEGORY, CATEGORIES } from './taxonomy'

/**
 * These catch the data-entry mistakes that would otherwise surface as one
 * mysteriously-misplaced tile in week three, by which point you would be debugging
 * the placement math instead of the typo that actually caused it.
 */

describe('library integrity', () => {
  it('has 79 pairs', () => {
    expect(LIBRARY).toHaveLength(79)
  })

  it('has the documented per-category counts', () => {
    const counts = { demographic: 0, geographic: 0, associative: 0 }
    for (const p of LIBRARY) counts[p.category]++
    expect(counts).toEqual({ demographic: 21, geographic: 24, associative: 34 })
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

  it('covers every one of the 15 Table 1 facets', () => {
    const seen = new Set(LIBRARY.map((p) => p.facet))
    for (const c of CATEGORIES) {
      for (const f of FACETS_BY_CATEGORY[c]) {
        expect(seen.has(f), `no pairs authored for facet "${f}"`).toBe(true)
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
    expect(blended.map((p) => p.id)).toEqual(['A-AVO-06'])
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
   */
  it('has a healthy rim / middle / core distribution', () => {
    const anchors = LIBRARY.filter((p) => p.immutability >= 0.75)
    const mass = LIBRARY.filter((p) => p.immutability > 0.45 && p.immutability < 0.75)
    const loads = LIBRARY.filter((p) => p.immutability <= 0.45)

    // Shape guards, not exact counts. Current: 11 / 29 / 39.
    expect(anchors.length, 'anchor candidates').toBeGreaterThanOrEqual(8)
    expect(anchors.length, 'too many anchor candidates').toBeLessThanOrEqual(16)
    expect(mass.length, 'structural mass band').toBeGreaterThanOrEqual(25)
    expect(loads.length, 'load candidates').toBeGreaterThanOrEqual(15)
    // The middle band must not be so thin that the optimizer has nothing to build with
    // between the rim pins and the hub loads.
    expect(mass.length / LIBRARY.length, 'mass band share').toBeGreaterThan(0.25)
    expect(anchors.length + mass.length + loads.length).toBe(LIBRARY.length)
  })

  it('draws anchor candidates from more than one category', () => {
    // All anchors in one sector means every load path terminates on one rim arc, which
    // is the DOMINANT morphology. It must be reachable by a profile, never forced by
    // the library.
    const cats = new Set(LIBRARY.filter((p) => p.immutability >= 0.75).map((p) => p.category))
    expect(cats.size).toBeGreaterThanOrEqual(2)
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
    expect(ANTAGONISMS.length).toBeGreaterThanOrEqual(15)
  })
})
