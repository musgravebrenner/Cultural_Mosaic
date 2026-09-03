import { describe, it, expect } from 'vitest'
import { Optimizer } from './optimizer'
import type { OptimizerInput } from './optimizer'
import { FREE, SOLID_PASSIVE, VOID_PASSIVE, buildMesh, rectangularState } from './mesh'
import { buildFilter } from './filter'
import { createConnectivity, updateConnectivity, CONNECTIVITY_CONSTANTS } from './connectivity'
import { createOcState, ocUpdate, currentVolume, OC_CONSTANTS } from './ocUpdate'
import { RHO_MIN } from './assembly'
import { BESO_CONSTANTS } from './beso'

/**
 * MBB beam, in this kernel's y-up convention.
 *
 * The classic half-beam: symmetry plane on the left edge (x rolled), a vertical roller
 * at the bottom-right corner, and a unit downward load at the TOP-LEFT node.
 */
function mbb(nelx = 60, nely = 20, over: Partial<OptimizerInput> = {}): OptimizerInput {
  const nnodex = nelx + 1
  const nodeAt = (ix: number, iy: number): number => iy * nnodex + ix

  const fixed: number[] = []
  // Left edge: x fixed (symmetry).
  for (let iy = 0; iy <= nely; iy++) fixed.push(2 * nodeAt(0, iy))
  // Bottom-right corner: y fixed (roller).
  fixed.push(2 * nodeAt(nelx, 0) + 1)

  const loadNode = nodeAt(0, nely)
  return {
    nelx,
    nely,
    state: rectangularState(nelx, nely),
    rho0: new Float32Array(nelx * nely).fill(0.5),
    w: new Float32Array(nelx * nely).fill(1),
    fixedDofs: Uint32Array.from(fixed),
    loadDofs: Uint32Array.from([2 * loadNode + 1]),
    loadValues: Float32Array.from([-1]),
    volumeFraction: 0.5,
    penalty: 3,
    filterRadius: 1.5,
    moveLimit: 0.2,
    mode: 'simp',
    ...over,
  }
}

describe('MBB beam -- iteration 1', () => {
  /**
   * The single best hard number available. Uniform x = 0.5, one solve, no filter and no
   * update involved, so it is path-independent -- unlike a converged compliance, which
   * drifts with Emin, the change tolerance and the iteration count.
   *
   * It validates assembly, DOF ordering, boundary-condition handling and CG accuracy
   * all at once.
   *
   * The value below was RECORDED from this implementation rather than quoted from
   * memory, per the standing rule not to let a remembered literal become a failing
   * test. Cross-validation against an actual top88 run is still outstanding; the
   * physical-invariant assertions that follow depend on no golden value at all, and
   * are the ones that would catch a real regression.
   */
  const RECORDED_C1 = 1007.015

  it('reproduces the recorded iteration-1 compliance', () => {
    const opt = new Optimizer(mbb())
    const m = opt.step(true)
    expect(m.cgConverged).toBe(true)
    expect(m.compliance).toBeCloseTo(RECORDED_C1, 1)
  })

  it('satisfies the compliance identity to solver precision', () => {
    // f^T u must equal sum(E(e) * u_e^T KE u_e). Catches DOF-ordering and assembly bugs
    // immediately, and is independent of any golden value.
    const opt = new Optimizer(mbb())
    opt.step(true)
    expect(opt.complianceIdentityError()).toBeLessThan(1e-8)
  })

  it('scales compliance as 1/E under a uniform stiffness multiplier', () => {
    // Compliance is inversely proportional to a global modulus factor, which is a
    // physical invariant rather than a recorded number.
    const base = new Optimizer(mbb())
    const c1 = base.step(true).compliance
    const half = new Optimizer(mbb(60, 20, { w: new Float32Array(60 * 20).fill(0.5) }))
    const c2 = half.step(true).compliance
    expect(c2 / c1).toBeCloseTo(2, 3)
  })

  it('scales compliance as F^2', () => {
    const a = new Optimizer(mbb())
    const c1 = a.step(true).compliance
    const b = new Optimizer(mbb(60, 20, { loadValues: Float32Array.from([-2]) }))
    const c2 = b.step(true).compliance
    expect(c2 / c1).toBeCloseTo(4, 3)
  })

  it('is mesh-refinement stable', () => {
    // Doubling BOTH dimensions gives a geometrically similar beam: the span doubles but
    // so does the depth, so L^3 and the second moment I both scale by 8 and the
    // compliance is invariant. The ratio is therefore ~1, not ~2.
    const coarse = new Optimizer(mbb(60, 20)).step(true).compliance
    const fine = new Optimizer(mbb(120, 40)).step(true).compliance
    expect(fine / coarse).toBeGreaterThan(0.95)
    expect(fine / coarse).toBeLessThan(1.1)
  }, 180_000)
})

describe('MBB beam -- converged', () => {
  /**
   * Asserted LOOSELY on purpose. The exact converged compliance drifts by a few tenths
   * with Emin, the change tolerance and the iteration count, so a tight literal from
   * anyone's memory would be a failing test that costs an afternoon. The range below is
   * the accepted band for this problem; the recorded value is this implementation's own.
   */
  it('converges into the accepted compliance band', () => {
    const opt = new Optimizer(mbb())
    let last = opt.step()
    for (let k = 0; k < 200 && !last.converged; k++) last = opt.step()

    // This implementation settles at about 203.4, squarely in the range this benchmark
    // is known for. Asserted as a band rather than a literal, because the exact value
    // drifts with Emin, the change tolerance and the iteration count.
    expect(last.compliance).toBeGreaterThan(180)
    expect(last.compliance).toBeLessThan(230)
    // ...and it must be a large improvement on the uniform start.
    expect(last.compliance).toBeLessThan(0.3 * 1007.015)
  }, 300_000)

  /**
   * The property the connectivity rule was narrowed to protect. An over-broad
   * elimination -- constraining every DOF not reachable from an anchor through SOLID
   * material -- imposes a fictitious rigid boundary on interior soft pockets, one that
   * appears and disappears as the design evolves. Measured effect before the fix: the
   * compliance oscillated by 102 percent across the last ten iterations and never
   * settled, with a third of the domain stuck at intermediate density.
   */
  it('settles instead of oscillating', () => {
    const opt = new Optimizer(mbb())
    const history: number[] = []
    for (let k = 0; k < 90; k++) history.push(opt.step().compliance)
    const tail = history.slice(-10)
    const spread = (Math.max(...tail) - Math.min(...tail)) / Math.min(...tail)
    expect(spread, 'last-10 spread ' + (100 * spread).toFixed(1) + '%').toBeLessThan(0.05)
  }, 300_000)

  it('drives most of the domain to solid or void', () => {
    const opt = new Optimizer(mbb())
    for (let k = 0; k < 90; k++) opt.step()
    let grey = 0
    for (const e of opt.mesh.designList) {
      const r = opt.density[e]!
      if (r > 0.2 && r < 0.8) grey++
    }
    // A converged SIMP result is mostly black and white. A field stuck around a third
    // grey is the signature of an update that never settled.
    expect(grey / opt.mesh.designList.length).toBeLessThan(0.25)
  }, 300_000)

  it('holds the volume constraint throughout', () => {
    const opt = new Optimizer(mbb())
    for (let k = 0; k < 40; k++) {
      const m = opt.step()
      expect(m.volume, `iteration ${m.iteration}`).toBeCloseTo(0.5, 2)
    }
  }, 120_000)

  it('reduces compliance overall and keeps every density in range', () => {
    const opt = new Optimizer(mbb())
    const first = opt.step().compliance
    let last = first
    for (let k = 0; k < 60; k++) last = opt.step().compliance
    expect(last).toBeLessThan(first)
    for (const e of opt.mesh.designList) {
      expect(opt.density[e]!, `elem ${e}`).toBeGreaterThanOrEqual(RHO_MIN - 1e-12)
      expect(opt.density[e]!).toBeLessThanOrEqual(1 + 1e-12)
    }
  }, 120_000)

  it('keeps CG converging at the shipped filter radius', () => {
    // Run at the radius the app actually ships (2.2) rather than the benchmark 1.5.
    // Thicker members condition better, and this is the regime that matters in practice.
    const opt = new Optimizer(mbb(60, 20, { filterRadius: 2.2 }))
    let worst = 0
    let allConverged = true
    for (let k = 0; k < 40; k++) {
      const m = opt.step()
      worst = Math.max(worst, m.cgIters)
      if (!m.cgConverged) allConverged = false
    }
    expect(allConverged, 'worst cgIters=' + worst).toBe(true)
  }, 300_000)

  it('is bit-identical across two runs with the same input', () => {
    // The persistence promise depends on this: reopening a file and pressing Run must
    // reproduce the same artwork. No bare Math.random anywhere in the kernel.
    const a = new Optimizer(mbb())
    const b = new Optimizer(mbb())
    for (let k = 0; k < 25; k++) {
      a.step()
      b.step()
    }
    expect(Array.from(a.density)).toEqual(Array.from(b.density))
  }, 120_000)
})

describe('export hardening pass', () => {
  it('drives intermediate densities toward solid and void', () => {
    const opt = new Optimizer(mbb(40, 14))
    for (let k = 0; k < 40; k++) opt.step()
    const greyBefore = countGrey(opt)
    opt.harden(20)
    const greyAfter = countGrey(opt)
    expect(greyAfter).toBeLessThan(greyBefore)
  }, 120_000)

  function countGrey(opt: Optimizer): number {
    let n = 0
    for (const e of opt.mesh.designList) {
      const r = opt.density[e]!
      if (r > 0.2 && r < 0.8) n++
    }
    return n
  }
})

describe('passive elements', () => {
  it('holds SOLID_PASSIVE at 1 and never designs it', () => {
    const nelx = 30
    const nely = 12
    const state = rectangularState(nelx, nely)
    const solids = [0, 1, 2, nelx, nelx + 1]
    for (const e of solids) state[e] = SOLID_PASSIVE
    const opt = new Optimizer(mbb(nelx, nely, { state }))
    for (let k = 0; k < 25; k++) opt.step()
    for (const e of solids) expect(opt.density[e]!, `elem ${e}`).toBe(1)
  }, 120_000)

  it('excludes VOID_PASSIVE from the design and never assembles it', () => {
    const nelx = 24
    const nely = 12
    const state = rectangularState(nelx, nely)
    // Void a block in the middle.
    for (let ey = 4; ey < 8; ey++) for (let ex = 8; ex < 14; ex++) state[ey * nelx + ex] = VOID_PASSIVE
    const opt = new Optimizer(mbb(nelx, nely, { state }))
    for (let k = 0; k < 20; k++) opt.step()
    for (let ey = 4; ey < 8; ey++) {
      for (let ex = 8; ex < 14; ex++) {
        const e = ey * nelx + ex
        expect(opt.mesh.state[e]).toBe(VOID_PASSIVE)
      }
    }
    expect(opt.mesh.designList.length).toBe(nelx * nely - 24)
  }, 120_000)

  it('accounts for passive solids in the volume target', () => {
    const nelx = 24
    const nely = 12
    const state = rectangularState(nelx, nely)
    for (let e = 0; e < 40; e++) state[e] = SOLID_PASSIVE
    const opt = new Optimizer(mbb(nelx, nely, { state, volumeFraction: 0.4 }))
    for (let k = 0; k < 30; k++) opt.step()
    expect(currentVolume(opt.mesh, opt.density)).toBeCloseTo(0.4, 2)
  }, 120_000)
})

/**
 * The test that protects the connectivity pass, and therefore the whole performance
 * story. Without the supported-DOF elimination, an isolated solid island introduces a
 * near-rigid-body mode at eigenvalue ~Emin, and CG needs thousands of iterations
 * instead of tens -- which is exactly the production failure mode.
 */
describe('disconnected material', () => {
  it('detects an island, constrains its DOFs, and keeps CG fast', () => {
    const nelx = 30
    const nely = 20
    const state = rectangularState(nelx, nely)
    const mesh = buildMesh(nelx, nely, state)
    const rho = new Float64Array(mesh.nelem).fill(RHO_MIN)

    // A connected band along the bottom, plus a deliberately isolated blob up top.
    for (let ex = 0; ex < nelx; ex++) {
      for (let ey = 0; ey < 3; ey++) rho[ey * nelx + ex] = 1
    }
    for (let ex = 12; ex < 18; ex++) {
      for (let ey = 14; ey < 18; ey++) rho[ey * nelx + ex] = 1
    }

    const nnodex = nelx + 1
    const pinned = new Uint8Array(mesh.ndof)
    for (let ix = 0; ix <= nelx; ix += nelx) {
      const nd = 0 * nnodex + ix
      pinned[2 * nd] = 1
      pinned[2 * nd + 1] = 1
    }

    const conn = createConnectivity(mesh)
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))

    expect(conn.islands).toBe(1)
    // Every DOF of the isolated blob's interior must be constrained.
    const blobNode = 16 * nnodex + 15
    expect(conn.fixedMask[2 * blobNode]!).toBe(1)
    expect(conn.fixedMask[2 * blobNode + 1]!).toBe(1)
    // ...while the anchored band stays free.
    const bandNode = 1 * nnodex + 15
    expect(conn.fixedMask[2 * bandNode]!).toBe(0)
  })

  it('reports zero islands for a fully connected field', () => {
    const nelx = 20
    const nely = 10
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const rho = new Float64Array(mesh.nelem).fill(1)
    const pinned = new Uint8Array(mesh.ndof)
    pinned[0] = 1
    pinned[1] = 1
    const conn = createConnectivity(mesh)
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))
    expect(conn.islands).toBe(0)
  })

  it('uses 4-connectivity, so a corner touch does not count as connected', () => {
    // Two blocks meeting only at a corner transmit no load through a Q4 mesh. Treating
    // them as connected would mark a genuinely floating island as supported.
    const nelx = 10
    const nely = 10
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const rho = new Float64Array(mesh.nelem).fill(RHO_MIN)
    rho[0 * nelx + 0] = 1
    rho[1 * nelx + 1] = 1
    const pinned = new Uint8Array(mesh.ndof)
    pinned[0] = 1
    pinned[1] = 1
    const conn = createConnectivity(mesh)
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))
    // The diagonal neighbour is its own component, and it is too small to be reported.
    const nd = 2 * (nelx + 1) + 2
    expect(conn.fixedMask[2 * nd]!).toBe(1)
  })

  it('reports a load stranded on a floating island, but not one in open continuum', () => {
    const nelx = 16
    const nely = 12
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const nnodex = nelx + 1
    const rho = new Float64Array(mesh.nelem).fill(RHO_MIN)
    // An anchored band along the bottom, and a separate solid blob floating above it.
    for (let ex = 0; ex < nelx; ex++) rho[ex] = 1
    for (let ey = 8; ey < 11; ey++) for (let ex = 6; ex < 11; ex++) rho[ey * nelx + ex] = 1
    const pinned = new Uint8Array(mesh.ndof)
    pinned[0] = 1
    pinned[1] = 1

    const conn = createConnectivity(mesh)
    const islandNode = 9 * nnodex + 8
    updateConnectivity(conn, mesh, rho, pinned, Uint32Array.from([2 * islandNode + 1]))
    expect(conn.islands).toBe(1)
    expect(conn.unsupportedLoads).toBe(1)

    // A load in genuinely empty continuum is NOT dropped: under SIMP that region is
    // merely soft, not disconnected, and constraining it would impose a fictitious
    // rigid boundary that moves as the design evolves.
    const emptyNode = 4 * nnodex + 14
    updateConnectivity(conn, mesh, rho, pinned, Uint32Array.from([2 * emptyNode + 1]))
    expect(conn.unsupportedLoads).toBe(0)
  })

  it('holds state inside the hysteresis band to avoid period-two chatter', () => {
    const { SOLID_ENTER, SOLID_LEAVE } = CONNECTIVITY_CONSTANTS
    const nelx = 6
    const nely = 6
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const rho = new Float64Array(mesh.nelem).fill(1)
    const pinned = new Uint8Array(mesh.ndof)
    pinned[0] = 1
    pinned[1] = 1
    const conn = createConnectivity(mesh)
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))
    expect(conn.inSolid[10]!).toBe(1)

    // Inside the band: must KEEP its previous state rather than flip.
    rho[10] = 0.5 * (SOLID_ENTER + SOLID_LEAVE)
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))
    expect(conn.inSolid[10]!).toBe(1)

    // Below the lower edge: now it leaves.
    rho[10] = SOLID_LEAVE - 0.01
    updateConnectivity(conn, mesh, rho, pinned, new Uint32Array(0))
    expect(conn.inSolid[10]!).toBe(0)
  })
})

describe('sensitivity filter', () => {
  it('is symmetric and its rows sum to one after normalization', () => {
    const mesh = buildMesh(12, 10, rectangularState(12, 10))
    const f = buildFilter(mesh, 2.2)
    const get = (a: number, b: number): number => {
      for (let k = f.rowPtr[a]!; k < f.rowPtr[a + 1]!; k++) {
        if (f.colIdx[k]! === b) return f.val[k]!
      }
      return 0
    }
    for (let a = 0; a < mesh.designList.length; a += 7) {
      for (let k = f.rowPtr[a]!; k < f.rowPtr[a + 1]!; k++) {
        const b = f.colIdx[k]!
        expect(f.val[k]!, `H(${a},${b})`).toBeCloseTo(get(b, a), 12)
      }
      let s = 0
      for (let k = f.rowPtr[a]!; k < f.rowPtr[a + 1]!; k++) s += f.val[k]!
      expect(s / f.rowSum[a]!).toBeCloseTo(1, 14)
    }
  })

  it('includes only in-radius neighbours', () => {
    const mesh = buildMesh(12, 12, rectangularState(12, 12))
    const f = buildFilter(mesh, 2.2)
    for (let k = 0; k < f.val.length; k++) {
      expect(f.val[k]!).toBeGreaterThan(0)
      expect(f.val[k]!).toBeLessThanOrEqual(2.2)
    }
  })

  it('never crosses into voided elements', () => {
    const nelx = 12
    const nely = 12
    const state = rectangularState(nelx, nely)
    for (let ey = 0; ey < nely; ey++) state[ey * nelx + 6] = VOID_PASSIVE
    const mesh = buildMesh(nelx, nely, state)
    const f = buildFilter(mesh, 2.2)
    for (let k = 0; k < f.colIdx.length; k++) {
      const e = mesh.designList[f.colIdx[k]!]!
      expect(mesh.state[e]).not.toBe(VOID_PASSIVE)
    }
  })
})

describe('OC update', () => {
  it('meets the volume target and respects the move limit', () => {
    const nelx = 20
    const nely = 12
    const mesh = buildMesh(nelx, nely, rectangularState(nelx, nely))
    const rho = new Float64Array(mesh.nelem).fill(0.5)
    const prev = rho.slice()
    const rhoNew = new Float64Array(mesh.nelem)
    const dcF = new Float64Array(mesh.nelem)
    for (let e = 0; e < mesh.nelem; e++) dcF[e] = -(1 + ((e * 7) % 13))
    const st = createOcState()
    ocUpdate(st, mesh, rho, rhoNew, dcF, 0.4, 0.2)

    expect(currentVolume(mesh, rho)).toBeCloseTo(0.4, 3)
    for (const e of mesh.freeList) {
      expect(Math.abs(rho[e]! - prev[e]!), `elem ${e}`).toBeLessThanOrEqual(0.2 + 1e-12)
      expect(rho[e]!).toBeGreaterThanOrEqual(RHO_MIN)
      expect(rho[e]!).toBeLessThanOrEqual(1)
    }
  })

  /**
   * A positive filtered sensitivity genuinely occurs, because the sensitivity filter is
   * a heuristic and not a consistent gradient. Math.pow of a negative base with a
   * fractional exponent is NaN, which would propagate through the entire density field.
   */
  it('survives a positive filtered sensitivity without producing NaN', () => {
    const mesh = buildMesh(10, 8, rectangularState(10, 8))
    const rho = new Float64Array(mesh.nelem).fill(0.5)
    const rhoNew = new Float64Array(mesh.nelem)
    const dcF = new Float64Array(mesh.nelem)
    for (let e = 0; e < mesh.nelem; e++) dcF[e] = e % 3 === 0 ? +2 : -1
    const st = createOcState()
    ocUpdate(st, mesh, rho, rhoNew, dcF, 0.4, 0.2)
    for (const e of mesh.designList) expect(Number.isFinite(rho[e]!), `elem ${e}`).toBe(true)
  })

  it('exercises the bracket expansion from a badly wrong warm start', () => {
    const mesh = buildMesh(12, 10, rectangularState(12, 10))
    const rho = new Float64Array(mesh.nelem).fill(0.5)
    const rhoNew = new Float64Array(mesh.nelem)
    const dcF = new Float64Array(mesh.nelem).fill(-1)
    const st = createOcState()
    st.lambda = 1e6 // off by six orders of magnitude
    ocUpdate(st, mesh, rho, rhoNew, dcF, 0.4, 0.2)
    expect(currentVolume(mesh, rho)).toBeCloseTo(0.4, 3)
  })

  it('leaves passive solids untouched', () => {
    const nelx = 12
    const nely = 10
    const state = rectangularState(nelx, nely)
    state[5] = SOLID_PASSIVE
    state[6] = SOLID_PASSIVE
    const mesh = buildMesh(nelx, nely, state)
    const rho = new Float64Array(mesh.nelem).fill(0.5)
    rho[5] = 1
    rho[6] = 1
    const rhoNew = new Float64Array(mesh.nelem)
    const dcF = new Float64Array(mesh.nelem).fill(-1)
    ocUpdate(createOcState(), mesh, rho, rhoNew, dcF, 0.4, 0.2)
    expect(rho[5]!).toBe(1)
    expect(rho[6]!).toBe(1)
  })

  it('uses the documented damping exponent and move limit defaults', () => {
    expect(OC_CONSTANTS.ETA).toBe(0.5)
  })
})

describe('BESO mode', () => {
  it('reaches the target volume and produces a discrete field', () => {
    const opt = new Optimizer(mbb(40, 14, { mode: 'beso', volumeFraction: 0.4 }))
    let last = opt.step()
    for (let k = 0; k < 200 && !last.converged; k++) last = opt.step()

    expect(last.volume).toBeCloseTo(0.4, 1)
    // Every free element must be exactly solid or exactly void.
    for (const e of opt.mesh.freeList) {
      const r = opt.density[e]!
      expect(r === 1 || r === RHO_MIN, `elem ${e} = ${r}`).toBe(true)
    }
  }, 180_000)

  it('starts from the seed mass rather than wiping the structure to void', () => {
    // A fixed 0.5 threshold would empty a uniform-0.5 seed entirely, and BESO cannot
    // recover from that: with no solid anywhere nothing is anchored, u is zero, and the
    // sensitivity numbers carry no signal to grow material back from.
    const opt = new Optimizer(mbb(30, 12, { mode: 'beso', volumeFraction: 0.35 }))
    expect(currentVolume(opt.mesh, opt.density)).toBeGreaterThan(0.3)
  })

  it('follows the evolutionary volume schedule without overshooting', () => {
    const opt = new Optimizer(mbb(30, 12, { mode: 'beso', volumeFraction: 0.35 }))
    let prev = opt.step().volume
    for (let k = 0; k < 60; k++) {
      const v = opt.step().volume
      // Each step moves by at most the evolutionary ratio plus the addition cap.
      expect(Math.abs(v - prev)).toBeLessThan(BESO_CONSTANTS.ER + BESO_CONSTANTS.AR_MAX + 0.02)
      prev = v
    }
    expect(prev).toBeGreaterThan(0.3)
    expect(prev).toBeLessThan(0.45)
  }, 180_000)

  it('shares the FEA core, so the compliance identity still holds', () => {
    const opt = new Optimizer(mbb(30, 12, { mode: 'beso', volumeFraction: 0.4 }))
    for (let k = 0; k < 10; k++) opt.step()
    expect(opt.complianceIdentityError()).toBeLessThan(1e-6)
  }, 120_000)
})

describe('degenerate inputs', () => {
  it('does not hang or NaN when every element starts at the density floor', () => {
    const nelx = 20
    const nely = 12
    const opt = new Optimizer(
      mbb(nelx, nely, { rho0: new Float32Array(nelx * nely).fill(RHO_MIN) }),
    )
    for (let k = 0; k < 10; k++) {
      const m = opt.step()
      expect(Number.isFinite(m.compliance)).toBe(true)
    }
  }, 120_000)

  it('handles a zero load without dividing by zero', () => {
    const nelx = 16
    const nely = 10
    const opt = new Optimizer(
      mbb(nelx, nely, { loadValues: Float32Array.from([0]) }),
    )
    const m = opt.step()
    expect(m.compliance).toBe(0)
    expect(Number.isFinite(m.volume)).toBe(true)
  })

  it('tolerates a spatially varying concordance multiplier', () => {
    const nelx = 24
    const nely = 12
    const w = new Float32Array(nelx * nely)
    for (let e = 0; e < w.length; e++) w[e] = 0.15 + 0.85 * ((e * 11) % 7) / 7
    const opt = new Optimizer(mbb(nelx, nely, { w }))
    for (let k = 0; k < 20; k++) {
      const m = opt.step()
      expect(Number.isFinite(m.compliance)).toBe(true)
      expect(m.compliance).toBeGreaterThan(0)
    }
    // Tighten the final solve: the identity holds to solver precision, and an
    // animation-tolerance solve (1e-4 residual) only pins it to about 1e-6.
    opt.step(true)
    expect(opt.complianceIdentityError()).toBeLessThan(1e-8)
  }, 120_000)

  it('keeps every element in an all-FREE mesh a design variable', () => {
    const mesh = buildMesh(8, 6, rectangularState(8, 6))
    expect(mesh.freeList.length).toBe(48)
    expect(mesh.nSolid).toBe(0)
    for (const e of mesh.designList) expect(mesh.state[e]).toBe(FREE)
  })
})
