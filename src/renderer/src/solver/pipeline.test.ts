import { describe, it, expect } from 'vitest'
import { Optimizer } from './kernel/optimizer'
import { FREE, SOLID_PASSIVE, VOID_PASSIVE } from './protocol'
import { DEFAULT_LAYOUT, placeAnswers } from '../layout/polar'
import { buildFields, createFields, createGrid } from '../layout/fields'
import { buildBoundary } from '../layout/boundary'
import { ANTAGONISMS, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import { LEAN_NOTCHES, strengthFromLean } from '../domain/types'
import type { GridSize, LeanIndex, TileAnswer } from '../domain/types'

/**
 * End-to-end integration: a real answer profile, through placement, the seed field and
 * the boundary conditions, into the optimizer. This is the configuration the app
 * actually runs, so it is the one whose behaviour matters -- a synthetic disc with
 * hand-placed pins can be made to misbehave in ways the real pipeline never produces.
 */

const N: GridSize = 64

function ans(pairId: string, leanIndex: LeanIndex, addedAt: number): TileAnswer {
  return {
    answerId: `a-${pairId}`,
    pairId,
    leanIndex,
    strength: strengthFromLean(leanIndex),
    addedAt,
  }
}

/**
 * The worked example the app ships behind its Sample button (kept in step with
 * `SAMPLE` in `state/store.ts`, though duplicated rather than imported so this stays a
 * self-contained integration fixture). Every regular pair gets an answer; strength is
 * derived from lean, never authored independently.
 */
const SAMPLE: [string, LeanIndex][] = [
  ['D-AGE-01', 5],
  ['D-AGE-05', 2],
  ['D-ETH-01', 1],
  ['D-ETH-03', 4],
  ['D-GEN-01', 2],
  ['D-RAC-02', 3],
  ['D-RAC-03', 6],
  ['G-CLI-01', 0],
  ['G-TMP-01', 5],
  ['G-CST-01', 0],
  ['G-URB-01', 6],
  ['G-URB-05', 3],
  ['G-REG-01', 1],
  ['G-REG-06', 4],
  ['A-FAM-01', 4],
  ['A-FAM-03', 1],
  ['A-EMP-02', 5],
  ['A-PRO-01', 1],
  ['A-POL-03', 2],
  ['A-AVO-02', 1],
  ['A-AVO-04', 5],
]

function buildOptimizer(
  answers: TileAnswer[],
  over: {
    gridSize?: GridSize
    mode?: 'simp' | 'beso'
    /** Set to 0 to reproduce the unfloored SIMP pathology on purpose. */
    volumeFloor?: number
    volumeFraction?: number
  } = {},
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
    // The value buildFields actually chose, so the test runs the app's configuration
    // rather than a recomputed approximation of it.
    volumeFraction: over.volumeFraction ?? fields.volumeFraction,
    // SIMP cannot rebuild a bridge it has eaten; the app passes measured coverage here.
    volumeFloor: over.volumeFloor ?? fields.supportFraction,
    penalty: 3,
    filterRadius: 2.2,
    moveLimit: 0.2,
    mode: over.mode ?? 'simp',
  })
}

const sampleAnswers = SAMPLE.map(([id, lean], k) => ans(id, lean, k))

describe('sample profile', () => {
  it('runs without stranding loads or fragmenting', () => {
    const opt = buildOptimizer(sampleAnswers)
    let worstIslands = 0
    let worstStranded = 0
    let anyNoSignal = false
    let last = opt.step()
    worstIslands = last.islands
    worstStranded = last.unsupportedLoads
    for (let k = 1; k < 60; k++) {
      last = opt.step()
      worstIslands = Math.max(worstIslands, last.islands)
      worstStranded = Math.max(worstStranded, last.unsupportedLoads)
      if (last.noSignal) anyNoSignal = true
    }
    expect(worstIslands, 'transient fragments (recorded, not asserted tightly)')
      .toBeLessThanOrEqual(12)
    /**
     * The END STATE is the property, not the worst intermediate one.
     *
     * With real gutters the seed is deliberately a set of separated tiles joined only by
     * the connectivity floor, so the first iterations legitimately shed and re-form
     * bridges and a handful of chips float free while that happens. What must not happen
     * is finishing that way, or losing the load signal entirely at any point.
     */
    expect(anyNoSignal, 'lost all load signal').toBe(false)
    expect(worstStranded, 'loads stranded from the rim').toBe(0)
    expect(last.islands, 'fragments left floating at the end').toBeLessThanOrEqual(2)
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

  /**
   * The tile seed deliberately starts ABOVE the volume target and lets the optimizer walk
   * it down, so the constraint is met after a short settling window rather than at
   * iteration 1.
   *
   * That is a change from the Gaussian-blob seed, which was gamma-remapped to the target
   * before the first solve. With discrete tiles a remap can only do one of two harmful
   * things: crush the one-element gutters below the solid threshold, which fragments
   * every tile into its own island and hands the connectivity pass a disconnected
   * domain; or dim the tiles themselves, which throws away the saturation encoding that
   * now carries conviction. Neither is worth a feasible iteration zero, because the
   * optimality-criteria update enforces the constraint exactly once the target is within
   * one move limit -- it just needs a few steps to get there.
   *
   * The exact seed/target numbers depend on how many tiles the sample profile deposits,
   * so they are not pinned here as literals (see the dynamically-computed `target`
   * below) -- what is pinned is the SHAPE of the walk: bounded per-step descent,
   * monotone non-increasing, and settled onto the target well before the run ends.
   */
  it('eases the volume constraint down and then holds the target exactly', () => {
    const layout = { ...DEFAULT_LAYOUT, gridSize: N }
    const grid = createGrid(layout.gridSize, layout.rimRadius)
    const tiles = placeAnswers({ answers: sampleAnswers, pairs: LIBRARY_BY_ID, layout })
    const fields = createFields(grid)
    buildFields(fields, tiles, { filterRadius: 2.2, volumeFraction: 'derived' })
    const target = Math.max(fields.volumeFraction, fields.supportFraction)

    const opt = buildOptimizer(sampleAnswers)
    const history: number[] = []
    for (let k = 0; k < 70; k++) history.push(opt.step().volume)

    // Bounded descent: the move limit is 0.2 per element per iteration, so no single
    // step may jump the whole way. A constraint that arrives instantly is the bug this
    // ramp exists to prevent.
    let prev = history[0]!
    for (let k = 1; k < 30; k++) {
      expect(Math.abs(history[k]! - prev), `iteration ${k + 1} step size`).toBeLessThanOrEqual(0.2)
      prev = history[k]!
    }

    // Monotone non-increasing across the ramp, within a small tolerance for the
    // sensitivity filter's mild non-monotonicity.
    for (let k = 1; k < 30; k++) {
      expect(history[k]!, `iteration ${k + 1} rose`).toBeLessThanOrEqual(history[k - 1]! + 0.01)
    }

    // Never below the target, and settled onto it once the ramp is done.
    for (let k = 40; k < history.length; k++) {
      expect(history[k]!, `iteration ${k + 1}`).toBeCloseTo(target, 3)
    }
  }, 300_000)

  /**
   * The premature-convergence regression, and it is worth the run time: this is the bug
   * that made pressing Run produce a half-formed structure in about eight iterations and
   * then stop, reporting success.
   *
   * The tile seed starts above the volume target, so the optimizer sheds hard for the
   * first few iterations and can briefly erode the connective material between tiles.
   * While loads are stranded, the sensitivities over most of the domain are exactly zero,
   * the design stops moving, and changeLinf goes quiet -- which used to satisfy the
   * three-quiet-steps convergence test. It is not converged, it is mid-repair.
   *
   * Runs at the 96 grid ON PURPOSE. The transient does not occur at 64, which is why the
   * rest of this file did not catch it, and "the resolution the app actually ships" is
   * exactly the configuration a pipeline test should cover.
   */
  it('does not declare convergence while loads are stranded', () => {
    /**
     * Forces the pathology on purpose: volumeFloor 0 with a target well under tile
     * coverage is exactly the configuration that strands loads, and the app no longer
     * produces it (SIMP is floored at measured coverage, and BESO does not need to be).
     * Without pinning it here the guard would still be in the code but nothing would
     * exercise it, and the next person to touch the floor would have no warning.
     *
     * 0.18, not 0.2: the 21-pair sample (up from the old 16-answer one) deposits more
     * connective material, so reproducing the stranding transient at the 96 grid now
     * needs a slightly tighter target. Recorded from measurement, not guessed.
     */
    const opt = buildOptimizer(sampleAnswers, {
      gridSize: 96,
      volumeFloor: 0,
      volumeFraction: 0.18,
    })
    let sawStranding = false
    let convergedAt = -1
    let strandedAtConvergence = -1

    for (let k = 0; k < 60; k++) {
      const m = opt.step()
      if (m.unsupportedLoads > 0) sawStranding = true
      if (m.converged && convergedAt < 0) {
        convergedAt = m.iteration
        strandedAtConvergence = m.unsupportedLoads
      }
    }

    // The transient is the precondition for the test meaning anything.
    expect(sawStranding, 'no stranding transient occurred, so this proves nothing').toBe(true)
    expect(strandedAtConvergence, `converged at iteration ${convergedAt} with loads stranded`).not.toBeGreaterThan(0)
    // And it must not stop in the transient window either way.
    if (convergedAt >= 0) expect(convergedAt, 'converged suspiciously early').toBeGreaterThan(10)
  }, 300_000)

  /**
   * The other half of the same story: the structure repairs itself and then genuinely
   * settles, so gating convergence on stranding cannot deadlock a real profile.
   */
  it('recovers connectivity on its own and settles with every load carried', () => {
    const opt = buildOptimizer(sampleAnswers, { gridSize: 96 })
    let last = opt.step()
    for (let k = 1; k < 60; k++) last = opt.step()
    expect(last.unsupportedLoads, 'loads still stranded at the end of the run').toBe(0)
    expect(last.noSignal).toBe(false)
    expect(last.compliance).toBeGreaterThan(0)
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
    ['one fluid answer', [ans('A-AVO-04', 6, 0)]],
    ['two answers', [ans('A-AVO-04', 6, 0), ans('D-AGE-01', 0, 1)]],
    [
      'all immutable',
      LIBRARY.filter((p) => p.immutability >= 0.75).map((p, k) => ans(p.id, 5, k)),
    ],
    ['all fluid', LIBRARY.filter((p) => p.immutability <= 0.45).map((p, k) => ans(p.id, 5, k))],
    ['one tile only', LIBRARY.filter((p) => p.facet === 'climate').map((p, k) => ans(p.id, 5, k))],
    ['everything answered', LIBRARY.map((p, k) => ans(p.id, (k % 7) as LeanIndex, k))],
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
