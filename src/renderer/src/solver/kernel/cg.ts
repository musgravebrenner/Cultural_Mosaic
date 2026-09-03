import type { Pattern } from './assembly'

/**
 * Jacobi-preconditioned conjugate gradient with explicit fixed-DOF masking.
 *
 * THE INVARIANT that makes constrained DOFs correct without touching the matrix:
 * every vector in the Krylov space is exactly zero at constrained DOFs. That is
 * obtained by zeroing f, u0, the residual after forming it, and the output of every
 * matvec.
 *
 * Note what is NOT done: the matrix is never modified to impose boundary conditions --
 * no row or column zeroing. That would invalidate the precomputed scatter map, and it
 * is unnecessary anyway. Only two of the maskings below are required for correctness
 * (r and q); the others are cheap assertions of intent.
 */

export interface CgResult {
  iters: number
  /** Relative residual ||r|| / ||f||. */
  residual: number
  converged: boolean
}

export function spmv(
  values: Float64Array,
  rowPtr: Int32Array,
  colIdx: Int32Array,
  x: Float64Array,
  out: Float64Array,
): void {
  const n = rowPtr.length - 1
  for (let r = 0; r < n; r++) {
    let s = 0
    const hi = rowPtr[r + 1]!
    for (let k = rowPtr[r]!; k < hi; k++) s += values[k]! * x[colIdx[k]!]!
    out[r] = s
  }
}

function dot(a: Float64Array, b: Float64Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

function norm2(a: Float64Array): number {
  return Math.sqrt(dot(a, a))
}

/** Reusable scratch, so a 120-iteration run allocates nothing after the first solve. */
export interface CgWorkspace {
  r: Float64Array
  z: Float64Array
  p: Float64Array
  q: Float64Array
}

export function createCgWorkspace(ndof: number): CgWorkspace {
  return {
    r: new Float64Array(ndof),
    z: new Float64Array(ndof),
    p: new Float64Array(ndof),
    q: new Float64Array(ndof),
  }
}

export function pcg(
  values: Float64Array,
  pattern: Pattern,
  diag: Float64Array,
  f: Float64Array,
  u: Float64Array,
  fixedList: Int32Array,
  tolRel: number,
  maxIter: number,
  ws: CgWorkspace,
): CgResult {
  const { rowPtr, colIdx } = pattern
  const n = f.length
  const { r, z, p, q } = ws

  // Enforce rather than assume: a caller that forgot to zero a loaded-and-pinned DOF
  // would otherwise get a silently inconsistent initial residual.
  for (let k = 0; k < fixedList.length; k++) {
    const c = fixedList[k]!
    f[c] = 0
    u[c] = 0
  }

  spmv(values, rowPtr, colIdx, u, q)
  for (let i = 0; i < n; i++) r[i] = f[i]! - q[i]!
  for (let k = 0; k < fixedList.length; k++) r[fixedList[k]!] = 0 // <-- required

  const bnorm = norm2(f)
  if (bnorm === 0) {
    u.fill(0)
    return { iters: 0, residual: 0, converged: true }
  }
  const tol = Math.max(tolRel * bnorm, 1e-300)

  for (let i = 0; i < n; i++) z[i] = r[i]! / diag[i]!
  for (let k = 0; k < fixedList.length; k++) z[fixedList[k]!] = 0
  p.set(z)
  let rz = dot(r, z)

  for (let it = 0; it < maxIter; it++) {
    spmv(values, rowPtr, colIdx, p, q)
    for (let k = 0; k < fixedList.length; k++) q[fixedList[k]!] = 0 // <-- required

    const pq = dot(p, q)
    // K is SPD by construction (Emin floor + positive w), so pq > 0. Bail rather than
    // produce NaN if a caller ever breaks that.
    if (!(pq > 0)) return { iters: it, residual: norm2(r) / bnorm, converged: false }

    const alpha = rz / pq
    for (let i = 0; i < n; i++) {
      u[i]! += alpha * p[i]!
      r[i]! -= alpha * q[i]!
    }

    const rn = norm2(r)
    if (rn <= tol) return { iters: it + 1, residual: rn / bnorm, converged: true }

    for (let i = 0; i < n; i++) z[i] = r[i]! / diag[i]!
    for (let k = 0; k < fixedList.length; k++) z[fixedList[k]!] = 0
    const rzNew = dot(r, z)
    const beta = rzNew / rz
    rz = rzNew
    // p stays zero at constrained DOFs automatically, since z and p both are.
    for (let i = 0; i < n; i++) p[i] = z[i]! + beta * p[i]!
  }

  return { iters: maxIter, residual: norm2(r) / bnorm, converged: false }
}

/**
 * Adaptive tolerance. Early iterations take large steps on gradients that do not need
 * to be accurate; converged ones tighten automatically. Worth about 1.3-1.6x for free,
 * and inexact solves at this level are established practice for topology optimization
 * (Amir & Sigmund).
 */
export function adaptiveTolerance(changeLinf: number): number {
  return Math.min(1e-3, Math.max(1e-6, 0.02 * changeLinf))
}

export const TOL_ANIMATION = 1e-4
export const TOL_EXPORT = 1e-7
/**
 * On non-convergence the caller PROCEEDS and surfaces the residual. Never hang: a
 * stalled solve should degrade the frame, not the app.
 */
export const MAXITER_ANIMATION = 600
export const MAXITER_EXPORT = 4000
