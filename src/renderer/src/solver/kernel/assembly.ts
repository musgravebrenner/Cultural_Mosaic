import { KE } from './elementStiffness'
import type { Mesh } from './mesh'

/**
 * Assembled CSR, not matrix-free element-by-element. Decided, with numbers.
 *
 * Per optimization iteration:
 *   EBE matvec        nDesign * 64 FMA, plus 8 gathers and 8 scatters per element,
 *                     which measures at roughly 1.9x one CSR matvec
 *   CSR matvec        nnz FMA, sequential in the values array
 *   re-assembly       nDesign * 64 accumulations = about one EBE matvec, paid ONCE
 *
 * Break-even is around n_cg = 2, and we run 25-80. So CSR wins by ~1.9x on the
 * dominant term, and it additionally hands over the exact diagonal for free (Jacobi),
 * a clean object to unit-test against a dense reference, and an easy path to a stronger
 * preconditioner later.
 *
 * The mesh never changes, so the sparsity pattern, the element-to-CSR scatter map and
 * the diagonal positions are all built ONCE at init. Per iteration the assembly is a
 * single pass of 64 scattered accumulations per element.
 */

export interface Pattern {
  /** ndof + 1 */
  readonly rowPtr: Int32Array
  /** nnz */
  readonly colIdx: Int32Array
  /** nDesign * 64 -- position in `values` for each element's local (i,j). */
  readonly scatter: Int32Array
  /** ndof -- position in `values` of each diagonal entry. */
  readonly diagPos: Int32Array
  readonly nnz: number
}

/**
 * Build the pattern by counting sort on rows, then sorting and deduping each row.
 * Deliberately avoids a global key of r*ndof + c: at nelx = nely = 128 that product
 * reaches 1.1e9, uncomfortably close to the int32 limit, and a silent overflow there
 * would corrupt the matrix rather than fail.
 */
export function buildPattern(mesh: Mesh): Pattern {
  const { ndof, edof, designList } = mesh
  const nd = designList.length

  // Pass 1: how many candidate entries land in each row.
  const counts = new Int32Array(ndof)
  for (let a = 0; a < nd; a++) {
    const b = designList[a]! * 8
    for (let i = 0; i < 8; i++) {
      const r = edof[b + i]!
      counts[r] = counts[r]! + 8
    }
  }

  const start = new Int32Array(ndof + 1)
  for (let r = 0; r < ndof; r++) start[r + 1] = start[r]! + counts[r]!
  const total = start[ndof]!

  // Pass 2: scatter the candidate columns into their rows.
  const cursor = start.slice(0, ndof)
  const cand = new Int32Array(total)
  for (let a = 0; a < nd; a++) {
    const b = designList[a]! * 8
    for (let i = 0; i < 8; i++) {
      const r = edof[b + i]!
      let c = cursor[r]!
      for (let j = 0; j < 8; j++) cand[c++] = edof[b + j]!
      cursor[r] = c
    }
  }

  // Pass 3: sort and dedupe each row.
  const rowPtr = new Int32Array(ndof + 1)
  const colTmp = new Int32Array(total)
  let write = 0
  for (let r = 0; r < ndof; r++) {
    rowPtr[r] = write
    const lo = start[r]!
    const hi = start[r + 1]!
    if (hi === lo) continue
    const slice = cand.subarray(lo, hi)
    slice.sort()
    let prev = -1
    for (let k = 0; k < slice.length; k++) {
      const c = slice[k]!
      if (c !== prev) {
        colTmp[write++] = c
        prev = c
      }
    }
  }
  rowPtr[ndof] = write
  const nnz = write
  const colIdx = colTmp.slice(0, nnz)

  // Pass 4: element -> CSR scatter map, and the diagonal positions.
  const scatter = new Int32Array(nd * 64)
  for (let a = 0; a < nd; a++) {
    const b = designList[a]! * 8
    for (let i = 0; i < 8; i++) {
      const r = edof[b + i]!
      const rlo = rowPtr[r]!
      const rhi = rowPtr[r + 1]!
      for (let j = 0; j < 8; j++) {
        scatter[a * 64 + i * 8 + j] = binarySearch(colIdx, rlo, rhi, edof[b + j]!)
      }
    }
  }

  const diagPos = new Int32Array(ndof).fill(-1)
  for (let r = 0; r < ndof; r++) {
    const p = binarySearch(colIdx, rowPtr[r]!, rowPtr[r + 1]!, r)
    diagPos[r] = p
  }

  return { rowPtr, colIdx, scatter, diagPos, nnz }
}

function binarySearch(a: Int32Array, lo: number, hi: number, target: number): number {
  let l = lo
  let h = hi - 1
  while (l <= h) {
    const m = (l + h) >> 1
    const v = a[m]!
    if (v === target) return m
    if (v < target) l = m + 1
    else h = m - 1
  }
  return -1
}

/**
 * Modified SIMP with the concordance multiplier folded in:
 *
 *   E(e)      = w_e * (Emin + rho^p * (E0 - Emin))
 *   dE/drho   = w_e * p * rho^(p-1) * (E0 - Emin)
 *
 * Emin is 1e-6 rather than top88's 1e-9. Raised three decades because the user-driven
 * seed makes thin one-node hinges and near-islands likely, and Emin sets the floor on
 * cond(K) contributed by any such feature the connectivity pass fails to catch. 1e-6 is
 * still six decades below E0 -- visually indistinguishable from void -- but bounds the
 * worst uncaught contrast at 1e6 instead of 1e9, and guarantees K is SPD unconditionally.
 */
export const E0 = 1.0
export const EMIN = 1e-6
export const RHO_MIN = 1e-3

export function youngs(rho: number, w: number, p: number): number {
  return w * (EMIN + Math.pow(rho, p) * (E0 - EMIN))
}

export function dYoungs(rho: number, w: number, p: number): number {
  return w * p * Math.pow(rho, p - 1) * (E0 - EMIN)
}

/**
 * Assemble K into `values`. One pass, 64 scattered accumulations per element.
 *
 * `diag` is filled from diagPos as a by-product, which is the Jacobi preconditioner --
 * one of the reasons to prefer an assembled matrix. Constrained rows get a unit
 * diagonal so the preconditioner cannot divide by zero, and any DOF with a
 * non-positive diagonal (an untouched one) is likewise set to 1.
 */
export function assemble(
  values: Float64Array,
  diag: Float64Array,
  mesh: Mesh,
  pattern: Pattern,
  rho: Float64Array,
  w: Float64Array,
  p: number,
  fixedMask: Uint8Array,
): void {
  values.fill(0)
  const { designList } = mesh
  const { scatter, diagPos } = pattern
  for (let a = 0; a < designList.length; a++) {
    const e = designList[a]!
    const Ee = youngs(rho[e]!, w[e]!, p)
    const base = a * 64
    for (let k = 0; k < 64; k++) {
      values[scatter[base + k]!]! += Ee * KE[k]!
    }
  }
  for (let i = 0; i < mesh.ndof; i++) {
    const pos = diagPos[i]!
    const v = pos >= 0 ? values[pos]! : 0
    diag[i] = fixedMask[i] || v <= 0 ? 1 : v
  }
}

/** Dense reference assembly, for the small-mesh correctness test only. */
export function assembleDense(
  mesh: Mesh,
  rho: Float64Array,
  w: Float64Array,
  p: number,
): Float64Array {
  const { ndof, edof, designList } = mesh
  const K = new Float64Array(ndof * ndof)
  for (let a = 0; a < designList.length; a++) {
    const e = designList[a]!
    const Ee = youngs(rho[e]!, w[e]!, p)
    const b = e * 8
    for (let i = 0; i < 8; i++) {
      const r = edof[b + i]!
      for (let j = 0; j < 8; j++) {
        K[r * ndof + edof[b + j]!]! += Ee * KE[i * 8 + j]!
      }
    }
  }
  return K
}
