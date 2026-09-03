import { describe, it, expect } from 'vitest'
import { Optimizer } from './kernel/optimizer'
import { FREE, SOLID_PASSIVE, VOID_PASSIVE } from './protocol'
import { DEFAULT_LAYOUT, placeAnswers } from '../layout/polar'
import { buildFields, createFields, createGrid, deriveVolumeFraction } from '../layout/fields'
import { buildBoundary } from '../layout/boundary'
import { ANTAGONISMS, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import { LEAN_NOTCHES } from '../domain/types'
import type { GridSize, LeanIndex, StrengthLevel, TileAnswer } from '../domain/types'

/**
 * End-to-end integration: a real answer profile, through placement, the seed field and
 * the boundary conditions, into the optimizer. This is the configuration the app
 * actually runs, so it is the one whose behaviour matters -- a synthetic disc with
 * hand-placed pins can be made to misbehave in ways the real pipeline never produces.
 */

const N: GridSize = 64

function ans(
  pairId: string,
  leanIndex: LeanIndex,
  strength: StrengthLevel,
  addedAt: number,
): TileAnswer {
  return { answerId: `a-${pairId}`, pairId, leanIndex, strength, addedAt }
}

/** The worked example the app ships behind its Sample button. */
const SAMPLE: [string, LeanIndex, StrengthLevel][] = [
  ['D-AGE-01', 5, 3],
  ['D-ETH-01', 1, 3],
  ['D-GEN-01', 2, 2],
  ['D-RAC-02', 3, 3],
  ['G-CLI-01', 0, 3],
  ['G-CST-01', 0, 3],
  ['G-REG-01', 1, 3],
  ['G-URB-01', 6, 2],
  ['G-URB-05', 3, 2],
  ['A-FAM-03', 1, 3],
  ['A-REL-01', 4, 2],
  ['A-PRO-01', 1, 3],
  ['A-POL-03', 2, 1],
  ['A-AVO-01', 0, 2],
  ['A-AVO-02', 1, 2],
  ['A-AVO-04', 5, 1],
]

function buildOptimizer(
  answers: TileAnswer[],
  over: { gridSize?: GridSize; mode?: 'simp' | 'beso' } = {},
): Optimizer {
  const layout = { ...DEFAULT_LAYOUT, gridSize: over.gridSize ?? N }
  const grid = createGrid(layout.gridSize, layout.rimRadius)
  const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout })
  const fields = createFields(grid)
  buildFields(fields, tiles, { filterRadius: 2.2, volumeFraction: 'derived' })

  const leanByPair = new Map<string, number>()
  for (const a of answers) leanByPair.set(a.pairId, LEAN_NOTCHES[a.leanIndex] ?? 0)
  const bc = buildBoundary(tiles, { grid, antagonisms: ANTAGONISMS, leanByPair })

  const state = new Uint8Array(grid.count)
  for (let i = 0; i < grid.count; i++) state[i] = grid.mask[i] ? FREE : VOID_PASSIVE
  for (const e of bc.solidPassive) state[e] = SOLID_PASSIVE

  const rho0 = new Float32Array(grid.count)
  const w = new Float32Array(grid.count)
  for (let i = 0; i < grid.count; i++) {
    rho0[i] = fields.rho0[i]!
    w[i] = fields.w[i]!
  }

  return new Optimizer({
    nelx: grid.n,
    nely: grid.n,
    state,
    rho0,
    w,
    fixedDofs: bc.fixedDofs,
    loadDofs: bc.loadDofs,
    loadValues: bc.loadValues,
    volumeFraction: deriveVolumeFraction(tiles),
    penalty: 3,
    filterRadius: 2.2,
    moveLimit: 0.2,
    mode: over.mode ?? 'simp',
  })
}

const sampleAnswers = SAMPLE.map(([id, lean, s], k) => ans(id, lean, s, k))

describe('sample profile', () => {
  it('runs without stranding loads or fragmenting', () => {
    const opt = buildOptimizer(sampleAnswers)
    let worstIslands = 0
    let worstStranded = 0
    let anyNoSignal = false
    for (let k = 0; k < 60; k++) {
      const m = opt.step()
      worstIslands = Math.max(worstIslands, m.islands)
      worstStranded = Math.max(worstStranded, m.unsupportedLoads)
      if (m.noSignal) anyNoSignal = true
    }
    // The 0.25 connectivity floor plus solid patches under every pin and load mean a
    // real profile starts as one component and should stay usable throughout.
    expect(anyNoSignal, 'lost all load signal').toBe(false)
    expect(worstStranded, 'loads stranded from the rim').toBe(0)
    expect(worstIslands, 'fragments broke free').toBeLessThanOrEqual(2)
  }, 300_000)

  it('reduces compliance and settles', () => {
    const opt = buildOptimizer(sampleAnswers)
    const history: number[] = []
    for (let k = 0; k < 80; k++) history.push(opt.step().compliance)
    expect(history[history.length - 1]!).toBeLessThan(history[0]!)

    const tail = history.slice(-10)
    const spread = (Math.max(...tail) - Math.min(...tail)) / Math.min(...tail)
    expect(spread, `last-10 spread ${(100 * spread).toFixed(1)}%`).toBeLessThan(0.15)
  }, 300_000)

  it('holds the derived volume fraction', () => {
    const opt = buildOptimizer(sampleAnswers)
    const target = deriveVolumeFraction(
      placeAnswers({ answers: sampleAnswers, pairs: LIBRARY_BY_ID, layout: { ...DEFAULT_LAYOUT, gridSize: N } }),
    )
    for (let k = 0; k < 30; k++) {
      const m = opt.step()
      expect(m.volume, `iteration ${m.iteration}`).toBeCloseTo(target, 1)
    }
  }, 300_000)

  it('keeps the compliance identity exact throughout', () => {
    const opt = buildOptimizer(sampleAnswers)
    for (let k = 0; k < 20; k++) opt.step()
    opt.step(true)
    // The identity error tracks the CG residual, and the tightened solve targets 1e-7
    // relative -- so 1e-7 is the honest bar here, not 1e-8. On the clean rectangular
    // benchmark the same assertion holds at 1e-8; the disc, with its passive patches
    // and higher stiffness contrast, converges a little less sharply.
    expect(opt.complianceIdentityError()).toBeLessThan(1e-7)
  }, 300_000)

  it('produces structure: material concentrates rather than staying uniform', () => {
    const opt = buildOptimizer(sampleAnswers)
    for (let k = 0; k < 60; k++) opt.step()
    let solid = 0
    let void_ = 0
    for (const e of opt.mesh.designList) {
      const r = opt.density[e]!
      if (r > 0.8) solid++
      else if (r < 0.2) void_++
    }
    const decided = (solid + void_) / opt.mesh.designList.length
    // A seed that merely got rescaled would be almost all intermediate density.
    expect(decided, `only ${(100 * decided).toFixed(0)}% decided`).toBeGreaterThan(0.55)
  }, 300_000)

  it('is deterministic', () => {
    const a = buildOptimizer(sampleAnswers)
    const b = buildOptimizer(sampleAnswers)
    for (let k = 0; k < 25; k++) {
      a.step()
      b.step()
    }
    expect(Array.from(a.density)).toEqual(Array.from(b.density))
  }, 300_000)
})

describe('degenerate profiles survive the full pipeline', () => {
  const cases: [string, TileAnswer[]][] = [
    ['empty', []],
    ['one fluid answer', [ans('A-AVO-04', 6, 3, 0)]],
    ['two answers', [ans('A-AVO-04', 6, 3, 0), ans('D-AGE-01', 0, 3, 1)]],
    [
      'all immutable',
      LIBRARY.filter((p) => p.immutability >= 0.75).map((p, k) => ans(p.id, 5, 3, k)),
    ],
    ['all fluid', LIBRARY.filter((p) => p.immutability <= 0.45).map((p, k) => ans(p.id, 5, 3, k))],
    ['one tile only', LIBRARY.filter((p) => p.facet === 'climate').map((p, k) => ans(p.id, 5, 3, k))],
    ['everything answered', LIBRARY.map((p, k) => ans(p.id, (k % 7) as LeanIndex, 2, k))],
  ]

  for (const [name, answers] of cases) {
    it(`handles: ${name}`, () => {
      const opt = buildOptimizer(answers)
      for (let k = 0; k < 15; k++) {
        const m = opt.step()
        expect(Number.isFinite(m.compliance), `${name} compliance`).toBe(true)
        expect(Number.isFinite(m.volume), `${name} volume`).toBe(true)
        expect(m.volume).toBeGreaterThan(0)
        expect(m.volume).toBeLessThanOrEqual(1)
      }
      for (const e of opt.mesh.designList) {
        expect(Number.isFinite(opt.density[e]!), `${name} elem ${e}`).toBe(true)
      }
    }, 300_000)
  }
})

describe('BESO through the real pipeline', () => {
  it('produces a discrete structure at the derived volume', () => {
    const opt = buildOptimizer(sampleAnswers, { mode: 'beso' })
    let last = opt.step()
    for (let k = 0; k < 120 && !last.converged; k++) last = opt.step()
    for (const e of opt.mesh.freeList) {
      const r = opt.density[e]!
      expect(r === 1 || r < 0.01, `elem ${e} = ${r}`).toBe(true)
    }
  }, 300_000)
})
