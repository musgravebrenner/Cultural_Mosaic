import { describe, it, expect } from 'vitest'
import { rankConflicts, rankBonds } from './interference'
import { createGrid, createFields, buildFields, FIELD_CONSTANTS } from './fields'
import { DEFAULT_LAYOUT, placeAnswers } from './polar'
import { ANTAGONISMS, LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex, StrengthLevel, TileAnswer } from '../domain/types'

const N = 64
const LAYOUT = { ...DEFAULT_LAYOUT, gridSize: N as 64 }
const GRID = createGrid(N, DEFAULT_LAYOUT.rimRadius)

function ans(pairId: string, leanIndex: LeanIndex, strength: StrengthLevel, k: number): TileAnswer {
  return { answerId: `a-${pairId}`, pairId, leanIndex, strength, addedAt: k }
}

/** A-EMP-02 poleA vs A-PRO-01 poleA, weight 0.30 -- the antagonism fields.test.ts uses. */
const CONFLICT = ANTAGONISMS.find((a) => a.a === 'A-EMP-02' && a.b === 'A-PRO-01')!

describe('rankConflicts', () => {
  it('reports nothing when no antagonism is engaged', () => {
    const answers = [ans('A-EMP-02', 6, 3, 0), ans('A-PRO-01', 6, 3, 1)] // both poleB
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3, antagonisms: ANTAGONISMS })
    // "final" == seed here; the point is purely about engagement, not the solve.
    const out = rankConflicts(tiles, ANTAGONISMS, GRID, f.provenance, f.rho0)
    expect(out).toEqual([])
  })

  it('reports an engaged antagonism with both survival ratios and a positive loss', () => {
    const answers = [ans('A-EMP-02', 0, 3, 0), ans('A-PRO-01', 0, 3, 1)] // both poleA: engaged
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3, antagonisms: ANTAGONISMS })

    // Simulate a run that ate half of each tile's own material.
    const final = new Float32Array(f.rho0)
    for (const i of GRID.designList) if (f.provenance[i]! >= 0) final[i] = final[i]! * 0.5

    const out = rankConflicts(tiles, ANTAGONISMS, GRID, f.provenance, final)
    const entry = out.find((e) => e.weight === CONFLICT.weight && e.why === CONFLICT.why)
    expect(entry, 'conflict entry present').toBeDefined()
    expect(entry!.survivalA).toBeCloseTo(0.5, 6)
    expect(entry!.survivalB).toBeCloseTo(0.5, 6)
    expect(entry!.loss).toBeCloseTo(1.0, 6)
    // The two tiles named are the two answered pairs, in either order.
    const ids = [entry!.a.pairId, entry!.b.pairId].sort()
    expect(ids).toEqual(['A-EMP-02', 'A-PRO-01'])
  })

  it('only fires when BOTH tense poles are actually leaned into', () => {
    // A-EMP-02 poleA (engaged side), A-PRO-01 poleB (the compatible side) -- holding the
    // compatible pole of a contested pair is not a conflict.
    const answers = [ans('A-EMP-02', 0, 3, 0), ans('A-PRO-01', 6, 3, 1)]
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3, antagonisms: ANTAGONISMS })
    const out = rankConflicts(tiles, ANTAGONISMS, GRID, f.provenance, f.rho0)
    expect(out.find((e) => e.a.pairId === 'A-EMP-02' || e.b.pairId === 'A-EMP-02')).toBeUndefined()
  })

  it('skips an antagonism whose pair was not answered', () => {
    const answers = [ans('A-EMP-02', 0, 3, 0)]
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3, antagonisms: ANTAGONISMS })
    expect(rankConflicts(tiles, ANTAGONISMS, GRID, f.provenance, f.rho0)).toEqual([])
  })

  it('ranks worse-survival conflicts first and respects the limit', () => {
    // Two independent engaged conflicts among the library's surviving antagonisms:
    // A-EMP-02 x A-PRO-01 (weight 0.30) and D-ETH-01 x D-ETH-03 (weight 0.40).
    const answers = [
      ans('A-EMP-02', 0, 3, 0),
      ans('A-PRO-01', 0, 3, 1),
      ans('D-ETH-01', 0, 3, 2),
      ans('D-ETH-03', 6, 3, 3),
    ]
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3, antagonisms: ANTAGONISMS })

    const final = new Float32Array(f.rho0)
    const idxOf = (id: string): number => tiles.findIndex((t) => t.pairId === id)
    // Eat A-EMP-02/A-PRO-01 down to 20% survival, D-ETH pair only down to 90%.
    for (const i of GRID.designList) {
      if (f.provenance[i] === idxOf('A-EMP-02') || f.provenance[i] === idxOf('A-PRO-01')) {
        final[i] = final[i]! * 0.2
      } else if (f.provenance[i] === idxOf('D-ETH-01') || f.provenance[i] === idxOf('D-ETH-03')) {
        final[i] = final[i]! * 0.9
      }
    }

    const out = rankConflicts(tiles, ANTAGONISMS, GRID, f.provenance, final, 1)
    expect(out).toHaveLength(1)
    const ids = [out[0]!.a.pairId, out[0]!.b.pairId].sort()
    expect(ids).toEqual(['A-EMP-02', 'A-PRO-01'])
  })
})

describe('rankBonds', () => {
  it('reports zero growth when the final frame equals the seed', () => {
    const answers = [ans('D-AGE-01', 5, 3, 0), ans('D-ETH-01', 1, 3, 1), ans('D-GEN-01', 2, 2, 2)]
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3 })
    const out = rankBonds(tiles, GRID, f.provenance, f.rho0, f.rho0)
    for (const e of out) expect(e.growth).toBeCloseTo(0, 6)
  })

  it('detects growth the solver built in the gutter between two neighbours', () => {
    const answers = [ans('D-AGE-01', 5, 3, 0), ans('D-ETH-01', 1, 3, 1), ans('D-GEN-01', 2, 2, 2)]
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3 })

    // Only lattice-adjacent pairs are candidates; pick one and fill its whole disc with
    // solid material to guarantee the gutter between it and every neighbour is solid.
    const final = new Float32Array(GRID.count)
    for (const i of GRID.designList) final[i] = 1

    const out = rankBonds(tiles, GRID, f.provenance, f.rho0, final)
    expect(out.length).toBeGreaterThan(0)
    for (const e of out) {
      expect(e.finalDensity).toBeCloseTo(1, 6)
      expect(e.growth).toBeGreaterThan(0)
      expect(e.seedDensity).toBeCloseTo(FIELD_CONSTANTS.RHO_FLOOR, 6)
    }
    // Sorted descending.
    for (let i = 1; i < out.length; i++) expect(out[i - 1]!.growth).toBeGreaterThanOrEqual(out[i]!.growth)
  })

  it('never reports the same unordered pair twice, and never a tile against itself', () => {
    const answers = Array.from({ length: 12 }, (_, i) =>
      ans(['D-AGE-01', 'D-ETH-01', 'D-GEN-01', 'D-RAC-02', 'G-CLI-01', 'D-RAC-03', 'G-TMP-01',
           'G-CST-01', 'G-URB-01', 'G-URB-05', 'G-REG-01', 'G-REG-06'][i]!, (i % 7) as LeanIndex, 2, i),
    )
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3 })
    const final = new Float32Array(GRID.count)
    for (const i of GRID.designList) final[i] = 1
    const out = rankBonds(tiles, GRID, f.provenance, f.rho0, final, 1000)
    const seen = new Set<string>()
    for (const e of out) {
      expect(e.a.answerId).not.toBe(e.b.answerId)
      const key = [e.a.answerId, e.b.answerId].sort().join('|')
      expect(seen.has(key), `duplicate pair ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('restricts to lattice-adjacent pairs -- distant tiles never appear', () => {
    const answers = Array.from({ length: 12 }, (_, i) =>
      ans(['D-AGE-01', 'D-ETH-01', 'D-GEN-01', 'D-RAC-02', 'G-CLI-01', 'D-RAC-03', 'G-TMP-01',
           'G-CST-01', 'G-URB-01', 'G-URB-05', 'G-REG-01', 'G-REG-06'][i]!, (i % 7) as LeanIndex, 2, i),
    )
    const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3 })
    const final = new Float32Array(GRID.count)
    for (const i of GRID.designList) final[i] = 1
    const out = rankBonds(tiles, GRID, f.provenance, f.rho0, final, 1000)
    for (const e of out) {
      expect(Math.abs(e.a.tileCol - e.b.tileCol)).toBeLessThanOrEqual(1)
      expect(Math.abs(e.a.tileRow - e.b.tileRow)).toBeLessThanOrEqual(1)
    }
  })

  it('handles a single tile without throwing', () => {
    const tiles = placeAnswers({
      answers: [ans('D-AGE-01', 5, 3, 0)],
      pairs: LIBRARY_BY_ID,
      layout: LAYOUT,
    })
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 0.3 })
    expect(rankBonds(tiles, GRID, f.provenance, f.rho0, f.rho0)).toEqual([])
  })
})
