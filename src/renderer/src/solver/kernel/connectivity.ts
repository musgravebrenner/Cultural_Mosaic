import { SOLID_PASSIVE } from './mesh'
import type { Mesh } from './mesh'

/**
 * Connected-component analysis, and the actual fix for the floating-material failure
 * mode -- the single highest risk in this solver.
 *
 * The Emin = 1e-6 floor guarantees K is symmetric positive-definite for any density
 * field, so CG never divides by a non-positive p^T K p. But that is only the
 * mathematical safety net, NOT the performance fix: an island of solid material
 * connected to the anchored structure only through Emin material has a near-rigid-body
 * mode with eigenvalue ~Emin, so cond(K) ~ E0/Emin * N^2 and Jacobi-PCG would need
 * thousands of iterations. Jacobi does not help -- it normalizes the diagonal, but the
 * island's low mode survives.
 *
 * Constraining an island's DOFs to zero is what fixes it. The solved system's condition
 * number then depends on GEOMETRY only (~N^2), independent of the density contrast.
 *
 * The elimination is deliberately NARROW -- islands only, never merely-soft regions.
 * See the rule below for why the broader version is actively harmful.
 */

/** Hysteresis band. Prevents the mask oscillating with period two between iterations. */
const SOLID_ENTER = 0.12
const SOLID_LEAVE = 0.08
/** Non-anchored components smaller than this are not worth reporting. */
const ISLAND_MIN_ELEMS = 8

export interface Connectivity {
  /** Per-element membership in the solid set, with hysteresis carried across calls. */
  readonly inSolid: Uint8Array
  /** 1 where an anchored solid element touches the DOF. */
  readonly supported: Uint8Array
  /** Working fixed mask: pinned, OR stranded on a floating island. */
  readonly fixedMask: Uint8Array
  /** Sorted list form of fixedMask, for the CG masking loops. */
  fixedList: Int32Array
  /** Non-anchored components larger than ISLAND_MIN_ELEMS. */
  islands: number
  /** Load DOFs that landed on a floating island and had to be dropped. */
  unsupportedLoads: number
  /** DOFs newly constrained since the previous call; u0 must be zeroed at these. */
  newlyConstrained: Int32Array
}

export function createConnectivity(mesh: Mesh): Connectivity {
  return {
    inSolid: new Uint8Array(mesh.nelem),
    supported: new Uint8Array(mesh.ndof),
    fixedMask: new Uint8Array(mesh.ndof),
    fixedList: new Int32Array(0),
    islands: 0,
    unsupportedLoads: 0,
    newlyConstrained: new Int32Array(0),
  }
}

/**
 * Union-find over the 4-connected solid set, restricted to design elements.
 *
 * 4-connectivity rather than 8: two elements touching only at a corner transmit no load
 * through a Q4 mesh, so treating them as connected would mark a genuinely floating
 * island as supported and reintroduce the conditioning problem it exists to prevent.
 */
export function updateConnectivity(
  conn: Connectivity,
  mesh: Mesh,
  rho: Float64Array,
  pinnedMask: Uint8Array,
  loadDofs: Uint32Array,
): void {
  const { nelx, nely, nelem, ndof, edof } = mesh
  const { inSolid, supported, fixedMask } = conn

  // Solid set with hysteresis: enter above 0.12, leave below 0.08, otherwise hold.
  // An element crossing the band contributes at most E(0.12) ~ 1.7e-3 of stiffness, so
  // the compliance discontinuity is on the order of 0.1% -- well below the OC step.
  for (let e = 0; e < nelem; e++) {
    if (mesh.state[e] === SOLID_PASSIVE) {
      inSolid[e] = 1
      continue
    }
    const r = rho[e]!
    if (r > SOLID_ENTER) inSolid[e] = 1
    else if (r < SOLID_LEAVE) inSolid[e] = 0
    // else: keep the previous state.
  }

  const parent = new Int32Array(nelem)
  for (let e = 0; e < nelem; e++) parent[e] = e
  const find = (x: number): number => {
    let r = x
    while (parent[r]! !== r) r = parent[r]!
    // Path compression.
    let c = x
    while (parent[c]! !== r) {
      const next = parent[c]!
      parent[c] = r
      c = next
    }
    return r
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const isSolid = (e: number): boolean => mesh.state[e] !== 0 && inSolid[e] === 1

  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex
      if (!isSolid(e)) continue
      if (ex + 1 < nelx && isSolid(e + 1)) union(e, e + 1)
      if (ey + 1 < nely && isSolid(e + nelx)) union(e, e + nelx)
    }
  }

  // A component is ANCHORED if it contains an element with a pinned corner DOF.
  const anchored = new Uint8Array(nelem)
  for (let e = 0; e < nelem; e++) {
    if (!isSolid(e)) continue
    const b = e * 8
    for (let k = 0; k < 8; k++) {
      if (pinnedMask[edof[b + k]!]) {
        anchored[find(e)] = 1
        break
      }
    }
  }

  /**
   * Mark DOFs by what kind of solid material touches them.
   *
   * THE RULE, and it is narrower than it first appears: a DOF is constrained only when
   * it belongs to a genuine floating ISLAND -- some solid element touches it, and every
   * such element is in a non-anchored component.
   *
   * The obvious-looking alternative -- constrain everything not reachable from an
   * anchor through solid material -- is wrong, and wrong in a way that destroys the
   * optimization. Under SIMP every element in the design domain is continuum with
   * E >= Emin > 0, so an interior pocket of intermediate density is NOT disconnected;
   * it is simply soft. Constraining its interior nodes imposes a fictitious rigid
   * boundary that appears and disappears as the design evolves, which perturbs u
   * discontinuously between iterations. Measured on the 60x20 MBB: the compliance
   * oscillated by 102% over the last ten iterations and never converged, versus 0.1%
   * spread and the expected ~203 once the rule was narrowed to islands only.
   *
   * The narrow rule still does the job it exists for. A solid island connected to the
   * structure only through Emin material has a near-rigid-body mode at eigenvalue
   * ~Emin, so cond(K) ~ E0/Emin * N^2 and Jacobi-PCG would need thousands of
   * iterations; eliminating exactly those DOFs removes the mode, and leaves the
   * conditioning governed by geometry alone.
   */
  supported.fill(0)
  const inIsland = new Uint8Array(ndof)
  for (let e = 0; e < nelem; e++) {
    if (!isSolid(e)) continue
    const b = e * 8
    const anchoredHere = anchored[find(e)] === 1
    for (let k = 0; k < 8; k++) {
      const d = edof[b + k]!
      if (anchoredHere) supported[d] = 1
      else inIsland[d] = 1
    }
  }

  /**
   * Record which DOFs became newly constrained. When the supported set changes, u0 must
   * be zeroed at those DOFs before entering CG -- otherwise r[c] = 0 silently discards a
   * nonzero component of u and the initial residual is inconsistent with the system
   * actually being solved.
   */
  const newly: number[] = []
  for (let i = 0; i < ndof; i++) {
    const wasFixed = fixedMask[i] === 1
    // Constrained only if pinned, or stranded on an island with no anchored solid
    // element touching it.
    const nowFixed = pinnedMask[i] === 1 || (inIsland[i] === 1 && supported[i] === 0)
    if (nowFixed && !wasFixed) newly.push(i)
    fixedMask[i] = nowFixed ? 1 : 0
  }
  conn.newlyConstrained = Int32Array.from(newly)

  const list: number[] = []
  for (let i = 0; i < ndof; i++) if (fixedMask[i]) list.push(i)
  conn.fixedList = Int32Array.from(list)

  // Island reporting. Small islands are normal mid-run and shrink away; a persistent
  // large one means the seed genuinely partitioned the domain, and the UI should say so
  // rather than quietly producing a fragmented mosaic.
  const size = new Map<number, number>()
  for (let e = 0; e < nelem; e++) {
    if (!isSolid(e)) continue
    const r = find(e)
    if (anchored[r]) continue
    size.set(r, (size.get(r) ?? 0) + 1)
  }
  let islands = 0
  for (const s of size.values()) if (s > ISLAND_MIN_ELEMS) islands++
  conn.islands = islands

  let dropped = 0
  for (let k = 0; k < loadDofs.length; k++) {
    if (fixedMask[loadDofs[k]!]) dropped++
  }
  conn.unsupportedLoads = dropped
}

export const CONNECTIVITY_CONSTANTS = Object.freeze({
  SOLID_ENTER,
  SOLID_LEAVE,
  ISLAND_MIN_ELEMS,
})
