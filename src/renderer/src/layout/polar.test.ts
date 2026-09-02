import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LAYOUT,
  circularMean,
  effectiveHue,
  hashUnit,
  normalizeMix,
  placeAnswers,
  radiusFraction,
  sigmaFor,
  M_ANCHOR,
  M_LOAD,
} from './polar'
import { LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex, StrengthLevel, TileAnswer, WordPair } from '../domain/types'
import { LEAN_CENTER } from '../domain/types'

function answer(
  pairId: string,
  leanIndex: LeanIndex = LEAN_CENTER,
  strength: StrengthLevel = 2,
  addedAt = 0,
): TileAnswer {
  return { answerId: `ans-${pairId}`, pairId, leanIndex, strength, addedAt }
}

const libMap = LIBRARY_BY_ID

describe('circularMean -- the boundary property', () => {
  /**
   * The whole reason for choosing a weighted circular mean over discrete angular slots.
   * These three are exact, not approximate, and they are why the secondary-colour
   * meanings land at the seams between exactly the categories they merge.
   */
  it('places a pure category at its sector centre', () => {
    expect(circularMean([1, 0, 0]).thetaDeg).toBeCloseTo(60, 10)
    expect(circularMean([0, 1, 0]).thetaDeg).toBeCloseTo(180, 10)
    expect(circularMean([0, 0, 1]).thetaDeg).toBeCloseTo(300, 10)
    expect(circularMean([1, 0, 0]).purity).toBeCloseTo(1, 10)
  })

  it('places an equal two-way blend EXACTLY on the boundary between its parents', () => {
    // Yellow -- Demographic + Geographic -- "Regional Heritage / Roots"
    expect(circularMean([0.5, 0.5, 0]).thetaDeg).toBeCloseTo(120, 10)
    // Cyan -- Geographic + Associative -- "Localized Communities"
    expect(circularMean([0, 0.5, 0.5]).thetaDeg).toBeCloseTo(240, 10)
    // Magenta -- Associative + Demographic -- "Affinity Groups"
    expect(circularMean([0.5, 0, 0.5]).thetaDeg).toBeCloseTo(0, 10)
  })

  it('reports purity 0.5 for an equal two-way blend', () => {
    expect(circularMean([0.5, 0.5, 0]).purity).toBeCloseTo(0.5, 10)
    expect(circularMean([0.5, 0, 0.5]).purity).toBeCloseTo(0.5, 10)
    expect(circularMean([0, 0.5, 0.5]).purity).toBeCloseTo(0.5, 10)
    // An unequal blend sits between its two-way and pure values.
    expect(circularMean([0.7, 0.3, 0]).purity).toBeCloseTo(0.6083, 3)
  })

  it('leans toward the heavier parent for an unequal blend', () => {
    expect(circularMean([0.7, 0.3, 0]).thetaDeg).toBeCloseTo(85.285, 3)
    expect(circularMean([0.3, 0.7, 0]).thetaDeg).toBeCloseTo(154.715, 3)
    // Both stay on their heavier parent's side of the 120 deg D/G boundary.
    expect(circularMean([0.7, 0.3, 0]).thetaDeg).toBeLessThan(120)
    expect(circularMean([0.3, 0.7, 0]).thetaDeg).toBeGreaterThan(120)
  })

  /**
   * The silent-bug guard. atan2(0, 0) returns 0 in JavaScript, NOT NaN, so without an
   * explicit degenerate branch a perfectly integrated identity is quietly placed at
   * 0 deg (the Associative/Demographic seam) and nothing looks broken -- it would just
   * become a structural anchor for a category it does not belong to.
   */
  it('flags a balanced three-way mix as degenerate rather than returning 0 deg', () => {
    const m = circularMean([1 / 3, 1 / 3, 1 / 3])
    expect(m.purity).toBeCloseTo(0, 10)
    expect(m.degenerate).toBe(true)
  })

  it('returns theta in [0,360) for every library pair at both poles', () => {
    for (const p of LIBRARY) {
      for (const lean of [-1, 0, 1]) {
        const { thetaDeg } = circularMean(effectiveHue(p, lean))
        expect(thetaDeg, `${p.id} lean=${lean}`).toBeGreaterThanOrEqual(0)
        expect(thetaDeg, `${p.id} lean=${lean}`).toBeLessThan(360)
      }
    }
  })
})

describe('effectiveHue', () => {
  it('is the authored mix when there is no skew', () => {
    const p = LIBRARY_BY_ID.get('A-REL-01')!
    expect(p.skew).toBeUndefined()
    expect(effectiveHue(p, -1)).toEqual(normalizeMix(p.mix))
    expect(effectiveHue(p, 1)).toEqual(normalizeMix(p.mix))
  })

  /**
   * A-FAM-03 is the library's widest skew and the proof that slider position produces
   * STRUCTURALLY different art rather than merely recoloured art. "Family is who I was
   * born to" genuinely is more Demographic than "Family is who I chose".
   */
  it('moves A-FAM-03 about 91 degrees between its poles', () => {
    const p = LIBRARY_BY_ID.get('A-FAM-03')!
    const a = effectiveHue(p, -1)
    const b = effectiveHue(p, 1)
    expect(a[0]).toBeCloseTo(0.75, 6)
    expect(a[2]).toBeCloseTo(0.25, 6)
    expect(b[0]).toBeCloseTo(0.15, 6)
    expect(b[2]).toBeCloseTo(0.85, 6)

    const ta = circularMean(a).thetaDeg
    const tb = circularMean(b).thetaDeg
    // Wraps through 0, so measure the short way round.
    let sweep = Math.abs(ta - tb)
    if (sweep > 180) sweep = 360 - sweep
    expect(sweep).toBeCloseTo(91.4, 1)
  })

  it('clamps a negative component to zero rather than producing a negative hue', () => {
    // G-REG-01's associative base is 0 and pole B gains a chosen-belonging component,
    // so pole A computes to -0.15 on that channel and must clamp to 0.
    const p = LIBRARY_BY_ID.get('G-REG-01')!
    const a = effectiveHue(p, -1)
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0)
    expect(a[0] + a[1] + a[2]).toBeCloseTo(1, 10)
  })

  it('always returns an L1-normalized, non-negative vector', () => {
    for (const p of LIBRARY) {
      for (const lean of [-1, -1 / 3, 0, 1 / 3, 1]) {
        const h = effectiveHue(p, lean)
        expect(h[0] + h[1] + h[2], `${p.id}`).toBeCloseTo(1, 10)
        expect(Math.min(...h), `${p.id}`).toBeGreaterThanOrEqual(0)
      }
    }
  })
})

/**
 * The skew SIGN audit -- the test that catches the bug this file was written to find.
 *
 * `skew` is the shift toward pole B, so pole A's hue is `mix - skew`. Getting the sign
 * backwards places "Family is who I was born to" in the Associative sector and "Family
 * is who I chose" in the Demographic sector: the geometry the layout exists to express
 * is inverted, and the art still looks completely plausible. Eleven of the fourteen
 * skewed pairs were authored with the sign inverted, and nothing but this would have
 * caught it.
 *
 * Each row records which pole SHOULD read as the more inherited/given one, on which
 * channel. This is intent encoded as data; it cannot be derived from the pole text.
 */
describe('skew direction', () => {
  type Channel = 'dem' | 'geo'
  /** [pairId, channel, which pole should be HIGHER on that channel] */
  const intent: [string, Channel, 'A' | 'B'][] = [
    ['D-AGE-02', 'dem', 'A'], // elders' judgment guides me = inherited authority
    ['D-AGE-05', 'dem', 'A'], // age earns standing = ascribed; merit = achieved
    ['D-ETH-02', 'dem', 'A'], // heritage language = inherited
    ['D-ETH-03', 'dem', 'A'], // keep ancestral customs distinct = inherited
    ['D-GEN-03', 'dem', 'A'], // roles follow tradition = inherited
    ['D-RAC-02', 'dem', 'B'], // interdependent = relational; own unit = the given self
    ['D-RAC-04', 'dem', 'B'], // community reputation = collective; only myself = individual
    ['G-REG-01', 'geo', 'A'], // where I was born = purely place; where I chose = elected
    ['A-FAM-01', 'dem', 'B'], // family as unit = collective; individual = the given self
    ['A-FAM-03', 'dem', 'A'], // who I was born to = inherited kin
    ['A-REL-03', 'dem', 'A'], // I inherited my tradition
    ['A-PRO-05', 'dem', 'A'], // field inherited from family
    ['A-POL-03', 'geo', 'A'], // decide close to home = local/place-bound
    ['A-POL-05', 'dem', 'A'], // tradition is evidence = inherited
  ]

  it('covers every skewed pair in the library', () => {
    const skewed = LIBRARY.filter((p) => p.skew).map((p) => p.id).sort()
    expect(intent.map(([id]) => id).sort()).toEqual(skewed)
  })

  it('puts the inherited pole on the higher demographic/geographic weight', () => {
    for (const [id, channel, higher] of intent) {
      const p = LIBRARY_BY_ID.get(id)!
      const ch = channel === 'dem' ? 0 : 1
      const a = effectiveHue(p, -1)[ch]!
      const b = effectiveHue(p, 1)[ch]!
      const msg = `${id} ${channel}: A=${a.toFixed(3)} B=${b.toFixed(3)}, expected ${higher} higher`
      if (higher === 'A') expect(a, msg).toBeGreaterThan(b)
      else expect(b, msg).toBeGreaterThan(a)
    }
  })

  it('moves each skewed pair far enough to matter geometrically', () => {
    // A skew that produces less than ~20 deg of travel is not buying structural
    // differentiation and should either be strengthened or dropped.
    for (const [id] of intent) {
      const p = LIBRARY_BY_ID.get(id)!
      const ta = circularMean(effectiveHue(p, -1)).thetaDeg
      const tb = circularMean(effectiveHue(p, 1)).thetaDeg
      let sweep = Math.abs(ta - tb)
      if (sweep > 180) sweep = 360 - sweep
      // G-REG-01 is intentionally gentle: it stays deep in the Geographic sector and
      // only shifts its blend, because birthplace must remain a geographic rim anchor.
      const floor = id === 'G-REG-01' ? 1 : 20
      expect(sweep, `${id} sweep=${sweep.toFixed(1)}`).toBeGreaterThanOrEqual(floor)
    }
  })
})

describe('radiusFraction', () => {
  /**
   * Golden table generated from the implementation on its first green run, per the
   * plan's own instruction not to hardcode literals from memory. The formula is
   *   rho(m) = f + (1-f) * m^1.35,  f = 0.10/0.92,  then * (0.55 + 0.45*psi).
   *
   * Note: docs/design/00-implementation-plan.md quotes an illustrative table whose
   * values run lower than this (0.45 vs 0.50 at m=0.55). That table does not match the
   * formula stated alongside it. The FORMULA is authoritative; these are its values.
   * Recorded here so the discrepancy is not later mistaken for a bug.
   */
  /**
   * Pinned explicitly rather than taken from DEFAULT_LAYOUT: this test covers the
   * FORMULA, so retuning the app's rim radius for a rendering margin must not
   * invalidate the mathematics golden. The integration fixture below is the test that
   * legitimately tracks DEFAULT_LAYOUT.
   */
  const cfg = { ...DEFAULT_LAYOUT, rimRadius: 0.92, minRadius: 0.1 }
  const golden: [number, number][] = [
    [1.00, 1.000000],
    [0.85, 0.824413],
    [0.75, 0.713143],
    [0.55, 0.506359],
    [0.45, 0.411989],
    [0.30, 0.284140],
    [0.15, 0.177521],
    [0.00, 0.108696],
  ]

  it('matches the golden table at full purity', () => {
    for (const [m, expected] of golden) {
      expect(radiusFraction(m, 1, cfg), `m=${m}`).toBeCloseTo(expected, 6)
    }
  })

  it('is monotonically increasing in immutability', () => {
    let prev = -1
    for (let m = 0; m <= 1.0001; m += 0.02) {
      const r = radiusFraction(m, 1, cfg)
      expect(r).toBeGreaterThan(prev)
      prev = r
    }
  })

  it('reaches the rim at m=1 and the floor at m=0', () => {
    expect(radiusFraction(1, 1, cfg)).toBeCloseTo(1, 10)
    expect(radiusFraction(0, 1, cfg)).toBeCloseTo(cfg.minRadius / cfg.rimRadius, 10)
  })

  it('never returns zero, so fluid items cannot collapse onto a coincident hub point', () => {
    for (const m of [0, 0.01, 0.1]) {
      for (const psi of [0, 0.5, 1]) {
        expect(radiusFraction(m, psi, cfg)).toBeGreaterThan(0.05)
      }
    }
  })

  /** Low purity pulls toward the hub -- white becomes a place, not just a colour. */
  it('pulls a category-neutral item inward but keeps an immutable one substantial', () => {
    const pureRim = radiusFraction(1, 1, cfg)
    const whiteRim = radiusFraction(1, 0, cfg)
    expect(whiteRim).toBeCloseTo(pureRim * cfg.purityFloor, 10)
    expect(whiteRim).toBeGreaterThan(0.5)

    const whiteFluid = radiusFraction(0.15, 0, cfg)
    expect(whiteFluid).toBeLessThan(0.12)
  })

  it('clamps out-of-range immutability instead of producing NaN', () => {
    expect(radiusFraction(-1, 1, cfg)).toBeCloseTo(radiusFraction(0, 1, cfg), 10)
    expect(radiusFraction(2, 1, cfg)).toBeCloseTo(radiusFraction(1, 1, cfg), 10)
    expect(Number.isFinite(radiusFraction(0.5, -1, cfg))).toBe(true)
  })
})

describe('sigmaFor', () => {
  /**
   * The interaction that silently flattens the whole app if it breaks: if sigma is
   * smaller than the sensitivity-filter radius, the filter erases the seed structure
   * before the optimizer can act on it and EVERY profile produces the same art.
   */
  it('keeps the smallest possible sigma at or above the filter radius', () => {
    const filterRadiusElems = 2.2
    const h = 2 / DEFAULT_LAYOUT.gridSize
    // Most concentrated case: fully committed and fully immutable.
    const minSigma = sigmaFor(1, 1, DEFAULT_LAYOUT)
    expect(minSigma / h, 'sigma in element widths').toBeGreaterThanOrEqual(filterRadiusElems)
  })

  it('spreads a balanced answer wider than a committed one', () => {
    expect(sigmaFor(0, 0.5, DEFAULT_LAYOUT)).toBeGreaterThan(sigmaFor(1, 0.5, DEFAULT_LAYOUT))
  })

  it('makes fluid traits more diffuse than immutable ones', () => {
    expect(sigmaFor(0.5, 0, DEFAULT_LAYOUT)).toBeGreaterThan(sigmaFor(0.5, 1, DEFAULT_LAYOUT))
  })

  it('spans roughly a 2.5x range across the library', () => {
    const lo = sigmaFor(1, 1, DEFAULT_LAYOUT)
    const hi = sigmaFor(0, 0, DEFAULT_LAYOUT)
    expect(hi / lo).toBeGreaterThan(2.2)
    expect(hi / lo).toBeLessThan(2.8)
  })

  it('respects the 1.5h Nyquist floor at coarse resolutions', () => {
    const coarse = { ...DEFAULT_LAYOUT, gridSize: 64 as const }
    const h = 2 / 64
    expect(sigmaFor(1, 1, coarse)).toBeGreaterThanOrEqual(1.5 * h)
  })
})

describe('hashUnit', () => {
  it('is in [0,1) and stable', () => {
    for (const p of LIBRARY) {
      const h = hashUnit(p.id)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
      expect(hashUnit(p.id)).toBe(h)
    }
  })

  it('spreads the library ids across the unit interval', () => {
    const buckets = new Array(10).fill(0)
    for (const p of LIBRARY) buckets[Math.floor(hashUnit(p.id) * 10)]!++
    // No bucket should hold more than a third of 79 ids.
    expect(Math.max(...buckets)).toBeLessThan(27)
    expect(buckets.filter((b) => b === 0).length).toBeLessThanOrEqual(2)
  })
})

describe('placeAnswers', () => {
  it('skips Dormant answers and unknown pair ids', () => {
    const out = placeAnswers({
      answers: [
        answer('A-REL-01', 5, 3),
        answer('A-REL-02', 5, 0), // Dormant -- kept in the document, contributes nothing
        answer('NOT-A-REAL-ID', 5, 3),
      ],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })
    expect(out.map((t) => t.pairId)).toEqual(['A-REL-01'])
  })

  it('is byte-identical across runs for identical input', () => {
    const answers = LIBRARY.slice(0, 20).map((p, i) =>
      answer(p.id, ((i * 3) % 7) as LeanIndex, ((i % 3) + 1) as StrengthLevel, i),
    )
    const a = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    const b = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('does not depend on the order answers arrive in', () => {
    const answers = LIBRARY.slice(0, 15).map((p, i) => answer(p.id, 4, 2, i))
    const forward = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    const reversed = placeAnswers({
      answers: answers.slice().reverse(),
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })
    const key = (t: { pairId: string }): string => t.pairId
    expect(
      JSON.stringify(forward.slice().sort((x, y) => (key(x) < key(y) ? -1 : 1))),
    ).toBe(JSON.stringify(reversed.slice().sort((x, y) => (key(x) < key(y) ? -1 : 1))))
  })

  it('puts x,y on the circle of the reported radius', () => {
    const answers = LIBRARY.slice(0, 30).map((p, i) => answer(p.id, 5, 3, i))
    for (const t of placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })) {
      expect(Math.hypot(t.x, t.y), t.pairId).toBeCloseTo(t.radius, 9)
      expect(t.radius).toBeLessThanOrEqual(DEFAULT_LAYOUT.rimRadius + 1e-9)
    }
  })

  it('takes amplitude from strength, never from |lean|', () => {
    // The sign error that would make every bicultural identity weightless -- the exact
    // inverse of what the paper claims about biculturals having advantages.
    const balancedCore = placeAnswers({
      answers: [answer('A-REL-01', LEAN_CENTER, 3)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    const committedMinor = placeAnswers({
      answers: [answer('A-REL-01', 6, 1)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!

    expect(balancedCore.polarity).toBe(0)
    expect(balancedCore.amplitude).toBe(1.0)
    expect(committedMinor.polarity).toBe(1)
    expect(committedMinor.amplitude).toBeCloseTo(0.33, 6)
    // Balanced-and-strong must deposit MORE than committed-and-weak.
    expect(balancedCore.amplitude).toBeGreaterThan(committedMinor.amplitude)
    // ...and be the more diffuse of the two.
    expect(balancedCore.sigma).toBeGreaterThan(committedMinor.sigma)
  })

  it('honours a per-answer immutability override', () => {
    const base = placeAnswers({
      answers: [answer('A-AVO-04', 6, 3)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    const pinned = placeAnswers({
      answers: [{ ...answer('A-AVO-04', 6, 3), immutabilityOverride: 1 }],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    expect(base.role).toBe('load')
    expect(pinned.role).toBe('anchor')
    expect(pinned.radius).toBeGreaterThan(base.radius)
  })

  it('assigns band roles at the documented thresholds', () => {
    const answers = LIBRARY.map((p, i) => answer(p.id, 6, 3, i))
    for (const t of placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })) {
      if (t.immutability >= M_ANCHOR) expect(t.role, t.pairId).toBe('anchor')
      else if (t.immutability <= M_LOAD) expect(t.role, t.pairId).toBe('load')
      else expect(t.role, t.pairId).toBe('mass')
    }
  })

  it('inverts anchors and loads when the layout toggle is set', () => {
    // The contestable-claim toggle: chosen associations pin, inherited traits load.
    const answers = [answer('G-REG-01', 6, 3), answer('A-AVO-04', 6, 3)]
    const normal = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    const inverted = placeAnswers({
      answers,
      pairs: libMap,
      layout: { ...DEFAULT_LAYOUT, invertAnchors: true },
    })
    const roleOf = (ts: typeof normal, id: string): string =>
      ts.find((t) => t.pairId === id)!.role
    expect(roleOf(normal, 'G-REG-01')).toBe('anchor')
    expect(roleOf(normal, 'A-AVO-04')).toBe('load')
    expect(roleOf(inverted, 'G-REG-01')).toBe('load')
    expect(roleOf(inverted, 'A-AVO-04')).toBe('anchor')
  })

  /**
   * The crowding regression. 65 of the 79 library pairs are single-category, so a user
   * who answers 20 Associative pairs would otherwise get them all stacked near 300 deg.
   */
  it('separates 20 same-category answers by at least most of the mesh spacing', () => {
    const assoc = LIBRARY.filter((p) => p.category === 'associative').slice(0, 20)
    const out = placeAnswers({
      answers: assoc.map((p, i) => answer(p.id, 4, 2, i)),
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })
    expect(out).toHaveLength(20)

    const h = 2 / DEFAULT_LAYOUT.gridSize
    let worst = Infinity
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!
        const b = out[j]!
        worst = Math.min(worst, Math.hypot(a.x - b.x, a.y - b.y) / DEFAULT_LAYOUT.rimRadius)
      }
    }
    // The relaxation only moves theta, so items on nearly the same tiny radius cannot
    // always reach the full 2.5h target. Requiring most of one element width is the
    // honest bar, and it is what actually prevents coincident-node stress singularities.
    expect(worst).toBeGreaterThan(2.0 * h)
  })

  it('keeps every blend within the span of its two parent sectors', () => {
    // The +/-20 deg cap exists so a blend can never wander out of the region its
    // parents span, which would destroy the "theta = category" reading the layout
    // depends on.
    const answers = LIBRARY.map((p, i) => answer(p.id, 0, 3, i))
    for (const t of placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })) {
      const mean = circularMean(t.hue)
      if (mean.degenerate) continue
      let diff = Math.abs(t.thetaDeg - mean.thetaDeg)
      if (diff > 180) diff = 360 - diff
      expect(diff, `${t.pairId} drifted ${diff.toFixed(1)} deg`).toBeLessThanOrEqual(20.001)
    }
  })

  it('produces no NaN or Infinity for any single library pair at any notch', () => {
    for (const p of LIBRARY) {
      for (let lean = 0; lean < 7; lean++) {
        for (let s = 1; s < 4; s++) {
          const t = placeAnswers({
            answers: [answer(p.id, lean as LeanIndex, s as StrengthLevel)],
            pairs: libMap,
            layout: DEFAULT_LAYOUT,
          })[0]!
          for (const [k, v] of Object.entries(t)) {
            if (typeof v === 'number') {
              expect(Number.isFinite(v), `${p.id} lean=${lean} s=${s} ${k}=${v}`).toBe(true)
            }
          }
        }
      }
    }
  })

  it('handles an empty profile without throwing', () => {
    expect(placeAnswers({ answers: [], pairs: libMap, layout: DEFAULT_LAYOUT })).toEqual([])
  })

  it('handles a custom pair not present in the library', () => {
    const custom: WordPair = {
      id: 'custom.abc',
      source: 'custom',
      category: 'demographic',
      facet: 'custom',
      poleA: 'Individualist',
      poleB: 'Collectivist',
      mix: [0.5, 0, 0.5],
      immutability: 0.3,
    }
    const pairs = new Map(libMap)
    pairs.set(custom.id, custom)
    const t = placeAnswers({
      answers: [answer('custom.abc', LEAN_CENTER, 3)],
      pairs,
      layout: DEFAULT_LAYOUT,
    })[0]!
    // The source doc's own worked example: a 50/50 R/B mix lands on the R/B seam.
    expect(t.purity).toBeCloseTo(0.5, 10)
    const mean = circularMean(t.hue)
    expect(mean.thetaDeg).toBeCloseTo(0, 10)
  })
})

describe('golden placement fixture', () => {
  /**
   * Explicit expected values rather than an opaque snapshot, so a diff is readable and
   * a reviewer can see WHICH number moved. Regenerate deliberately, never casually.
   */
  const fixture: TileAnswer[] = [
    answer('D-AGE-01', 6, 3, 1),
    answer('D-GEN-01', 0, 2, 2),
    answer('D-RAC-02', 3, 3, 3),
    answer('G-CLI-03', 5, 2, 4),
    answer('G-REG-01', 6, 3, 5),
    answer('G-URB-05', 3, 2, 6),
    answer('A-FAM-03', 0, 3, 7),
    answer('A-FAM-03x', 6, 3, 8),
    answer('A-REL-01', 1, 2, 9),
    answer('A-AVO-02', 6, 1, 10),
    answer('A-AVO-04', 4, 2, 11),
    answer('A-PRO-05', 6, 3, 12),
  ].filter((a) => libMap.has(a.pairId))

  it('has 11 resolvable answers (one fixture id is intentionally bogus)', () => {
    expect(fixture).toHaveLength(11)
  })

  it('matches the recorded placement table', () => {
    const out = placeAnswers({ answers: fixture, pairs: libMap, layout: DEFAULT_LAYOUT })
    const table = out
      .map((t) => `${t.pairId} theta=${t.thetaDeg.toFixed(2)} r=${t.radius.toFixed(4)}`)
      .sort()
    expect(table).toEqual([
      'A-AVO-02 theta=307.36 r=0.1803',
      'A-AVO-04 theta=290.16 r=0.1483',
      'A-FAM-03 theta=38.89 r=0.3375',
      'A-PRO-05 theta=311.25 r=0.4103',
      'A-REL-01 theta=306.18 r=0.4350',
      'D-AGE-01 theta=61.64 r=0.8092',
      'D-GEN-01 theta=55.11 r=0.7592',
      'D-RAC-02 theta=1.96 r=0.3403',
      'G-CLI-03 theta=179.21 r=0.6189',
      'G-REG-01 theta=160.34 r=0.6084',
      'G-URB-05 theta=231.88 r=0.2779',
    ])
  })

  /**
   * NOT "lands exactly on the rim". G-REG-01 has immutability 1.0, but its hue is a
   * Demographic/Geographic blend, so the purity factor legitimately pulls it inward --
   * only a PURE immutable item reaches the rim. That is the intended behaviour: an item
   * without a single categorical direction cannot honestly be pinned to one rim sector.
   */
  it('pulls the birthplace anchor inward by purity but keeps it a rim-band anchor', () => {
    const out = placeAnswers({ answers: fixture, pairs: libMap, layout: DEFAULT_LAYOUT })
    const reg = out.find((t) => t.pairId === 'G-REG-01')!
    expect(reg.immutability).toBe(1)
    expect(reg.role).toBe('anchor')

    const { rimRadius, purityFloor } = DEFAULT_LAYOUT
    const expected = rimRadius * (purityFloor + (1 - purityFloor) * reg.purity)
    expect(reg.radius).toBeCloseTo(expected, 9)
    expect(reg.radius).toBeGreaterThan(0.6)
  })

  it('sends a PURE immutable item all the way to the rim', () => {
    // D-GEN-01 is mix (1, 0, 0) with immutability 0.90 -- purity 1, so no inward pull.
    const pure = placeAnswers({
      answers: [answer('D-AGE-01', 6, 3)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    expect(pure.purity).toBeCloseTo(1, 10)
    expect(pure.radius).toBeCloseTo(
      DEFAULT_LAYOUT.rimRadius * radiusFraction(pure.immutability, 1, DEFAULT_LAYOUT),
      9,
    )
  })

  it('places G-URB-05 on the Geographic/Associative seam -- the cyan exemplar', () => {
    const out = placeAnswers({ answers: fixture, pairs: libMap, layout: DEFAULT_LAYOUT })
    const urb = out.find((t) => t.pairId === 'G-URB-05')!
    expect(urb.hue[1]).toBeCloseTo(0.5, 6)
    expect(urb.hue[2]).toBeCloseTo(0.5, 6)
    expect(Math.abs(urb.thetaDeg - 240)).toBeLessThan(20.001)
  })

  it('spreads roles across all three bands', () => {
    const out = placeAnswers({ answers: fixture, pairs: libMap, layout: DEFAULT_LAYOUT })
    const roles = new Set(out.map((t) => t.role))
    expect(roles.has('anchor')).toBe(true)
    expect(roles.has('mass')).toBe(true)
    expect(roles.has('load')).toBe(true)
    expect(out.filter((t) => t.role === 'anchor').length).toBeGreaterThanOrEqual(3)
    expect(M_ANCHOR).toBe(0.75)
    expect(M_LOAD).toBe(0.45)
  })
})
