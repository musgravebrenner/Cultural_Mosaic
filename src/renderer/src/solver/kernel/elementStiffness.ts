/**
 * The 8x8 Q4 plane-stress element stiffness matrix for a unit square.
 *
 * Built from the standard A11/A12/B11/B12 block form (Sigmund's top.m, Andreassen et
 * al.'s top88) rather than hardcoded decimals, so the value for any Poisson ratio is
 * exact and auditable:
 *
 *   A  = (A11 + nu*B11) / (24*(1 - nu^2))
 *   B  = (A12 + nu*B12) / (24*(1 - nu^2))
 *   KE = [[A, B], [B^T, A]]
 *
 * LOCAL DOF ORDERING: counter-clockwise from the bottom-left corner, in physical y-up
 * coordinates, x before y at each node:
 *
 *   [ux0, uy0, ux1, uy1, ux2, uy2, ux3, uy3]  for nodes  (0,0) (1,0) (1,1) (0,1)
 *
 * This ordering is not a convention you can choose freely -- it is what KE encodes.
 * Getting it wrong produces a matrix that is still symmetric, still positive
 * semi-definite, and still solves, but gives quietly wrong displacements. That is why
 * the patch test exists.
 *
 * Because the elements are squares, KE is EXACTLY independent of the element size h:
 * the strain-displacement matrix B scales as 1/h and the area as h^2, so K ~ h^2/h^2.
 * Using h = 1 is not an approximation. Do not introduce an h factor anywhere -- it is a
 * classic source of silent error.
 */

// prettier-ignore
const A11 = [
  [12, 3, -6, -3],
  [3, 12, 3, 0],
  [-6, 3, 12, -3],
  [-3, 0, -3, 12],
]
// prettier-ignore
const A12 = [
  [-6, -3, 0, 3],
  [-3, -6, -3, -6],
  [0, -3, -6, 3],
  [3, -6, 3, -6],
]
// prettier-ignore
const B11 = [
  [-4, 3, -2, 9],
  [3, -4, -9, 4],
  [-2, -9, -4, -3],
  [9, 4, -3, -4],
]
// prettier-ignore
const B12 = [
  [2, -3, 4, -9],
  [-3, 2, 9, -2],
  [4, 9, 2, 3],
  [-9, -2, 3, 2],
]

/** Row-major 8x8, as a Float64Array of 64. */
export function buildKE(nu: number): Float64Array {
  const s = 1 / (24 * (1 - nu * nu))
  const A: number[][] = []
  const B: number[][] = []
  for (let i = 0; i < 4; i++) {
    A.push([])
    B.push([])
    for (let j = 0; j < 4; j++) {
      A[i]!.push((A11[i]![j]! + nu * B11[i]![j]!) * s)
      B[i]!.push((A12[i]![j]! + nu * B12[i]![j]!) * s)
    }
  }
  const KE = new Float64Array(64)
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      KE[i * 8 + j] = A[i]![j]! // top-left  = A
      KE[i * 8 + (j + 4)] = B[i]![j]! // top-right = B
      KE[(i + 4) * 8 + j] = B[j]![i]! // bottom-left = B^T
      KE[(i + 4) * 8 + (j + 4)] = A[i]![j]! // bottom-right = A
    }
  }
  return KE
}

export const NU = 0.3
export const KE = buildKE(NU)

/**
 * Packed upper triangle of KE, 36 entries in row-major order (i <= j).
 * Halves the flops of the quadratic form u^T KE u in the sensitivity pass.
 */
export const KE_UPPER = ((): Float64Array => {
  const out = new Float64Array(36)
  let k = 0
  for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) out[k++] = KE[i * 8 + j]!
  return out
})()

/**
 * Index into KE_UPPER for i <= j.
 *
 * Rows 0..i-1 contribute (8 - r) entries each, so the offset to the start of row i is
 * sum(8 - r) for r < i, which is 8i - i(i-1)/2 = i(17 - i)/2.
 */
export function upperIndex(i: number, j: number): number {
  return (i * (17 - i)) / 2 + (j - i)
}

/**
 * u^T KE u for one element, via the packed upper triangle. 36 terms instead of 64.
 * This is the unit-modulus strain energy times two, and it is non-negative.
 */
export function elementEnergy(u: Float64Array, edof: Int32Array, base: number): number {
  let s = 0
  let k = 0
  for (let i = 0; i < 8; i++) {
    const ui = u[edof[base + i]!]!
    s += KE_UPPER[k++]! * ui * ui
    for (let j = i + 1; j < 8; j++) {
      s += 2 * KE_UPPER[k++]! * ui * u[edof[base + j]!]!
    }
  }
  return s
}

/**
 * Plane-stress constitutive matrix, needed for the patch test and for the optional von
 * Mises stress overlay.
 */
export function constitutive(nu: number): Float64Array {
  const c = 1 / (1 - nu * nu)
  // prettier-ignore
  return Float64Array.from([
    c, c * nu, 0,
    c * nu, c, 0,
    0, 0, c * (1 - nu) / 2,
  ])
}

export const D_PLANE_STRESS = constitutive(NU)

/** The two rigid translations and the rigid rotation, which span KE's null space. */
export const RIGID_MODES: readonly Float64Array[] = [
  Float64Array.from([1, 0, 1, 0, 1, 0, 1, 0]),
  Float64Array.from([0, 1, 0, 1, 0, 1, 0, 1]),
  // Rotation about the centroid (0.5, 0.5): u = (-(y - 0.5), x - 0.5).
  Float64Array.from([0.5, -0.5, 0.5, 0.5, -0.5, 0.5, -0.5, -0.5]),
]
