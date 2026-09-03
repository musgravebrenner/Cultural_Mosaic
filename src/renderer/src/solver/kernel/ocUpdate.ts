import { RHO_MIN } from './assembly'
import type { Mesh } from './mesh'

/**
 * The optimality-criteria density update, with a Lagrange multiplier found by bisection.
 *
 *   Be_e  = -dcF_e / lambda
 *   rho_new_e = clamp(rho_e * Be_e^eta,  move limits,  [RHO_MIN, 1])
 *
 * eta = 0.5 is the classic damping exponent (a square root), move = 0.2 the classic
 * move limit.
 */

export interface OcState {
  /** Previous multiplier, used to warm-start the bracket. */
  lambda: number
  changeLinf: number
}

export function createOcState(): OcState {
  return { lambda: 1, changeLinf: 1 }
}

const ETA = 0.5
const BISECT_TOL = 1e-3
const MAX_BISECT = 80

/**
 * Update `rho` in place over the free elements.
 *
 * SOLID_PASSIVE elements are skipped entirely -- they stay at 1.0 and are already
 * accounted for in the target through `nSolid`.
 */
export function ocUpdate(
  state: OcState,
  mesh: Mesh,
  rho: Float64Array,
  rhoNew: Float64Array,
  dcF: Float64Array,
  volumeFraction: number,
  move: number,
): void {
  const free = mesh.freeList
  const nFree = free.length
  if (nFree === 0) {
    state.changeLinf = 0
    return
  }

  // Budget for the free elements: the total target less what the passive solids already
  // consume. If the patches alone exceed the budget the problem is infeasible, so clamp
  // rather than chase a root that does not exist.
  const targetTotal = volumeFraction * mesh.designList.length
  const targetFree = Math.min(nFree, Math.max(RHO_MIN * nFree, targetTotal - mesh.nSolid))

  const volAt = (lambda: number): number => {
    let s = 0
    for (let a = 0; a < nFree; a++) {
      const e = free[a]!
      s += candidate(rho[e]!, dcF[e]!, lambda, move)
    }
    return s
  }

  // Warm bracket from the previous multiplier cuts bisections from ~58 to ~15. Each is
  // a full pass over the free elements, so it is worth the few lines.
  let l1 = state.lambda / 4
  let l2 = state.lambda * 4
  if (!(l1 > 0) || !Number.isFinite(l2)) {
    l1 = 1e-9
    l2 = 1e9
  }
  // Volume is monotonically DECREASING in lambda, so expand until the root is straddled.
  let guard = 0
  while (volAt(l1) < targetFree && guard++ < 60) l1 /= 4
  guard = 0
  while (volAt(l2) > targetFree && guard++ < 60) l2 *= 4

  for (let it = 0; it < MAX_BISECT; it++) {
    if ((l2 - l1) / (l1 + l2) <= BISECT_TOL) break
    const mid = 0.5 * (l1 + l2)
    if (volAt(mid) > targetFree) l1 = mid
    else l2 = mid
  }
  const lambda = 0.5 * (l1 + l2)
  state.lambda = lambda

  let changeLinf = 0
  for (let a = 0; a < nFree; a++) {
    const e = free[a]!
    const next = candidate(rho[e]!, dcF[e]!, lambda, move)
    changeLinf = Math.max(changeLinf, Math.abs(next - rho[e]!))
    rhoNew[e] = next
  }
  for (let a = 0; a < nFree; a++) {
    const e = free[a]!
    rho[e] = rhoNew[e]!
  }
  state.changeLinf = changeLinf
}

function candidate(rhoE: number, dcFe: number, lambda: number, move: number): number {
  // Clamp Be at zero BEFORE the power. A positive dcF_e can genuinely occur, because
  // the sensitivity filter is a heuristic rather than a consistent gradient -- and
  // Math.pow of a negative base with a fractional exponent is NaN, which would
  // propagate silently through the whole density field.
  const be = Math.max(0, -dcFe / lambda)
  const target = rhoE * Math.pow(be, ETA)
  const hi = Math.min(1, rhoE + move)
  const lo = Math.max(RHO_MIN, rhoE - move)
  return Math.min(hi, Math.max(lo, target))
}

/** Mean density over the assembled elements, including the passive solids. */
export function currentVolume(mesh: Mesh, rho: Float64Array): number {
  let s = 0
  for (let a = 0; a < mesh.designList.length; a++) s += rho[mesh.designList[a]!]!
  return s / mesh.designList.length
}

export const OC_CONSTANTS = Object.freeze({ ETA, BISECT_TOL, MAX_BISECT })
