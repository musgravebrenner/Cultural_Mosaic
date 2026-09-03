import { centroid } from './mesh'
import type { Mesh } from './mesh'

/**
 * The Sigmund sensitivity filter, precomputed once as CSR over the design element list.
 *
 * Chosen over a density filter for three reasons:
 *  1. It is what top88 pairs with the optimality-criteria update, and that is the most
 *     robust combination known for this problem class.
 *  2. It needs no chain rule, so the SIMP and BESO code paths share it IDENTICALLY. A
 *     density filter would require propagating drho_phys/drho, which BESO's discrete
 *     update cannot use.
 *  3. It is cheaper -- one sparse apply per iteration instead of two.
 *
 * The cost of that choice, stated plainly: the sensitivity filter is a heuristic rather
 * than a consistent gradient, so the compliance history can be mildly non-monotonic and
 * Heaviside projection cannot be bolted on for perfectly crisp 0/1 results. The export
 * hardening pass covers the crispness need instead.
 */

export interface Filter {
  /** nDesign + 1, indexed by position in mesh.designList. */
  readonly rowPtr: Int32Array
  /** Compact design-list indices, NOT global element ids. */
  readonly colIdx: Int32Array
  readonly val: Float64Array
  /** Row sums. */
  readonly rowSum: Float64Array
  readonly radius: number
  readonly nnz: number
}

/**
 * Linear "cone" weights H_ei = max(0, rmin - dist(centroid_e, centroid_i)), over the
 * design elements only -- voided elements are never touched, so the filter cannot smear
 * material across the outside of the disc.
 *
 * Default radius 2.2 elements. Minimum member width is roughly 2*rmin, so about 4.4
 * elements. Below ~1.8 you get checkerboarding and one-node hinges, which also wrecks
 * the conditioning; above ~3.5 the mosaic reads as blobs rather than a truss.
 *
 * The radius must stay at or BELOW the minimum deposit sigma. If the filter is wider
 * than the deposits, it erases the seed structure before the optimizer can act on it
 * and every profile produces the same art -- a silent, total loss of expressiveness.
 */
export function buildFilter(mesh: Mesh, radius: number): Filter {
  const list = mesh.designList
  const nd = list.length
  // Global element id -> compact design index, so neighbour lookups are O(1).
  const compact = new Int32Array(mesh.nelem).fill(-1)
  for (let a = 0; a < nd; a++) compact[list[a]!] = a

  const win = Math.ceil(radius)
  const rowPtr = new Int32Array(nd + 1)
  const cols: number[] = []
  const vals: number[] = []

  for (let a = 0; a < nd; a++) {
    rowPtr[a] = cols.length
    const e = list[a]!
    const { cx, cy } = centroid(mesh, e)
    const ex = e % mesh.nelx
    const ey = (e - ex) / mesh.nelx
    for (let dy = -win; dy <= win; dy++) {
      const yy = ey + dy
      if (yy < 0 || yy >= mesh.nely) continue
      for (let dx = -win; dx <= win; dx++) {
        const xx = ex + dx
        if (xx < 0 || xx >= mesh.nelx) continue
        const j = yy * mesh.nelx + xx
        const b = compact[j]!
        if (b < 0) continue
        const { cx: jx, cy: jy } = centroid(mesh, j)
        const w = radius - Math.hypot(cx - jx, cy - jy)
        if (w <= 0) continue
        cols.push(b)
        vals.push(w)
      }
    }
  }
  rowPtr[nd] = cols.length

  const colIdx = Int32Array.from(cols)
  const val = Float64Array.from(vals)
  const rowSum = new Float64Array(nd)
  for (let a = 0; a < nd; a++) {
    let s = 0
    for (let k = rowPtr[a]!; k < rowPtr[a + 1]!; k++) s += val[k]!
    rowSum[a] = s
  }
  return { rowPtr, colIdx, val, rowSum, radius, nnz: colIdx.length }
}

const RHO_FILTER_FLOOR = 1e-3

/**
 * The Sigmund sensitivity filter:
 *
 *   dcF_e = sum_i(H_ei * rho_i * dc_i) / (Hs_e * max(floor, rho_e))
 *
 * Reads `dc` and writes `dcF`, both indexed by GLOBAL element id.
 */
export function applySensitivityFilter(
  filter: Filter,
  mesh: Mesh,
  rho: Float64Array,
  dc: Float64Array,
  dcF: Float64Array,
): void {
  const list = mesh.designList
  for (let a = 0; a < list.length; a++) {
    const e = list[a]!
    let num = 0
    for (let k = filter.rowPtr[a]!; k < filter.rowPtr[a + 1]!; k++) {
      const j = list[filter.colIdx[k]!]!
      num += filter.val[k]! * rho[j]! * dc[j]!
    }
    dcF[e] = num / (filter.rowSum[a]! * Math.max(RHO_FILTER_FLOOR, rho[e]!))
  }
}

/**
 * A plain weighted average, used for BESO sensitivity numbers rather than the
 * rho-weighted form above.
 *
 * BESO needs this: at rho = x_min a void element's own sensitivity number is around
 * 1e-6 of a solid one, so voids are effectively invisible on their own. The filter is
 * precisely what lets them be re-admitted, by borrowing their solid neighbours' values.
 * The algorithm does not work without it.
 */
export function applyAverageFilter(
  filter: Filter,
  mesh: Mesh,
  src: Float64Array,
  dst: Float64Array,
): void {
  const list = mesh.designList
  for (let a = 0; a < list.length; a++) {
    let num = 0
    for (let k = filter.rowPtr[a]!; k < filter.rowPtr[a + 1]!; k++) {
      num += filter.val[k]! * src[list[filter.colIdx[k]!]!]!
    }
    dst[list[a]!] = num / filter.rowSum[a]!
  }
}

export const DEFAULT_FILTER_RADIUS = 2.2
