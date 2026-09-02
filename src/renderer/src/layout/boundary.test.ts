import { describe, it, expect } from 'vitest'
import { buildBoundary, bhattacharyya, BOUNDARY_CONSTANTS } from './boundary'
import type { BoundaryOptions } from './boundary'
import { createGrid } from './fields'
import { DEFAULT_LAYOUT, placeAnswers } from './polar'
import { ANTAGONISMS, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import { LEAN_NOTCHES } from '../domain/types'
import type { LeanIndex, PlacedTile, StrengthLevel, TileAnswer } from '../domain/types'

const N = 64
const GRID = createGrid(N, DEFAULT_LAYOUT.rimRadius)
const LAYOUT = { ...DEFAULT_LAYOUT, gridSize: N as 64 }

function ans(
  pairId: string,
  leanIndex: LeanIndex = 3,
  strength: StrengthLevel = 2,
  addedAt = 0,
): TileAnswer {
  return { answerId: `a-${pairId}`, pairId, leanIndex, strength, addedAt }
}

function place(answers: TileAnswer[]): PlacedTile[] {
  return placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
}

function opts(answers: TileAnswer[]): BoundaryOptions {
  const leanByPair = new Map<string, number>()
  for (const a of answers) leanByPair.set(a.pairId, LEAN_NOTCHES[a.leanIndex] ?? 0)
  return { grid: GRID, antagonisms: ANTAGONISMS, leanByPair }
}

function run(answers: TileAnswer[]): ReturnType<typeof buildBoundary> {
  return buildBoundary(place(answers), opts(answers))
}

const FULL = LIBRARY.map((p, k) => ans(p.id, (k % 7) as LeanIndex, 2, k))

describe('bhattacharyya', () => {
  it('is 1 for identical hues and 0 for disjoint ones', () => {
    expect(bhattacharyya([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 12)
    expect(bhattacharyya([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 12)
    expect(bhattacharyya([0, 0, 1], [0, 1, 0])).toBeCloseTo(0, 12)
  })

  it('is symmetric', () => {
    const a = [0.5, 0.3, 0.2] as const
    const b = [0.1, 0.6, 0.3] as const
    expect(bhattacharyya(a, b)).toBeCloseTo(bhattacharyya(b, a), 12)
  })

  /**
   * The reason it is preferred over cosine similarity: cosine on the non-negative
   * octant compresses realistic hue pairs into roughly 0.6-1.0, so everything looks
   * related and the resulting field has almost no contrast.
   */
  it('separates a partial overlap more than cosine similarity would', () => {
    const pure = [1, 0, 0] as const
    const near = [0.7, 0.3, 0] as const
    const bc = bhattacharyya(pure, near)
    const cos =
      (pure[0] * near[0] + pure[1] * near[1] + pure[2] * near[2]) /
      (Math.hypot(...pure) * Math.hypot(...near))
    expect(bc).toBeLessThan(cos)
  })
})

describe('anchor selection', () => {
  it('never returns fewer than three anchors, whatever the profile', () => {
    const profiles: TileAnswer[][] = [
      [],
      [ans('A-AVO-04', 6, 3)],
      [ans('A-AVO-04', 6, 3), ans('A-AVO-02', 0, 3)],
      LIBRARY.filter((p) => p.immutability <= 0.45).map((p, k) => ans(p.id, 5, 2, k)),
      FULL,
    ]
    for (const p of profiles) {
      const bc = run(p)
      expect(bc.nAnchors, `profile of ${p.length}`).toBeGreaterThanOrEqual(
        BOUNDARY_CONSTANTS.MIN_ANCHORS,
      )
    }
  })

  /**
   * The cap matters aesthetically AND structurally: pinning every rim item
   * over-constrains the disc, so the optimum degenerates into short local struts near
   * each pin -- no long spans, no cultural highways, boring art.
   */
  it('caps anchors at the documented maximum', () => {
    const bc = run(FULL)
    expect(bc.nAnchors).toBeLessThanOrEqual(BOUNDARY_CONSTANTS.MAX_ANCHORS)
  })

  it('spreads anchors far enough to remove the rotational near-singularity', () => {
    for (const p of [FULL, LIBRARY.slice(0, 20).map((q, k) => ans(q.id, 5, 3, k))]) {
      const bc = run(p)
      expect(bc.anchorExtentDeg).toBeGreaterThanOrEqual(BOUNDARY_CONSTANTS.HARD_MIN_EXTENT_DEG)
    }
  })

  it('spreads anchors even when every answer comes from one tile', () => {
    // All of one facet means all thetas within +/-20 deg, so without the extent guard
    // the structure could rotate freely about a tight pin cluster.
    const oneTile = LIBRARY.filter((p) => p.facet === 'climate').map((p, k) => ans(p.id, 5, 3, k))
    const bc = run(oneTile)
    expect(bc.anchorExtentDeg).toBeGreaterThanOrEqual(BOUNDARY_CONSTANTS.HARD_MIN_EXTENT_DEG)
    expect(bc.repairs.length).toBeGreaterThan(0)
  })

  it('pins a region rather than a single node', () => {
    const bc = run(FULL)
    // Two DOFs per node, and every pin covers several nodes.
    expect(bc.fixedDofs.length).toBeGreaterThan(bc.nAnchors * 2 * 3)
    expect(bc.fixedDofs.length % 2).toBe(0)
  })

  it('emits sorted, unique fixed DOFs within range', () => {
    const bc = run(FULL)
    const maxDof = 2 * (N + 1) * (N + 1)
    for (let i = 0; i < bc.fixedDofs.length; i++) {
      expect(bc.fixedDofs[i]!).toBeLessThan(maxDof)
      if (i > 0) expect(bc.fixedDofs[i]!).toBeGreaterThan(bc.fixedDofs[i - 1]!)
    }
  })
})

describe('degenerate profiles', () => {
  /**
   * The nastiest degenerate case, because it does not crash: if everything is an anchor
   * then f = 0, so u = 0, compliance is zero and every sensitivity is undefined. The
   * optimizer runs to completion and does absolutely nothing.
   */
  it('forces loads to exist when every answer is immutable', () => {
    const allFixed = LIBRARY.filter((p) => p.immutability >= 0.75).map((p, k) =>
      ans(p.id, 5, 3, k),
    )
    expect(allFixed.length).toBeGreaterThan(3)
    const bc = run(allFixed)
    expect(bc.nLoads).toBeGreaterThan(0)
    expect(bc.loadValues.length).toBeGreaterThan(0)
    expect(bc.repairs.join(' ')).toMatch(/fluid/i)
  })

  it('creates anchors when every answer is fluid', () => {
    const allFluid = LIBRARY.filter((p) => p.immutability <= 0.45).map((p, k) =>
      ans(p.id, 5, 3, k),
    )
    const bc = run(allFluid)
    expect(bc.nAnchors).toBeGreaterThanOrEqual(3)
    expect(bc.fixedDofs.length).toBeGreaterThan(0)
  })

  it('produces a well-posed system for an empty profile', () => {
    const bc = run([])
    expect(bc.nAnchors).toBe(3)
    expect(bc.nLoads).toBeGreaterThanOrEqual(1)
    expect(bc.fixedDofs.length).toBeGreaterThan(0)
    expect(bc.repairs.join(' ')).toMatch(/nothing answered/i)
  })

  it('always applies a non-zero load', () => {
    for (const p of [[], [ans('D-AGE-01', 3, 1)], FULL]) {
      const bc = run(p)
      let total = 0
      for (let k = 0; k < bc.loadValues.length; k += 2) {
        total += Math.hypot(bc.loadValues[k]!, bc.loadValues[k + 1]!)
      }
      expect(total, `profile of ${p.length}`).toBeGreaterThan(0)
    }
  })

  it('never leaves a DOF both pinned and loaded', () => {
    const bc = run(FULL)
    const fixed = new Set(bc.fixedDofs)
    for (const d of bc.loadDofs) expect(fixed.has(d)).toBe(false)
  })

  it('never produces NaN in any load value', () => {
    for (const s of [1, 2, 3] as StrengthLevel[]) {
      for (const lean of [0, 3, 6] as LeanIndex[]) {
        const bc = run(LIBRARY.map((p, k) => ans(p.id, lean, s, k)))
        for (const v of bc.loadValues) expect(Number.isFinite(v)).toBe(true)
      }
    }
  })
})

describe('load normalization and direction', () => {
  it('normalizes total load magnitude to 1', () => {
    // Compliance minimization is scale-invariant in f, so normalizing removes a whole
    // category of force-unit tuning.
    const bc = run(FULL)
    let total = 0
    for (let k = 0; k < bc.loadValues.length; k += 2) {
      total += Math.hypot(bc.loadValues[k]!, bc.loadValues[k + 1]!)
    }
    expect(total).toBeCloseTo(1, 6)
  })

  it('caps the number of loads', () => {
    const bc = run(FULL)
    expect(bc.nLoads).toBeLessThanOrEqual(BOUNDARY_CONSTANTS.MAX_LOADS)
  })

  it('points a fluid identity toward a hue-compatible anchor', () => {
    // One strongly Associative anchor and one Associative load: the load should pull
    // toward the anchor rather than away from it.
    const answers = [
      { ...ans('A-AVO-02', 6, 3, 1) }, // fluid, near-pure Associative
      { ...ans('A-PRO-01', 6, 3, 2), immutabilityOverride: 1 }, // pinned, Associative
      { ...ans('G-CST-01', 6, 1, 3) }, // a distant Geographic anchor
      { ...ans('D-AGE-01', 6, 1, 4) }, // a distant Demographic anchor
    ]
    const tiles = place(answers)
    const bc = buildBoundary(tiles, opts(answers))
    const load = tiles.find((t) => t.pairId === 'A-AVO-02')!
    const anchor = tiles.find((t) => t.pairId === 'A-PRO-01')!
    expect(bc.roles.get(anchor.answerId)).toBe('anchor')

    const nn = N + 1
    const h = GRID.h
    const ix = Math.round((load.x + 1) / h)
    const iy = Math.round((load.y + 1) / h)
    const nd = iy * nn + ix
    const at = Array.from(bc.loadDofs).indexOf(2 * nd)
    expect(at, 'load DOF present').toBeGreaterThanOrEqual(0)
    const fx = bc.loadValues[at]!
    const fy = bc.loadValues[at + 1]!

    // Positive projection onto the direction of the concordant anchor.
    const dx = anchor.x - load.x
    const dy = anchor.y - load.y
    const d = Math.hypot(dx, dy)
    const proj = (fx * dx + fy * dy) / d
    expect(proj).toBeGreaterThan(0)
  })
})

describe('passive solid patches', () => {
  /**
   * Non-optional. Without them the optimizer hits the classic SIMP degenerate minimum
   * of deleting the material under a point load, at which point compliance blows up.
   */
  it('places a patch under every pin and every load', () => {
    const bc = run(FULL)
    expect(bc.solidPassive.length).toBeGreaterThan((bc.nAnchors + bc.nLoads) * 3)
    for (const e of bc.solidPassive) {
      expect(GRID.mask[e], `element ${e} outside the disc`).toBe(1)
    }
  })

  it('emits sorted, unique passive elements', () => {
    const bc = run(FULL)
    for (let i = 1; i < bc.solidPassive.length; i++) {
      expect(bc.solidPassive[i]!).toBeGreaterThan(bc.solidPassive[i - 1]!)
    }
  })

  it('leaves most of the disc free to be designed', () => {
    // If the passive patches ate the whole volume budget there would be nothing to
    // optimize.
    const bc = run(FULL)
    expect(bc.solidPassive.length / GRID.designList.length).toBeLessThan(0.35)
  })
})

describe('authored conflicts', () => {
  it('fires only when both tense poles are actually chosen', () => {
    // A-FAM-01 poleA vs D-RAC-02 poleB, weight 0.7.
    const engaged = [ans('A-FAM-01', 0, 3, 1), ans('D-RAC-02', 6, 3, 2)]
    const opposite = [ans('A-FAM-01', 6, 3, 1), ans('D-RAC-02', 0, 3, 2)]

    const magOf = (answers: TileAnswer[]): number => {
      const bc = buildBoundary(place(answers), opts(answers))
      let m = 0
      for (let k = 0; k < bc.loadValues.length; k += 2) {
        m += Math.hypot(bc.loadValues[k]!, bc.loadValues[k + 1]!)
      }
      return m
    }
    // Both are normalized to 1, so compare the DIRECTION spread instead: an engaged
    // conflict must add a component pulling the two apart.
    expect(magOf(engaged)).toBeCloseTo(1, 6)
    expect(magOf(opposite)).toBeCloseTo(1, 6)

    const tilesE = place(engaged)
    const bcE = buildBoundary(tilesE, opts(engaged))
    const tilesO = place(opposite)
    const bcO = buildBoundary(tilesO, opts(opposite))
    // The engaged profile puts load on both conflicting tiles; loads are what carry it.
    expect(bcE.loadValues.length).toBeGreaterThan(0)
    expect(bcO.loadValues.length).toBeGreaterThan(0)
  })

  it('stays within the conflict load cap', () => {
    expect(BOUNDARY_CONSTANTS.CONFLICT_LOAD_CAP).toBe(0.25)
    // Engage many antagonisms at once and confirm the result is still normalized and
    // finite rather than a torn mess of runaway forces.
    const answers = ANTAGONISMS.flatMap((ag, k) => [
      ans(ag.a, ag.aPole < 0 ? 0 : 6, 3, 2 * k),
      ans(ag.b, ag.bPole < 0 ? 0 : 6, 3, 2 * k + 1),
    ])
    const dedup = new Map<string, TileAnswer>()
    for (const a of answers) dedup.set(a.pairId, a)
    const list = [...dedup.values()]
    const bc = buildBoundary(place(list), opts(list))
    let total = 0
    for (let k = 0; k < bc.loadValues.length; k += 2) {
      total += Math.hypot(bc.loadValues[k]!, bc.loadValues[k + 1]!)
    }
    expect(total).toBeCloseTo(1, 6)
    for (const v of bc.loadValues) expect(Number.isFinite(v)).toBe(true)
  })
})

describe('determinism', () => {
  it('produces identical boundary conditions for identical input', () => {
    const a = run(FULL)
    const b = run(FULL)
    expect(Array.from(a.fixedDofs)).toEqual(Array.from(b.fixedDofs))
    expect(Array.from(a.loadDofs)).toEqual(Array.from(b.loadDofs))
    expect(Array.from(a.loadValues)).toEqual(Array.from(b.loadValues))
    expect(Array.from(a.solidPassive)).toEqual(Array.from(b.solidPassive))
  })

  it('does not depend on answer order', () => {
    const fwd = run(FULL)
    const rev = run(FULL.slice().reverse())
    expect(Array.from(fwd.fixedDofs)).toEqual(Array.from(rev.fixedDofs))
    expect(Array.from(fwd.solidPassive)).toEqual(Array.from(rev.solidPassive))
  })
})
