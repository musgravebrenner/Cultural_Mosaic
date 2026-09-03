/**
 * Structured Q4 mesh: index arithmetic and the element state partition.
 *
 * MESH CONVENTION -- identical to the one documented in layout/boundary.ts, and it must
 * stay that way, because that module computes the DOF indices this one is indexed by.
 *
 *   elements  e  = ey * nelx + ex        ex in [0,nelx), ey in [0,nely), ey UP
 *   nodes     nd = iy * (nelx+1) + ix    ix in [0,nelx], iy in [0,nely], iy UP
 *   dofs         = 2*nd (x), 2*nd + 1 (y)
 *
 *   corners, CCW from bottom-left in physical y-up coordinates:
 *     bl = ey*nnodex + ex,  br = bl + 1,  tr = bl + nnodex + 1,  tl = bl + nnodex
 *
 * KE is exactly independent of element size for squares, so h = 1 throughout the
 * kernel. Do not introduce an h factor.
 */

// The element-state encoding lives in the protocol, because the renderer builds the
// array and the kernel consumes it -- both sides must agree.
export { VOID_PASSIVE, FREE, SOLID_PASSIVE } from '../protocol'
import { VOID_PASSIVE, FREE } from '../protocol'

export interface Mesh {
  readonly nelx: number
  readonly nely: number
  readonly nnodex: number
  readonly nnodey: number
  readonly nelem: number
  readonly ndof: number
  /** nelem*8 element DOF table, in the CCW-from-bottom-left order KE requires. */
  readonly edof: Int32Array
  /** nelem element states. */
  readonly state: Uint8Array
  /** Elements in states FREE and SOLID_PASSIVE -- everything that gets assembled. */
  readonly designList: Int32Array
  /** Elements in state FREE only -- the actual design variables. */
  readonly freeList: Int32Array
  /** Number of SOLID_PASSIVE elements, which consume part of the volume budget. */
  readonly nSolid: number
}

export function buildMesh(nelx: number, nely: number, state: Uint8Array): Mesh {
  const nnodex = nelx + 1
  const nnodey = nely + 1
  const nelem = nelx * nely
  const ndof = 2 * nnodex * nnodey
  if (state.length !== nelem) {
    throw new Error(`state length ${state.length} does not match nelem ${nelem}`)
  }

  const edof = new Int32Array(nelem * 8)
  for (let ey = 0; ey < nely; ey++) {
    for (let ex = 0; ex < nelx; ex++) {
      const e = ey * nelx + ex
      const bl = ey * nnodex + ex
      const br = bl + 1
      const tr = bl + nnodex + 1
      const tl = bl + nnodex
      const b = e * 8
      edof[b] = 2 * bl
      edof[b + 1] = 2 * bl + 1
      edof[b + 2] = 2 * br
      edof[b + 3] = 2 * br + 1
      edof[b + 4] = 2 * tr
      edof[b + 5] = 2 * tr + 1
      edof[b + 6] = 2 * tl
      edof[b + 7] = 2 * tl + 1
    }
  }

  const design: number[] = []
  const free: number[] = []
  let nSolid = 0
  for (let e = 0; e < nelem; e++) {
    const s = state[e]!
    if (s === VOID_PASSIVE) continue
    design.push(e)
    if (s === FREE) free.push(e)
    else nSolid++
  }

  return {
    nelx,
    nely,
    nnodex,
    nnodey,
    nelem,
    ndof,
    edof,
    state,
    designList: Int32Array.from(design),
    freeList: Int32Array.from(free),
    nSolid,
  }
}

/** Element centroid in element units (not normalized), with y up. */
export function centroid(mesh: Mesh, e: number): { cx: number; cy: number } {
  const ex = e % mesh.nelx
  const ey = (e - ex) / mesh.nelx
  return { cx: ex + 0.5, cy: ey + 0.5 }
}

/**
 * Every DOF that no assembled element touches is permanently unconstrained-but-unloaded,
 * which would leave K singular. They are folded into the fixed set once at init.
 */
export function untouchedDofs(mesh: Mesh): Uint8Array {
  const touched = new Uint8Array(mesh.ndof)
  for (let d = 0; d < mesh.designList.length; d++) {
    const b = mesh.designList[d]! * 8
    for (let k = 0; k < 8; k++) touched[mesh.edof[b + k]!] = 1
  }
  const out = new Uint8Array(mesh.ndof)
  for (let i = 0; i < mesh.ndof; i++) out[i] = touched[i] ? 0 : 1
  return out
}

/** A rectangular all-FREE domain, used by the benchmark problems. */
export function rectangularState(nelx: number, nely: number): Uint8Array {
  return new Uint8Array(nelx * nely).fill(FREE)
}
