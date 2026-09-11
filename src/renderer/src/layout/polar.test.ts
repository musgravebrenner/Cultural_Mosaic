import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LAYOUT,
  circularMean,
  effectiveHue,
  hashUnit,
  normalizeMix,
  placeAnswers,
  radiusFraction,
  tileGeometry,
  M_ANCHOR,
  M_LOAD,
} from './polar'
import { ANCHOR_BY_ID, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import type { AnchorAnswer, LeanIndex, StrengthLevel, TileAnswer, WordPair } from '../domain/types'
import { LEAN_CENTER } from '../domain/types'

function answer(
  pairId: string,
  leanIndex: LeanIndex = LEAN_CENTER,
  strength: StrengthLevel = 2,
  addedAt = 0,
): TileAnswer {
  return { answerId: `ans-${pairId}`, pairId, leanIndex, strength, addedAt }
}

function anchorAnswer(anchorId: string, optionId: string, addedAt = 0): AnchorAnswer {
  return { answerId: `anc-${anchorId}`, anchorId, optionId, addedAt }
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
    const p = LIBRARY_BY_ID.get('A-EMP-02')!
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
  // Trimmed to 7 alongside the restructuring to 21 regular pairs -- A-PRO-05 was
  // dropped and A-STA-02 graduated into ANCH-A-02 (a fact, no lean, so it is checked
  // as a placed-anchor property instead; see "associative anchors" below).
  const intent: [string, Channel, 'A' | 'B'][] = [
    ['D-AGE-05', 'dem', 'A'], // age earns standing = ascribed; merit = achieved
    ['D-ETH-03', 'dem', 'A'], // keep ancestral customs distinct = inherited
    ['D-RAC-02', 'dem', 'B'], // interdependent = relational; own unit = the given self
    ['G-REG-01', 'geo', 'A'], // where I was born = purely place; where I chose = elected
    ['A-FAM-01', 'dem', 'B'], // family as unit = collective; individual = the given self
    ['A-FAM-03', 'dem', 'A'], // who I was born to = inherited kin
    ['A-POL-03', 'geo', 'A'], // decide close to home = local/place-bound
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

describe('tileGeometry', () => {
  /**
   * The interaction that silently flattens the whole app if it breaks: a tile narrower
   * than the sensitivity-filter radius is erased by the filter before the optimizer can
   * act on it, and EVERY profile then produces the same art.
   */
  it('never makes a tile narrower than the filter radius, at any resolution', () => {
    const filterRadiusElems = 2.2
    for (const gridSize of [64, 96, 128] as const) {
      const cfg = { ...DEFAULT_LAYOUT, gridSize }
      for (const n of [1, 12, 40, 79, 200, 1000]) {
        expect(tileGeometry(n, cfg).side, `n=${n} grid=${gridSize}`).toBeGreaterThanOrEqual(
          filterRadiusElems,
        )
      }
    }
  })

  it('is uniform, but adapts its size to how many questions were answered', () => {
    const few = tileGeometry(12, DEFAULT_LAYOUT)
    const many = tileGeometry(LIBRARY.length, DEFAULT_LAYOUT)
    expect(few.pitch).toBeGreaterThan(many.pitch)
    expect(few.side).toBeGreaterThan(many.side)
  })

  /**
   * The gutter is load-bearing -- see GUTTER_FRACTION. It has to be real space, not a
   * hairline: at one element the tiles pack edge to edge and there is nowhere in the
   * whole domain for material to span, so the optimizer can only round off corners and
   * the artwork never develops webbing.
   */
  it('leaves a proportional gutter, never thinner than two elements', () => {
    for (const n of [1, 5, 20, 79, 500]) {
      const g = tileGeometry(n, DEFAULT_LAYOUT)
      const gutter = g.pitch - g.side
      expect(gutter, `n=${n} gutter`).toBeGreaterThanOrEqual(2)
      // Wide enough to be a gap rather than a seam, narrow enough that the tile is still
      // the dominant thing in its cell.
      expect(gutter / g.pitch, `n=${n} gutter share`).toBeLessThanOrEqual(0.45)
      expect(g.side, `n=${n} body`).toBeGreaterThan(gutter * 0.9)
    }
  })

  it('is bounded at both ends and never degenerate', () => {
    expect(tileGeometry(1, DEFAULT_LAYOUT).pitch).toBeLessThanOrEqual(14)
    expect(tileGeometry(10_000, DEFAULT_LAYOUT).pitch).toBeGreaterThanOrEqual(5)
    for (const n of [0, 1, 10_000]) {
      const g = tileGeometry(n, DEFAULT_LAYOUT)
      expect(g.pitchN, `n=${n}`).toBeGreaterThan(0)
      expect(g.halfN, `n=${n}`).toBeGreaterThan(0)
      expect(Number.isFinite(g.pitchN)).toBe(true)
    }
  })

  it('reports pitchN and halfN consistently with pitch and side', () => {
    for (const gridSize of [64, 96, 128] as const) {
      const h = 2 / gridSize
      const g = tileGeometry(30, { ...DEFAULT_LAYOUT, gridSize })
      expect(g.pitchN).toBeCloseTo(g.pitch * h, 12)
      expect(g.halfN).toBeCloseTo((g.side * h) / 2, 12)
    }
  })
})

/**
 * The tile lattice.
 *
 * These are the properties the whole visual model rests on: one question is one square
 * tile, every tile the same size, none overlapping any other, each individually
 * hoverable. If any of them breaks, tiles stop being discrete and the picture stops
 * being a mosaic in Chao & Moon's sense.
 */
describe('the tile lattice', () => {
  const profiles: [string, TileAnswer[]][] = [
    ['1', [answer('A-EMP-02', 5, 3, 0)]],
    ['11', LIBRARY.slice(0, 11).map((p, i) => answer(p.id, ((i * 3) % 7) as LeanIndex, 2, i))],
    ['20', LIBRARY.slice(0, 20).map((p, i) => answer(p.id, ((i * 3) % 7) as LeanIndex, 2, i))],
    ['40', LIBRARY.slice(0, 40).map((p, i) => answer(p.id, ((i * 5) % 7) as LeanIndex, 3, i))],
    ['full', LIBRARY.map((p, i) => answer(p.id, ((i * 3) % 7) as LeanIndex, 2, i))],
    [
      'one-sector',
      LIBRARY.filter((p) => p.category === 'associative').map((p, i) => answer(p.id, 4, 2, i)),
    ],
  ]

  it('gives every tile its own cell -- no two tiles ever share one', () => {
    for (const [name, answers] of profiles) {
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      expect(out, name).toHaveLength(answers.length)
      const cells = new Set(out.map((t) => `${t.tileCol},${t.tileRow}`))
      expect(cells.size, `${name}: ${out.length} tiles in ${cells.size} cells`).toBe(out.length)
    }
  })

  /**
   * Separation is EXACTLY one pitch, not merely "enough". Two tiles at adjacent cells
   * are one pitch apart, which is the tile body plus the gutter, so their bodies never
   * touch and the gutter between them always renders as background.
   */
  it('separates every pair of tiles by at least a full lattice pitch', () => {
    for (const [name, answers] of profiles) {
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      if (out.length < 2) continue
      const { pitchN } = tileGeometry(out.length, DEFAULT_LAYOUT)
      let worst = Infinity
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          worst = Math.min(worst, Math.hypot(out[i]!.x - out[j]!.x, out[i]!.y - out[j]!.y))
        }
      }
      expect(worst, `${name}: ${worst.toFixed(5)} vs pitch ${pitchN.toFixed(5)}`).toBeGreaterThan(
        pitchN - 1e-9,
      )
    }
  })

  /**
   * A tile that pokes past the rim gets cut by the domain mask and reads as a fragment
   * rather than as an answer -- so the CENTRE is bounded by the rim less half a tile,
   * which is why `radius` alone is not the thing to check.
   */
  it('keeps every tile body entirely inside the disc', () => {
    for (const [name, answers] of profiles) {
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      for (const t of out) {
        // The corner is the far point of a square, not the edge midpoint.
        expect(t.radius + t.sigma, `${name} ${t.pairId}`).toBeLessThanOrEqual(
          DEFAULT_LAYOUT.rimRadius + 1e-9,
        )
      }
    }
  })

  it('gives every tile in a profile the same size', () => {
    for (const [name, answers] of profiles) {
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      const sizes = new Set(out.map((t) => t.sigma))
      expect(sizes.size, `${name}`).toBe(1)
      expect([...sizes][0], name).toBeCloseTo(tileGeometry(out.length, DEFAULT_LAYOUT).halfN, 12)
    }
  })

  it('reports x,y consistent with the claimed cell, and theta,radius with x,y', () => {
    for (const [name, answers] of profiles) {
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      const { pitchN } = tileGeometry(out.length, DEFAULT_LAYOUT)
      for (const t of out) {
        expect(t.x, `${name} ${t.pairId} x`).toBeCloseTo(t.tileCol * pitchN, 12)
        expect(t.y, `${name} ${t.pairId} y`).toBeCloseTo(t.tileRow * pitchN, 12)
        expect(Math.hypot(t.x, t.y), `${name} ${t.pairId} r`).toBeCloseTo(t.radius, 12)
        if (t.radius > 1e-9) {
          const deg = (((Math.atan2(t.y, t.x) * 180) / Math.PI % 360) + 360) % 360
          expect(t.thetaDeg, `${name} ${t.pairId} theta`).toBeCloseTo(deg, 9)
        }
      }
    }
  })

  it('is deterministic across runs and independent of input order', () => {
    for (const [name, answers] of profiles) {
      const a = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      const b = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      const c = placeAnswers({
        answers: answers.slice().reverse(),
        pairs: libMap,
        layout: DEFAULT_LAYOUT,
      })
      expect(JSON.stringify(a), name).toBe(JSON.stringify(b))
      expect(JSON.stringify(a), `${name} reversed`).toBe(JSON.stringify(c))
    }
  })
})

/**
 * How much polar meaning survives the lattice.
 *
 * This is the honest accounting for the tile model's one real cost. Discrete
 * non-overlapping tiles CANNOT cluster the way overlapping Gaussians could, and answers
 * do cluster: 65 of the 79 library pairs are single-category, so they share one of only
 * three angles, and the fluid traits all want the hub, where cells are scarcest. So some
 * tiles must be displaced, and these tests bound how far -- an unbounded version of this
 * is a picture whose colours and positions disagree, which would make the layout a lie.
 *
 * Bounds recorded from the implementation, with margin. Tightening them is a real
 * improvement; loosening one means the placement got worse and needs a reason.
 */
describe('placement fidelity', () => {
  // Sized for the 21-pair regular library (down from the old 30/79-pair one) -- these
  // are the sample sizes at which the immutability-band-separation test below stays
  // robust; smaller than ~17 and a band can hold too few tiles to be a meaningful mean.
  const sizes = [17, 19, LIBRARY.length]

  /** Mean angular error in degrees, over tiles whose angle is legible at all. */
  function angularError(n: number): { mean: number; worst: number; count: number } {
    const answers = LIBRARY.slice(0, n).map((p, i) => answer(p.id, ((i * 3) % 7) as LeanIndex, 2, i))
    const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    let worst = 0
    let sum = 0
    let count = 0
    for (const t of out) {
      const mean = circularMean(t.hue)
      // Below r = 0.3 the angle is not legible anyway, and a degenerate tile has no true
      // angle to be wrong about.
      if (mean.degenerate || t.radius < 0.3) continue
      let d = Math.abs(t.thetaDeg - mean.thetaDeg)
      if (d > 180) d = 360 - d
      worst = Math.max(worst, d)
      sum += d
      count++
    }
    return { mean: sum / count, worst, count }
  }

  /**
   * Bounds recorded from the implementation with roughly 20-30% margin, per profile
   * size, because the size dependence IS the behaviour: the lattice is coarse when
   * there are few large tiles and fine when there are many small ones. A single flat
   * bound would have to be the worst case and would hide that. Recorded for the
   * 21-pair regular library (down from the old 30/79-pair one).
   */
  it('holds mean angular error inside its recorded bound at every profile size', () => {
    const bounds: [number, number][] = [
      [6, 20],
      [10, 18],
      [14, 19],
      [18, 14],
      [LIBRARY.length, 16],
    ]
    for (const [n, bound] of bounds) {
      const { mean, worst, count } = angularError(n)
      expect(count, `n=${n} sampled`).toBeGreaterThan(n / 3)
      expect(mean, `n=${n} mean ${mean.toFixed(1)} deg`).toBeLessThan(bound)
      // No individual tile in the wrong 120-degree sector, at any size.
      expect(worst, `n=${n} worst ${worst.toFixed(1)} deg`).toBeLessThan(45)
    }
  })

  /** The direction of the trade-off, which is the part worth guaranteeing. */
  it('sharpens as the profile fills in', () => {
    expect(angularError(LIBRARY.length).mean).toBeLessThan(angularError(6).mean)
  })

  /**
   * The radial reading, and the more important of the two: rim means given, hub means
   * chosen. Individual radii shift by up to a cell, but the three immutability BANDS
   * must stay in order and stay visibly apart, or the layout says nothing about fixity.
   *
   * This is the assertion that caught the claim-order bug -- an earlier ring-by-ring
   * search put the fluid traits further out than the anchors (0.618 against 0.616) while
   * every angular metric still looked fine.
   */
  it('keeps the three immutability bands in order and visibly apart', () => {
    for (const n of sizes) {
      const answers = LIBRARY.slice(0, n).map((p, i) =>
        answer(p.id, ((i * 3) % 7) as LeanIndex, 2, i),
      )
      const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
      const mean = (role: string): number => {
        const v = out.filter((t) => t.role === role)
        return v.reduce((acc, t) => acc + t.radius, 0) / v.length
      }
      const [anchor, mass, load] = [mean('anchor'), mean('mass'), mean('load')]
      const msg = `n=${n}: ${anchor.toFixed(3)} / ${mass.toFixed(3)} / ${load.toFixed(3)}`
      expect(anchor, msg).toBeGreaterThan(mass)
      expect(mass, msg).toBeGreaterThan(load)
      expect(anchor - load, `${msg} spread`).toBeGreaterThan(0.2)
    }
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
        answer('A-EMP-02', 5, 3),
        answer('A-POL-03', 5, 0), // Dormant -- kept in the document, contributes nothing
        answer('NOT-A-REAL-ID', 5, 3),
      ],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })
    expect(out.map((t) => t.pairId)).toEqual(['A-EMP-02'])
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
      answers: [answer('A-EMP-02', LEAN_CENTER, 3)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    const committedMinor = placeAnswers({
      answers: [answer('A-EMP-02', 6, 1)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!

    expect(balancedCore.polarity).toBe(0)
    expect(balancedCore.amplitude).toBe(1.0)
    expect(committedMinor.polarity).toBe(1)
    expect(committedMinor.amplitude).toBeCloseTo(0.33, 6)
    // Balanced-and-strong must deposit MORE than committed-and-weak.
    expect(balancedCore.amplitude).toBeGreaterThan(committedMinor.amplitude)
    // ...and it must show that as COLOUR, not as area. Deposit width used to vary with
    // |lean| and immutability, which meant conviction was encoded twice and a balanced
    // answer read as a vague smear; now every tile is the same square and only the
    // saturation differs, so each answer stays a discrete, comparable, hoverable unit.
    expect(balancedCore.sigma).toBe(committedMinor.sigma)
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
   * The crowding regression. Most of the (distilled, 30-pair) library is
   * single-category, so a user who answers many Associative pairs would otherwise get
   * them all stacked near 300 deg. The lattice makes this exact rather than
   * statistical: they cannot stack at all, because no two tiles can hold the same cell.
   *
   * Built from SYNTHETIC pairs rather than sliced from LIBRARY, because the
   * distillation to 30 pairs left only 15 real associative ones -- fewer than this test
   * wants to throw at the crowding mechanism, and the mechanism does not care whether a
   * pair is authored or invented.
   */
  it('separates 20 same-category answers by a full lattice pitch', () => {
    const synthetic: WordPair[] = Array.from({ length: 20 }, (_, i) => ({
      id: `synthetic-assoc-${i}`,
      source: 'custom',
      category: 'associative',
      facet: 'custom',
      poleA: `A${i}`,
      poleB: `B${i}`,
      mix: [0, 0, 1],
      immutability: 0.4,
    }))
    const pairs = new Map(libMap)
    for (const p of synthetic) pairs.set(p.id, p)
    const out = placeAnswers({
      answers: synthetic.map((p, i) => answer(p.id, 4, 2, i)),
      pairs,
      layout: DEFAULT_LAYOUT,
    })
    expect(out).toHaveLength(20)

    const { pitchN } = tileGeometry(out.length, DEFAULT_LAYOUT)
    let worst = Infinity
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!
        const b = out[j]!
        worst = Math.min(worst, Math.hypot(a.x - b.x, a.y - b.y))
      }
    }
    expect(worst).toBeGreaterThan(pitchN - 1e-9)
    // Which is also comfortably clear of the coincident-node stress singularity the old
    // relaxation pass could only approach.
    expect(worst).toBeGreaterThan((2 * 2.0) / DEFAULT_LAYOUT.gridSize)
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
   *
   * Every angle here is a multiple of 45 deg and every radius a lattice distance,
   * because with only eleven answers the tiles are large and the lattice correspondingly
   * coarse. That is the tile model's visible cost at small profile sizes; `placement
   * fidelity` above bounds it, and it tightens steadily as more questions are answered.
   */
  const fixture: TileAnswer[] = [
    answer('D-AGE-01', 6, 3, 1),
    answer('D-GEN-01', 0, 2, 2),
    answer('D-RAC-02', 3, 3, 3),
    answer('G-CLI-01', 5, 2, 4),
    answer('G-REG-01', 6, 3, 5),
    answer('G-URB-05', 3, 2, 6),
    answer('A-FAM-03', 0, 3, 7),
    answer('A-FAM-03x', 6, 3, 8),
    answer('A-EMP-02', 1, 2, 9),
    answer('A-AVO-02', 6, 1, 10),
    answer('A-AVO-04', 4, 2, 11),
    answer('A-POL-03', 6, 3, 12),
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
      'A-AVO-02 theta=0.00 r=0.0000',
      'A-AVO-04 theta=270.00 r=0.2917',
      'A-EMP-02 theta=315.00 r=0.4125',
      'A-FAM-03 theta=45.00 r=0.4125',
      'A-POL-03 theta=270.00 r=0.5833',
      'D-AGE-01 theta=63.43 r=0.6522',
      'D-GEN-01 theta=90.00 r=0.5833',
      'D-RAC-02 theta=0.00 r=0.2917',
      'G-CLI-01 theta=180.00 r=0.5833',
      'G-REG-01 theta=153.43 r=0.6522',
      'G-URB-05 theta=225.00 r=0.4125',
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

    // The purity pull is asserted on the IDEAL radius, which is the formula's own output;
    // the tile then claims the nearest affordable lattice cell to it. Asserting the
    // snapped radius against the formula would be asserting the lattice, not the
    // semantics -- and it is the semantics that has to be right.
    const { rimRadius, purityFloor } = DEFAULT_LAYOUT
    const ideal = rimRadius * (purityFloor + (1 - purityFloor) * reg.purity)
    expect(ideal).toBeLessThan(rimRadius)
    expect(Math.abs(reg.radius - ideal), `snapped ${reg.radius} vs ideal ${ideal}`).toBeLessThan(
      tileGeometry(out.length, DEFAULT_LAYOUT).pitchN,
    )
    expect(reg.radius).toBeGreaterThan(0.6)
  })

  it('keeps a PURE immutable item in the outermost band the lattice affords', () => {
    // D-AGE-01 is mix (1, 0, 0) with immutability 0.95 -- purity 1, so no inward pull at
    // all, and its ideal radius is limited only by the requirement that the tile body fit
    // inside the disc.
    const answers = [answer('D-AGE-01', 6, 3), ...LIBRARY.slice(1, 12).map((p, i) => answer(p.id, 3, 2, i + 1))]
    const out = placeAnswers({ answers, pairs: libMap, layout: DEFAULT_LAYOUT })
    const pure = out.find((t) => t.pairId === 'D-AGE-01')!
    const geom = tileGeometry(out.length, DEFAULT_LAYOUT)
    expect(pure.purity).toBeCloseTo(1, 10)

    const ideal = Math.min(
      DEFAULT_LAYOUT.rimRadius * radiusFraction(pure.immutability, 1, DEFAULT_LAYOUT),
      DEFAULT_LAYOUT.rimRadius - geom.halfN,
    )
    expect(Math.abs(pure.radius - ideal)).toBeLessThan(geom.pitchN)
    // ...and nothing in the profile is further out than it.
    expect(pure.radius).toBe(Math.max(...out.map((t) => t.radius)))
  })

  it('places G-URB-05 on the Geographic/Associative seam -- the cyan exemplar', () => {
    const out = placeAnswers({ answers: fixture, pairs: libMap, layout: DEFAULT_LAYOUT })
    const urb = out.find((t) => t.pairId === 'G-URB-05')!
    // The HUE is exact -- it is the authored mix and the lattice cannot touch it.
    expect(urb.hue[1]).toBeCloseTo(0.5, 6)
    expect(urb.hue[2]).toBeCloseTo(0.5, 6)
    // The angle is within one lattice step of the 240 deg seam. At eleven answers a step
    // is 45 deg, which is the coarsest the lattice ever gets; see `placement fidelity`.
    let d = Math.abs(urb.thetaDeg - 240)
    if (d > 180) d = 360 - d
    expect(d, `theta ${urb.thetaDeg}`).toBeLessThanOrEqual(45.001)
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

/**
 * The Associative rim, now carried entirely by ANCHORS rather than by a handful of
 * spectrum-shaped stand-ins.
 *
 * Chao & Moon define the associative category by ongoing choice, so a library built only
 * from Table 1's associative tiles has nothing permanent in it -- and since radius comes
 * from immutability, that whole third of the disc could never reach the rim. Every load
 * path had to terminate on the Demographic or Geographic arc, which forced one
 * morphology on everybody. These check the fix end to end: through the real anchor
 * placement path (`anchorAnswers` + `anchors`), not just the library data.
 */
describe('associative anchors', () => {
  const ids = ['ANCH-A-01', 'ANCH-A-02', 'ANCH-A-03', 'ANCH-A-04', 'ANCH-A-05']
  const optionFor: Readonly<Record<string, string>> = {
    'ANCH-A-01': 'raised',
    'ANCH-A-02': 'other-citizen',
    'ANCH-A-03': 'broken',
    'ANCH-A-04': 'joined',
    'ANCH-A-05': 'employed',
  }
  const anchors = new Map(ids.map((id) => [id, ANCHOR_BY_ID.get(id)!]))

  /**
   * Only two of the five clear the rim-anchor threshold (raising a child and holding a
   * second citizenship) -- the other three (a healed injury, formal religious
   * membership, having once been employed) are genuine, permanent facts but not
   * powerful enough to pin the rim, and correctly sit in the mass band instead. That is
   * a deliberate content choice, not a shortfall: unlike the old stand-in pairs (which
   * were ALL authored above 0.75 specifically to prove the rim was reachable), these
   * anchors are free to have the immutability their content actually earns.
   */
  it('places at least two in the anchor band', () => {
    const out = placeAnswers({
      answers: [],
      pairs: new Map(),
      anchorAnswers: ids.map((id, k) => anchorAnswer(id, optionFor[id]!, k)),
      anchors,
      layout: DEFAULT_LAYOUT,
    })
    expect(out).toHaveLength(ids.length)
    const anchored = out.filter((t) => t.role === 'anchor')
    expect(anchored.length, 'associative anchors').toBeGreaterThanOrEqual(2)
  })

  /**
   * ...and in the ASSOCIATIVE sector, not merely somewhere. A high-immutability anchor
   * whose hue is a blend anchors a different arc, which would not fix anything.
   */
  it('puts a pure one on the associative arc', () => {
    const t = placeAnswers({
      answers: [],
      pairs: new Map(),
      anchorAnswers: [anchorAnswer('ANCH-A-01', 'raised', 0)],
      anchors: new Map([['ANCH-A-01', ANCHOR_BY_ID.get('ANCH-A-01')!]]),
      layout: DEFAULT_LAYOUT,
    })[0]!
    expect(t.role).toBe('anchor')
    expect(t.hue[2], 'purely associative').toBeCloseTo(1, 6)
    expect(t.purity).toBeCloseTo(1, 6)
    // Associative's sector centre is 300 deg; one lattice step of tolerance.
    let d = Math.abs(t.thetaDeg - 300)
    if (d > 180) d = 360 - d
    expect(d, `theta ${t.thetaDeg.toFixed(1)}`).toBeLessThanOrEqual(46)
  })

  /** The citizenship anchor is deliberately BOTH geographic and associative. */
  it('places citizenship between the geographic and associative sectors', () => {
    const t = placeAnswers({
      answers: [],
      pairs: new Map(),
      anchorAnswers: [anchorAnswer('ANCH-A-02', 'one-citizen', 0)],
      anchors: new Map([['ANCH-A-02', ANCHOR_BY_ID.get('ANCH-A-02')!]]),
      layout: DEFAULT_LAYOUT,
    })[0]!
    const mean = circularMean(t.hue)
    // 240 deg is the Geographic/Associative seam -- the "Localized Communities" reading.
    let d = Math.abs(mean.thetaDeg - 240)
    if (d > 180) d = 360 - d
    expect(d, `ideal theta ${mean.thetaDeg.toFixed(1)}`).toBeLessThan(25)
    expect(t.hue[0], 'no demographic component').toBeCloseTo(0, 6)
    expect(t.role).toBe('anchor')
  })

  /**
   * The reversible/irreversible contrast this whole mechanism exists to draw: not
   * every pair in a facet that CAN reach the rim actually does. D-AGE-05 (a regular
   * spectrum pair, immutability 0.50) stands in as a well-below-M_ANCHOR example from
   * the same Demographic category that produces the library's strongest anchors.
   */
  it('does not anchor every pair, even in facets that can reach the rim', () => {
    const t = placeAnswers({
      answers: [answer('D-AGE-05', 6, 3, 0)],
      pairs: libMap,
      layout: DEFAULT_LAYOUT,
    })[0]!
    expect(t.role).not.toBe('anchor')
    expect(t.immutability).toBeLessThan(M_ANCHOR)
  })
})
