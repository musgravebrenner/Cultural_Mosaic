import { RHO_MIN } from './assembly'
import { applyAverageFilter } from './filter'
import type { Filter } from './filter'
import { SOLID_PASSIVE } from './mesh'
import type { Mesh } from './mesh'

/**
 * Soft-kill BESO (Huang & Xie), sharing the FEA core COMPLETELY unchanged.
 *
 * rho is simply restricted to {x_min, 1} and fed through the same
 * E(rho) = w*(Emin + rho^p*(E0 - Emin)) interpolation. Same assembly, same CG, same
 * element energies, same filter. Only the update step differs.
 *
 * Artistically the two modes differ usefully: SIMP produces smooth, cartilage-like
 * gradients (better for a print with soft edges), BESO produces hard black-and-white
 * truss members (better for a graphic, a laser cut, or vinyl).
 */

const ER = 0.02
/** Cap on additions per iteration, as a fraction of the design domain. */
const AR_MAX = 0.05
/** Convergence window and tolerance, per Huang & Xie. */
const M_WINDOW = 5
const TAU = 0.001

export interface BesoState {
  /** Target volume fraction for the CURRENT iteration, stepping toward the goal. */
  volume: number
  /** History-averaged sensitivity numbers, indexed by global element id. */
  alphaBar: Float64Array
  /** Whether alphaBar has been seeded yet. */
  primed: boolean
  /** Last 2*M compliance values, newest last. */
  history: number[]
}

/**
 * Snap the continuous seed to the discrete {x_min, 1} that BESO requires, preserving
 * the seed's MASS rather than thresholding at a fixed 0.5.
 *
 * A fixed 0.5 threshold is a trap. The seed is volume-normalized to a mean near the
 * target, so on a smooth field almost nothing exceeds 0.5 -- and on a uniform seed at
 * exactly 0.5, nothing does. The whole structure is then wiped to void on iteration
 * zero. That is not recoverable either: with no solid material anywhere, no component
 * is anchored, the connectivity pass constrains everything, u = 0, every element
 * energy is 0, and the sensitivity numbers carry no signal at all for BESO to grow
 * material back from. The mosaic silently comes out empty.
 *
 * Selecting the densest `V0 * nDesign` elements instead guarantees a non-degenerate,
 * connected start whose volume equals the seed's own.
 */
export function discretize(mesh: Mesh, rho: Float64Array): number {
  const list = mesh.designList
  const nd = list.length
  if (nd === 0) return 0

  let mean = 0
  for (let a = 0; a < nd; a++) mean += rho[list[a]!]!
  mean /= nd
  const v0 = Math.min(0.95, Math.max(0.05, mean))
  const keep = Math.max(1, Math.round(v0 * nd))

  const sorted = new Float64Array(nd)
  for (let a = 0; a < nd; a++) sorted[a] = rho[list[a]!]!
  sorted.sort()
  // Descending rank `keep` is ascending rank nd - keep.
  const threshold = sorted[Math.max(0, nd - keep)]!

  for (let a = 0; a < nd; a++) {
    const e = list[a]!
    rho[e] = rho[e]! >= threshold ? 1 : RHO_MIN
  }
  // Passive solids are structural, never a design choice.
  for (let a = 0; a < nd; a++) {
    const e = list[a]!
    if (mesh.state[e] === SOLID_PASSIVE) rho[e] = 1
  }

  let solid = 0
  for (let a = 0; a < nd; a++) if (rho[list[a]!]! > RHO_MIN) solid++
  return solid / nd
}

export function createBesoState(mesh: Mesh, initialVolume: number): BesoState {
  return {
    // Start from the seed's own volume, so a profile that begins either side of the
    // target evolves toward it rather than being discarded.
    volume: Math.min(0.95, Math.max(0.05, initialVolume)),
    alphaBar: new Float64Array(mesh.nelem),
    primed: false,
    history: [],
  }
}

/**
 * Sensitivity numbers, defined uniformly for solid and void so voids can be
 * re-admitted:
 *
 *   alpha_e = 0.5 * w_e * rho_e^(p-1) * ce_e
 *
 * At rho = x_min with p = 3 this is about 1e-6 of a solid element's value, so voids are
 * essentially invisible on their own -- the filter is what lets them come back, by
 * borrowing their solid neighbours' values.
 */
export function besoStep(
  state: BesoState,
  mesh: Mesh,
  filter: Filter,
  rho: Float64Array,
  w: Float64Array,
  ce: Float64Array,
  alphaRaw: Float64Array,
  alphaFiltered: Float64Array,
  p: number,
  targetVolume: number,
  compliance: number,
): { volumeTarget: number; nAdded: number; nRemoved: number; converged: boolean } {
  const list = mesh.designList
  for (let a = 0; a < list.length; a++) {
    const e = list[a]!
    alphaRaw[e] = 0.5 * w[e]! * Math.pow(rho[e]!, p - 1) * ce[e]!
  }
  applyAverageFilter(filter, mesh, alphaRaw, alphaFiltered)

  // History averaging is MANDATORY: without it BESO oscillates indefinitely.
  if (!state.primed) {
    for (let a = 0; a < list.length; a++) state.alphaBar[list[a]!] = alphaFiltered[list[a]!]!
    state.primed = true
  } else {
    for (let a = 0; a < list.length; a++) {
      const e = list[a]!
      state.alphaBar[e] = 0.5 * (alphaFiltered[e]! + state.alphaBar[e]!)
    }
  }

  // Evolutionary volume schedule, supporting BOTH directions because the seed volume is
  // user-determined and may start either side of the target.
  const next =
    state.volume > targetVolume
      ? Math.max(targetVolume, state.volume * (1 - ER))
      : Math.min(targetVolume, state.volume * (1 + ER))
  state.volume = next

  const free = mesh.freeList
  const targetCount = Math.round(next * list.length) - mesh.nSolid
  const wantSolid = Math.min(free.length, Math.max(0, targetCount))

  const ab = state.alphaBar
  let lo = Infinity
  let hi = -Infinity
  for (let a = 0; a < free.length; a++) {
    const v = ab[free[a]!]!
    if (v < lo) lo = v
    if (v > hi) hi = v
  }

  /** Bisect a threshold so that `count(pred above t)` equals `want`. */
  const bisect = (want: number, pred: (e: number) => boolean): number => {
    let tl = lo
    let th = hi
    for (let it = 0; it < 50; it++) {
      const mid = 0.5 * (tl + th)
      let c = 0
      for (let a = 0; a < free.length; a++) {
        const e = free[a]!
        if (pred(e) && ab[e]! > mid) c++
      }
      if (c > want) tl = mid
      else th = mid
    }
    return 0.5 * (tl + th)
  }

  const isSolid = (e: number): boolean => rho[e]! > RHO_MIN
  const isVoid = (e: number): boolean => !isSolid(e)

  let nSolidPrev = 0
  for (let a = 0; a < free.length; a++) if (isSolid(free[a]!)) nSolidPrev++

  /**
   * TWO thresholds, not one, and this is what makes the volume schedule actually hold.
   *
   * A single threshold sized for the target is not enough once additions are capped:
   * you would still delete every solid below it while admitting only AR_MAX worth of
   * voids, so the structure loses more than it gains and the volume undershoots the
   * schedule badly. Measured with a single threshold: the target was 0.40 and the run
   * settled at 0.33, with per-iteration volume jumps of 0.29 against a schedule that
   * allows at most 0.07.
   *
   * So: cap the additions first, then size the DELETE threshold against how many were
   * actually admitted, so that (previous + added - deleted) lands on the target.
   */
  const addCap = Math.floor(AR_MAX * list.length)
  const provisional = bisect(wantSolid, () => true)
  let nAdd = 0
  for (let a = 0; a < free.length; a++) {
    const e = free[a]!
    if (isVoid(e) && ab[e]! > provisional) nAdd++
  }
  const addThreshold = nAdd > addCap ? bisect(addCap, isVoid) : provisional

  let addCount = 0
  for (let a = 0; a < free.length; a++) {
    const e = free[a]!
    if (isVoid(e) && ab[e]! > addThreshold) addCount++
  }

  const wantDelete = Math.max(0, nSolidPrev + addCount - wantSolid)
  // Keep the (nSolidPrev - wantDelete) strongest solids, so delete the rest.
  const delThreshold =
    wantDelete <= 0 ? -Infinity : bisect(nSolidPrev - wantDelete, isSolid)

  let added = 0
  let removed = 0
  for (let a = 0; a < free.length; a++) {
    const e = free[a]!
    if (isVoid(e)) {
      if (ab[e]! > addThreshold) {
        rho[e] = 1
        added++
      }
    } else if (ab[e]! <= delThreshold) {
      rho[e] = RHO_MIN
      removed++
    }
  }

  // Huang-Xie convergence: the volume target has been reached AND the compliance has
  // stopped changing across two consecutive windows of M iterations.
  state.history.push(compliance)
  if (state.history.length > 2 * M_WINDOW) state.history.shift()
  let converged = false
  if (Math.abs(next - targetVolume) < 1e-9 && state.history.length === 2 * M_WINDOW) {
    let num = 0
    let den = 0
    for (let i = 0; i < M_WINDOW; i++) {
      const recent = state.history[2 * M_WINDOW - 1 - i]!
      const older = state.history[M_WINDOW - 1 - i]!
      num += recent - older
      den += recent
    }
    converged = den > 0 && Math.abs(num) / den <= TAU
  }

  return { volumeTarget: next, nAdded: added, nRemoved: removed, converged }
}

export const BESO_CONSTANTS = Object.freeze({ ER, AR_MAX, M_WINDOW, TAU })
