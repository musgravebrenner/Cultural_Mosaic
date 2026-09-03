import { describe, it, expect } from 'vitest'
import { buildMesh, rectangularState, untouchedDofs, VOID_PASSIVE } from './mesh'
import { buildPattern, assemble, assembleDense, youngs, EMIN } from './assembly'
import { createCgWorkspace, pcg, spmv } from './cg'
import { NU, elementEnergy } from './elementStiffness'

/**
 * Correctness tests for the linear FEA core. Ordered by how much real breakage they
 * catch, and every one of them exists because the corresponding bug produces a
 * plausible-looking wrong answer rather than an obvious failure.
 */

interface Problem {
  mesh: ReturnType<typeof buildMesh>
  pattern: ReturnType<typeof buildPattern>
  values: Float64Array
  diag: Float64Array
  rho: Float64Array
  w: Float64Array
  f: Float64Array
  u: Float64Array
  fixedMask: Uint8Array
  fixedList: Int32Array
}

function makeProblem(
  nelx: number,
  nely: number,
  fill: number,
  fixedDofs: Iterable<number>,
  loads: readonly [number, number][],
  state?: Uint8Array,
): Problem {
  const mesh = buildMesh(nelx, nely, state ?? rectangularState(nelx, nely))
  const pattern = buildPattern(mesh)
  const values = new Float64Array(pattern.nnz)
  const diag = new Float64Array(mesh.ndof)
  const rho = new Float64Array(mesh.nelem).fill(fill)
  const w = new Float64Array(mesh.nelem).fill(1)
  const f = new Float64Array(mesh.ndof)
  const u = new Float64Array(mesh.ndof)

  const fixedMask = untouchedDofs(mesh)
  for (const d of fixedDofs) fixedMask[d] = 1
  const list: number[] = []
  for (let i = 0; i < mesh.ndof; i++) if (fixedMask[i]) list.push(i)

  for (const [d, v] of loads) f[d] = v
  return {
    mesh,
    pattern,
    values,
    diag,
    rho,
    w,
    f,
    u,
    fixedMask,
    fixedList: Int32Array.from(list),
  }
}

function solve(pr: Problem, p = 3, tol = 1e-10, maxIter = 20000): ReturnType<typeof pcg> {
  assemble(pr.values, pr.diag, pr.mesh, pr.pattern, pr.rho, pr.w, p, pr.fixedMask)
  return pcg(
    pr.values,
    pr.pattern,
    pr.diag,
    pr.f,
    pr.u,
    pr.fixedList,
    tol,
    maxIter,
    createCgWorkspace(pr.mesh.ndof),
  )
}

/** node index for (ix, iy) with iy increasing UP. */
function nodeAt(nelx: number, ix: number, iy: number): number {
  return iy * (nelx + 1) + ix
}

describe('mesh index arithmetic', () => {
  it('round-trips element and node indices over the whole grid', () => {
    const nelx = 7
    const nely = 5
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    expect(mesh.nelem).toBe(35)
    expect(mesh.ndof).toBe(2 * 8 * 6)
    for (let ey = 0; ey < nely; ey++) {
      for (let ex = 0; ex < nelx; ex++) {
        const e = ey * nelx + ex
        expect(e % nelx).toBe(ex)
        expect((e - (e % nelx)) / nelx).toBe(ey)
      }
    }
  })

  it('produces edofs matching a brute-force reference for every element', () => {
    const nelx = 6
    const nely = 4
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    for (let ey = 0; ey < nely; ey++) {
      for (let ex = 0; ex < nelx; ex++) {
        const e = ey * nelx + ex
        const bl = nodeAt(nelx, ex, ey)
        const br = nodeAt(nelx, ex + 1, ey)
        const tr = nodeAt(nelx, ex + 1, ey + 1)
        const tl = nodeAt(nelx, ex, ey + 1)
        const want = [2 * bl, 2 * bl + 1, 2 * br, 2 * br + 1, 2 * tr, 2 * tr + 1, 2 * tl, 2 * tl + 1]
        for (let k = 0; k < 8; k++) expect(mesh.edof[e * 8 + k]!, `e=${e} k=${k}`).toBe(want[k]!)
      }
    }
  })

  it('partitions design, free and solid lists consistently', () => {
    const nelx = 5
    const nely = 5
    const state = rectangularState(nelx, nely)
    state[0] = VOID_PASSIVE
    state[1] = VOID_PASSIVE
    state[7] = 2 // SOLID_PASSIVE
    const mesh = buildMesh(nelx, nely, state)
    expect(mesh.designList.length).toBe(23)
    expect(mesh.freeList.length).toBe(22)
    expect(mesh.nSolid).toBe(1)
  })

  it('flags DOFs no assembled element touches', () => {
    const nelx = 4
    const nely = 4
    const state = rectangularState(nelx, nely)
    // Void the whole bottom row: its lower nodes become untouched.
    for (let ex = 0; ex < nelx; ex++) state[ex] = VOID_PASSIVE
    const mesh = buildMesh(nelx, nely, state)
    const untouched = untouchedDofs(mesh)
    for (let ix = 0; ix <= nelx; ix++) {
      const nd = nodeAt(nelx, ix, 0)
      expect(untouched[2 * nd]!, `node (${ix},0)`).toBe(1)
    }
    const mid = nodeAt(nelx, 2, 2)
    expect(untouched[2 * mid]!).toBe(0)
  })
})

describe('CSR pattern', () => {
  it('is sorted, deduped and symmetric in structure', () => {
    const mesh = buildMesh(6, 4, rectangularState(6, 4))
    const pat = buildPattern(mesh)
    const present = new Set<string>()
    for (let r = 0; r < mesh.ndof; r++) {
      for (let k = pat.rowPtr[r]!; k < pat.rowPtr[r + 1]!; k++) {
        if (k > pat.rowPtr[r]!) expect(pat.colIdx[k]!).toBeGreaterThan(pat.colIdx[k - 1]!)
        present.add(`${r},${pat.colIdx[k]!}`)
      }
    }
    for (const key of present) {
      const [r, c] = key.split(',')
      expect(present.has(`${c},${r}`), `missing transpose of ${key}`).toBe(true)
    }
  })

  it('finds every diagonal entry for a touched DOF', () => {
    const mesh = buildMesh(5, 5, rectangularState(5, 5))
    const pat = buildPattern(mesh)
    for (let r = 0; r < mesh.ndof; r++) {
      expect(pat.diagPos[r]!, `dof ${r}`).toBeGreaterThanOrEqual(0)
      expect(pat.colIdx[pat.diagPos[r]!]!).toBe(r)
    }
  })

  it('maps every element local entry to a valid position', () => {
    const mesh = buildMesh(5, 5, rectangularState(5, 5))
    const pat = buildPattern(mesh)
    for (let k = 0; k < pat.scatter.length; k++) {
      expect(pat.scatter[k]!, `scatter[${k}]`).toBeGreaterThanOrEqual(0)
      expect(pat.scatter[k]!).toBeLessThan(pat.nnz)
    }
  })

  it('has nnz close to 18 per DOF for a large interior', () => {
    // Each node couples to a 3x3 node stencil = 9 nodes = 18 DOFs.
    const mesh = buildMesh(40, 40, rectangularState(40, 40))
    const pat = buildPattern(mesh)
    expect(pat.nnz / mesh.ndof).toBeGreaterThan(14)
    expect(pat.nnz / mesh.ndof).toBeLessThan(18.1)
  })

  it('never references a voided element', () => {
    const nelx = 6
    const nely = 6
    const state = rectangularState(nelx, nely)
    for (let e = 0; e < 10; e++) state[e] = VOID_PASSIVE
    const mesh = buildMesh(nelx, nely, state)
    expect(mesh.designList.length).toBe(nelx * nely - 10)
    const pat = buildPattern(mesh)
    expect(pat.scatter.length).toBe(mesh.designList.length * 64)
  })
})

describe('assembly', () => {
  it('matches a dense reference exactly', () => {
    const nelx = 4
    const nely = 4
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const pat = buildPattern(mesh)
    const rho = new Float64Array(mesh.nelem)
    const w = new Float64Array(mesh.nelem)
    for (let e = 0; e < mesh.nelem; e++) {
      rho[e] = 0.2 + 0.7 * ((e * 37) % 11) / 11
      w[e] = 0.3 + 0.6 * ((e * 13) % 7) / 7
    }
    const values = new Float64Array(pat.nnz)
    const diag = new Float64Array(mesh.ndof)
    assemble(values, diag, mesh, pat, rho, w, 3, new Uint8Array(mesh.ndof))

    const dense = assembleDense(mesh, rho, w, 3)
    for (let r = 0; r < mesh.ndof; r++) {
      for (let k = pat.rowPtr[r]!; k < pat.rowPtr[r + 1]!; k++) {
        const c = pat.colIdx[k]!
        expect(values[k]!, `(${r},${c})`).toBeCloseTo(dense[r * mesh.ndof + c]!, 12)
      }
    }
  })

  it('is symmetric', () => {
    const mesh = buildMesh(5, 4, rectangularState(5, 4))
    const pat = buildPattern(mesh)
    const rho = new Float64Array(mesh.nelem).fill(0.6)
    const w = new Float64Array(mesh.nelem).fill(1)
    const values = new Float64Array(pat.nnz)
    const diag = new Float64Array(mesh.ndof)
    assemble(values, diag, mesh, pat, rho, w, 3, new Uint8Array(mesh.ndof))
    const get = (r: number, c: number): number => {
      for (let k = pat.rowPtr[r]!; k < pat.rowPtr[r + 1]!; k++) {
        if (pat.colIdx[k]! === c) return values[k]!
      }
      return 0
    }
    for (let r = 0; r < mesh.ndof; r += 3) {
      for (let k = pat.rowPtr[r]!; k < pat.rowPtr[r + 1]!; k++) {
        const c = pat.colIdx[k]!
        expect(values[k]!).toBeCloseTo(get(c, r), 14)
      }
    }
  })

  it('gives a unit diagonal at constrained and untouched DOFs', () => {
    const mesh = buildMesh(4, 4, rectangularState(4, 4))
    const pat = buildPattern(mesh)
    const fixedMask = new Uint8Array(mesh.ndof)
    fixedMask[6] = 1
    const values = new Float64Array(pat.nnz)
    const diag = new Float64Array(mesh.ndof)
    assemble(values, diag, mesh, pat, new Float64Array(mesh.nelem).fill(0.5),
      new Float64Array(mesh.nelem).fill(1), 3, fixedMask)
    expect(diag[6]!).toBe(1)
    for (let i = 0; i < mesh.ndof; i++) expect(diag[i]!).toBeGreaterThan(0)
  })

  it('interpolates modulus per modified SIMP, with w folded in', () => {
    expect(youngs(1, 1, 3)).toBeCloseTo(1, 12)
    expect(youngs(0, 1, 3)).toBeCloseTo(EMIN, 15)
    expect(youngs(0.5, 1, 3)).toBeCloseTo(EMIN + 0.125 * (1 - EMIN), 12)
    // w is a positive scalar multiplier, which is what keeps K SPD unconditionally.
    expect(youngs(0.5, 0.15, 3)).toBeCloseTo(0.15 * (EMIN + 0.125 * (1 - EMIN)), 12)
  })
})

describe('PCG', () => {
  /** A 4x4 cantilever, solvable densely for an exact reference. */
  it('matches a dense Gaussian-elimination solve', () => {
    const nelx = 4
    const nely = 4
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 2)
    const pr = makeProblem(nelx, nely, 1, fixed, [[2 * tip + 1, -1]])
    const res = solve(pr, 3, 1e-12, 5000)
    expect(res.converged).toBe(true)

    // Dense solve with the same constraints.
    const nd = pr.mesh.ndof
    const K = assembleDense(pr.mesh, pr.rho, pr.w, 3)
    const A: number[][] = []
    const b: number[] = []
    const freeIdx: number[] = []
    for (let i = 0; i < nd; i++) if (!pr.fixedMask[i]) freeIdx.push(i)
    for (const r of freeIdx) {
      A.push(freeIdx.map((c) => K[r * nd + c]!))
      b.push(pr.f[r]!)
    }
    const x = gaussianSolve(A, b)
    const dense = new Float64Array(nd)
    freeIdx.forEach((g, k) => {
      dense[g] = x[k]!
    })

    let worst = 0
    for (let i = 0; i < nd; i++) worst = Math.max(worst, Math.abs(pr.u[i]! - dense[i]!))
    expect(worst).toBeLessThan(1e-10)
  })

  it('leaves every constrained DOF exactly zero', () => {
    const nelx = 6
    const nely = 4
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 2)
    const pr = makeProblem(nelx, nely, 1, fixed, [[2 * tip + 1, -1]])
    solve(pr)
    for (const c of pr.fixedList) expect(pr.u[c]!).toBe(0)
  })

  it('drives the free-DOF residual to the requested tolerance', () => {
    const nelx = 8
    const nely = 6
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 3)
    const pr = makeProblem(nelx, nely, 1, fixed, [[2 * tip + 1, -1]])
    const res = solve(pr, 3, 1e-11, 20000)
    expect(res.converged).toBe(true)

    const Ku = new Float64Array(pr.mesh.ndof)
    spmv(pr.values, pr.pattern.rowPtr, pr.pattern.colIdx, pr.u, Ku)
    let fn = 0
    let rn = 0
    for (let i = 0; i < pr.mesh.ndof; i++) {
      if (pr.fixedMask[i]) continue
      rn += (pr.f[i]! - Ku[i]!) ** 2
      fn += pr.f[i]! ** 2
    }
    expect(Math.sqrt(rn)).toBeLessThan(1e-8 * Math.max(Math.sqrt(fn), 1e-30))
  })

  it('returns immediately for a zero load rather than dividing by zero', () => {
    const pr = makeProblem(4, 4, 1, [0, 1, 2, 3], [])
    const res = solve(pr)
    expect(res.converged).toBe(true)
    expect(res.iters).toBe(0)
    for (let i = 0; i < pr.mesh.ndof; i++) expect(pr.u[i]!).toBe(0)
  })

  it('warm-starts to fewer iterations than a cold start', () => {
    const nelx = 12
    const nely = 8
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 4)
    const pr = makeProblem(nelx, nely, 0.5, fixed, [[2 * tip + 1, -1]])
    const cold = solve(pr, 3, 1e-8, 5000)
    // Perturb the densities slightly and re-solve from the previous u.
    for (const e of pr.mesh.freeList) pr.rho[e]! += 0.01
    const warm = solve(pr, 3, 1e-8, 5000)
    expect(warm.iters).toBeLessThan(cold.iters)
  })
})

/**
 * A solid cantilever against Euler-Bernoulli. Catches boundary-condition and
 * load-application bugs, which show up here as a factor of two or a sign flip rather
 * than as a few percent.
 *
 * Q4 bilinear elements are stiff in bending (shear locking), so with only 10 elements
 * through the depth the FEA tip deflection sits a few percent BELOW the analytic beam
 * value. Asserting within 15% is the honest bar.
 */
describe('cantilever vs Euler-Bernoulli', () => {
  it('gets the tip deflection right to within 15 percent', () => {
    const nelx = 60
    const nely = 10
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tipNode = nodeAt(nelx, nelx, nely / 2)
    const F = 1
    const pr = makeProblem(nelx, nely, 1, fixed, [[2 * tipNode + 1, -F]])
    const res = solve(pr, 3, 1e-10, 40000)
    expect(res.converged).toBe(true)

    const L = nelx
    const I = (nely * nely * nely) / 12
    const G = 1 / (2 * (1 + NU))
    // Bending plus a Timoshenko shear correction (k = 5/6 for a rectangle).
    const analytic = (F * L ** 3) / (3 * I) + (F * L) / ((5 / 6) * G * nely)
    const tip = Math.abs(pr.u[2 * tipNode + 1]!)

    expect(tip).toBeGreaterThan(0)
    expect(Math.abs(tip - analytic) / analytic, `fea=${tip} analytic=${analytic}`).toBeLessThan(
      0.15,
    )
  })

  it('deflects downward under a downward load, and scales linearly', () => {
    const nelx = 20
    const nely = 6
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 3)
    const a = makeProblem(nelx, nely, 1, fixed, [[2 * tip + 1, -1]])
    solve(a, 3, 1e-10, 20000)
    const b = makeProblem(nelx, nely, 1, fixed, [[2 * tip + 1, -2]])
    solve(b, 3, 1e-10, 20000)
    expect(a.u[2 * tip + 1]!).toBeLessThan(0)
    expect(b.u[2 * tip + 1]! / a.u[2 * tip + 1]!).toBeCloseTo(2, 6)
  })
})

/**
 * Compliance identity: f^T u must equal sum(E(e) * u_e^T KE u_e). This catches DOF
 * ordering and assembly bugs immediately, and it is cheap enough to assert once per run
 * in a development build.
 */
describe('compliance identity', () => {
  it('agrees between f^T u and the element energy sum', () => {
    const nelx = 10
    const nely = 8
    const fixed: number[] = []
    for (let iy = 0; iy <= nely; iy++) {
      const nd = nodeAt(nelx, 0, iy)
      fixed.push(2 * nd, 2 * nd + 1)
    }
    const tip = nodeAt(nelx, nelx, 4)
    const pr = makeProblem(nelx, nely, 0.5, fixed, [[2 * tip + 1, -1]])
    solve(pr, 3, 1e-12, 20000)

    let fu = 0
    for (let i = 0; i < pr.mesh.ndof; i++) fu += pr.f[i]! * pr.u[i]!

    // Sum of E(e) * u_e^T KE u_e using the packed form.
    let sum = 0
    for (const e of pr.mesh.designList) {
      sum += youngs(pr.rho[e]!, pr.w[e]!, 3) * elementEnergy(pr.u, pr.mesh.edof, e * 8)
    }
    expect(sum).toBeCloseTo(fu, 8)
  })
})

/** Dense Gaussian elimination with partial pivoting, for the reference solve only. */
function gaussianSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c++) {
    let piv = c
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r]![c]!) > Math.abs(M[piv]![c]!)) piv = r
    }
    const tmp = M[c]!
    M[c] = M[piv]!
    M[piv] = tmp
    const d = M[c]![c]!
    for (let j = c; j <= n; j++) M[c]![j]! /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const factor = M[r]![c]!
      if (factor === 0) continue
      for (let j = c; j <= n; j++) M[r]![j]! -= factor * M[c]![j]!
    }
  }
  return M.map((row) => row[n]!)
}
