import { describe, it, expect } from 'vitest'
import {
  KE,
  KE_UPPER,
  NU,
  RIGID_MODES,
  buildKE,
  constitutive,
  elementEnergy,
  upperIndex,
} from './elementStiffness'

/**
 * The highest-value test in the suite.
 *
 * A wrong element stiffness matrix, or a wrong local DOF ordering, produces a system
 * that is still symmetric, still positive semi-definite, and still solves -- it just
 * gives quietly wrong displacements, and therefore quietly wrong artwork. None of the
 * later benchmarks can distinguish that from a bug elsewhere.
 */

describe('KE golden values', () => {
  /**
   * Exact rational entries at nu = 0.3, where the scale factor is 1/21.84:
   *   a = 45/91, b = 5/28, c = -55/182, d = -5/364, e = -45/182, f = 5/91
   */
  it('matches the exact rationals to machine precision', () => {
    const a = 45 / 91
    const b = 5 / 28
    const c = -55 / 182
    const d = -5 / 364
    const e = -45 / 182
    const f = 5 / 91

    // prettier-ignore
    const golden = [
      a, b, c, d, e, -b, f, -d,
      b, a, -d, f, -b, e, d, c,
      c, -d, a, -b, f, d, e, b,
      d, f, -b, a, -d, c, b, e,
      e, -b, f, -d, a, b, c, d,
      -b, e, d, c, b, a, -d, f,
      f, d, e, b, c, -d, a, -b,
      -d, c, b, e, d, f, -b, a,
    ]
    for (let i = 0; i < 64; i++) {
      expect(KE[i]!, `KE[${Math.floor(i / 8)}][${i % 8}]`).toBeCloseTo(golden[i]!, 15)
    }
  })

  it('has KE[0][0] = 45/91 exactly', () => {
    expect(KE[0]!).toBeCloseTo(0.4945054945054945, 15)
  })

  it('has trace 8 * 45/91', () => {
    let tr = 0
    for (let i = 0; i < 8; i++) tr += KE[i * 8 + i]!
    expect(tr).toBeCloseTo((8 * 45) / 91, 13)
  })
})

describe('KE structural properties', () => {
  it('is exactly symmetric', () => {
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        expect(KE[i * 8 + j]!, `(${i},${j})`).toBeCloseTo(KE[j * 8 + i]!, 16)
      }
    }
  })

  /**
   * Every row summing to zero means both rigid translations lie in the null space: a
   * uniform displacement must generate no force.
   */
  it('has zero row sums', () => {
    for (let i = 0; i < 8; i++) {
      let s = 0
      for (let j = 0; j < 8; j++) s += KE[i * 8 + j]!
      expect(s, `row ${i}`).toBeCloseTo(0, 14)
    }
  })

  /**
   * The rigid rotation must also be in the null space. This one is the real DOF-ordering
   * check -- the translations pass under many wrong orderings, but the rotation vector
   * only annihilates KE when the local node order genuinely runs counter-clockwise from
   * the bottom-left.
   */
  it('annihilates all three rigid-body modes, so rank is 5', () => {
    for (const [k, mode] of RIGID_MODES.entries()) {
      let worst = 0
      for (let i = 0; i < 8; i++) {
        let s = 0
        for (let j = 0; j < 8; j++) s += KE[i * 8 + j]! * mode[j]!
        worst = Math.max(worst, Math.abs(s))
      }
      expect(worst, `rigid mode ${k}`).toBeLessThan(1e-14)
    }
  })

  it('is positive semi-definite on non-rigid deformations', () => {
    // A pure stretch and a pure shear must both store positive energy.
    const stretch = Float64Array.from([0, 0, 1, 0, 1, 0, 0, 0])
    const shear = Float64Array.from([0, 0, 0, 0, 1, 0, 1, 0])
    for (const [name, v] of [
      ['stretch', stretch],
      ['shear', shear],
    ] as const) {
      let s = 0
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) s += v[i]! * KE[i * 8 + j]! * v[j]!
      }
      expect(s, name).toBeGreaterThan(0)
    }
  })

  it('builds a valid matrix across the physical range of Poisson ratios', () => {
    for (const nu of [0, 0.1, 0.2, 0.3, 0.4, 0.49]) {
      const k = buildKE(nu)
      for (let i = 0; i < 8; i++) {
        let s = 0
        for (let j = 0; j < 8; j++) {
          s += k[i * 8 + j]!
          expect(k[i * 8 + j]!, `nu=${nu} (${i},${j})`).toBeCloseTo(k[j * 8 + i]!, 15)
        }
        expect(s, `nu=${nu} row ${i}`).toBeCloseTo(0, 13)
      }
    }
  })
})

/**
 * The patch test. This is what catches plane-stress vs plane-strain, a wrong Poisson
 * ratio, and a wrong DOF ordering -- all of which otherwise produce plausible-looking
 * wrong answers rather than obvious failures.
 *
 * Impose the exact uniaxial-stress field u_x = eps*x, u_y = -nu*eps*y on a unit
 * element. With E = 1 the stress is (eps, 0, 0), the strain energy density is
 * 0.5*eps^2, and the volume is 1, so the strain energy is 0.5*eps^2 and
 *
 *   u^T KE u = 2 * (0.5 * eps^2) = eps^2
 *
 * At eps = 1e-3 that is exactly 1e-6, and a correct element reproduces it to rounding.
 */
describe('patch test', () => {
  const eps = 1e-3

  it('reproduces the exact uniaxial strain energy', () => {
    // Nodes CCW from bottom-left: (0,0) (1,0) (1,1) (0,1).
    const xs = [0, 1, 1, 0]
    const ys = [0, 0, 1, 1]
    const u = new Float64Array(8)
    for (let k = 0; k < 4; k++) {
      u[2 * k] = eps * xs[k]!
      u[2 * k + 1] = -NU * eps * ys[k]!
    }
    let energy2 = 0
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) energy2 += u[i]! * KE[i * 8 + j]! * u[j]!
    }
    expect(energy2).toBeCloseTo(eps * eps, 18)
  })

  it('reproduces a uniaxial field in the y direction too', () => {
    const xs = [0, 1, 1, 0]
    const ys = [0, 0, 1, 1]
    const u = new Float64Array(8)
    for (let k = 0; k < 4; k++) {
      u[2 * k] = -NU * eps * xs[k]!
      u[2 * k + 1] = eps * ys[k]!
    }
    let energy2 = 0
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) energy2 += u[i]! * KE[i * 8 + j]! * u[j]!
    }
    expect(energy2).toBeCloseTo(eps * eps, 18)
  })

  it('stores the expected energy in pure shear', () => {
    // u_x = gamma*y, u_y = 0. Shear strain gamma, G = 1/(2(1+nu)),
    // energy = 0.5 * G * gamma^2 * V, so u^T KE u = G * gamma^2.
    const ys = [0, 0, 1, 1]
    const gamma = 1e-3
    const u = new Float64Array(8)
    for (let k = 0; k < 4; k++) {
      u[2 * k] = gamma * ys[k]!
      u[2 * k + 1] = 0
    }
    let energy2 = 0
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) energy2 += u[i]! * KE[i * 8 + j]! * u[j]!
    }
    const G = 1 / (2 * (1 + NU))
    expect(energy2).toBeCloseTo(G * gamma * gamma, 18)
  })
})

describe('packed upper triangle', () => {
  it('indexes consistently with the full matrix', () => {
    for (let i = 0; i < 8; i++) {
      for (let j = i; j < 8; j++) {
        expect(KE_UPPER[upperIndex(i, j)]!, `(${i},${j})`).toBe(KE[i * 8 + j]!)
      }
    }
  })

  it('has 36 entries and a bijective index map', () => {
    expect(KE_UPPER).toHaveLength(36)
    const seen = new Set<number>()
    for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) seen.add(upperIndex(i, j))
    expect(seen.size).toBe(36)
    expect(Math.max(...seen)).toBe(35)
    expect(Math.min(...seen)).toBe(0)
  })

  it('gives the same energy as the full quadratic form', () => {
    const u = Float64Array.from([0.3, -0.1, 0.7, 0.25, -0.4, 0.9, 0.05, -0.6])
    const edof = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    let full = 0
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) full += u[i]! * KE[i * 8 + j]! * u[j]!
    }
    expect(elementEnergy(u, edof, 0)).toBeCloseTo(full, 12)
  })

  it('returns zero energy for a rigid mode and positive otherwise', () => {
    const edof = Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7])
    for (const mode of RIGID_MODES) {
      expect(Math.abs(elementEnergy(mode, edof, 0))).toBeLessThan(1e-14)
    }
    const deformed = Float64Array.from([0, 0, 0.01, 0, 0.01, 0, 0, 0])
    expect(elementEnergy(deformed, edof, 0)).toBeGreaterThan(0)
  })

  it('honours the base offset so it can read a shared edof table', () => {
    const u = Float64Array.from([0.3, -0.1, 0.7, 0.25, -0.4, 0.9, 0.05, -0.6])
    const edof = Int32Array.from([9, 9, 0, 1, 2, 3, 4, 5, 6, 7])
    expect(elementEnergy(u, edof, 2)).toBeCloseTo(
      elementEnergy(u, Int32Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 0),
      12,
    )
  })
})

describe('constitutive matrix', () => {
  it('matches the plane-stress form at nu = 0.3', () => {
    const D = constitutive(0.3)
    expect(D[0]!).toBeCloseTo(1.0989010989010988, 12)
    expect(D[1]!).toBeCloseTo(0.32967032967032966, 12)
    expect(D[2]!).toBe(0)
    expect(D[4]!).toBeCloseTo(1.0989010989010988, 12)
    expect(D[8]!).toBeCloseTo(0.38461538461538464, 12)
  })

  it('is symmetric and positive definite', () => {
    const D = constitutive(0.3)
    expect(D[1]!).toBeCloseTo(D[3]!, 15)
    expect(D[0]!).toBeGreaterThan(0)
    // 2x2 leading minor of the normal block.
    expect(D[0]! * D[4]! - D[1]! * D[3]!).toBeGreaterThan(0)
    expect(D[8]!).toBeGreaterThan(0)
  })
})
