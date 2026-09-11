import { assemble, dYoungs, youngs, E0, EMIN, RHO_MIN } from './assembly'
import { buildPattern } from './assembly'
import type { Pattern } from './assembly'
import {
  MAXITER_ANIMATION,
  MAXITER_EXPORT,
  TOL_ANIMATION,
  TOL_EXPORT,
  adaptiveTolerance,
  createCgWorkspace,
  pcg,
} from './cg'
import type { CgWorkspace } from './cg'
import { createConnectivity, updateConnectivity } from './connectivity'
import type { Connectivity } from './connectivity'
import { elementEnergy } from './elementStiffness'
import { applySensitivityFilter, buildFilter } from './filter'
import type { Filter } from './filter'
import { buildMesh, SOLID_PASSIVE } from './mesh'
import type { Mesh } from './mesh'
import { createOcState, currentVolume, ocUpdate } from './ocUpdate'
import type { OcState } from './ocUpdate'
import { besoStep, createBesoState, discretize } from './beso'
import type { BesoState } from './beso'

/**
 * The iteration driver: assemble -> solve -> sensitivity -> filter -> update -> metrics.
 *
 * No continuation on the penalization exponent. Continuation (p from 1 to 3) exists to
 * steer a uniform grey start into a good basin, but here the seed field IS a
 * purpose-built non-uniform initial guess that already breaks symmetry along culturally
 * meaningful directions. Continuation would fight it, and it roughly doubles the
 * iteration count -- which the interactive animation cannot afford.
 *
 * The one exception is the export hardening pass: 20 extra iterations ramping p from 3
 * to 4.5 and the move limit from 0.2 down to 0.05, which drives the remaining grey to
 * black and white for a crisp print without changing the topology.
 */

export interface OptimizerInput {
  readonly nelx: number
  readonly nely: number
  /** nelem element states, from the disc mask plus the load/pin patches. */
  readonly state: Uint8Array
  /** nelem initial densities. */
  readonly rho0: Float32Array
  /** nelem concordance stiffness multipliers. Held FIXED for the whole run. */
  readonly w: Float32Array
  readonly fixedDofs: Uint32Array
  readonly loadDofs: Uint32Array
  readonly loadValues: Float32Array
  readonly volumeFraction: number
  readonly penalty: number
  readonly filterRadius: number
  readonly moveLimit: number
  readonly mode: 'simp' | 'beso'
  /** SIMP's lower volume bound. See SolverConfig.volumeFloor for the measurement. */
  readonly volumeFloor?: number
}

export interface IterationMetrics {
  iteration: number
  compliance: number
  complianceRel: number
  volume: number
  changeLinf: number
  cgIters: number
  cgResidual: number
  cgConverged: boolean
  islands: number
  unsupportedLoads: number
  /** Every load was stranded, so the design was held rather than updated. */
  noSignal: boolean
  converged: boolean
}

/**
 * Iterations over which the volume constraint eases from the seed's own volume down to
 * the requested target. See Optimizer.volumeTarget().
 *
 * 30 is about a quarter of the default 120-iteration budget: long enough that the load
 * paths are organized before material gets scarce, short enough that the run still has
 * ninety iterations at the real target to converge in.
 */
const VOLUME_RAMP = 30

export class Optimizer {
  readonly mesh: Mesh
  readonly pattern: Pattern
  readonly filter: Filter
  private conn: Connectivity
  private ws: CgWorkspace
  private oc: OcState
  private beso: BesoState | null = null

  private values: Float64Array
  private diag: Float64Array
  private rho: Float64Array
  private rhoNew: Float64Array
  private w: Float64Array
  private f: Float64Array
  private u: Float64Array
  private ce: Float64Array
  private dc: Float64Array
  private dcF: Float64Array
  private alphaRaw: Float64Array
  private alphaF: Float64Array
  private pinnedMask: Uint8Array

  private penalty: number
  private moveLimit: number
  private volumeFraction: number
  private mode: 'simp' | 'beso'
  private loadDofs: Uint32Array

  private firstCompliance = 0
  /**
   * Volume constraint for THIS iteration: the seed's own volume at the start, easing
   * down to the requested target over VOLUME_RAMP iterations.
   *
   * Volume continuation, and here it is load-bearing rather than a refinement. The tile
   * seed deposits more material than the target allows, so material must be given up --
   * and the cheapest material to give up, by sensitivity, is the thin connectivity floor
   * in the gutters BETWEEN tiles. Enforcing the final target immediately therefore
   * removes every inter-tile bridge in the first few iterations, which disconnects the
   * domain; and a load with no path to an anchor has exactly zero sensitivity, so the
   * optimizer has no gradient telling it to rebuild the bridge it just ate. It settles
   * into isolated rounded blobs -- observed as "10 identities have no path to the rim"
   * with the target 20% below tile coverage.
   *
   * Easing the constraint down instead means the load paths are established, and
   * carrying real signal, before material gets scarce. At that point the bridges are
   * among the most valuable elements in the domain rather than the least, so what gets
   * eaten is the interior of tiles that are not carrying anything -- which is the
   * behaviour wanted: tiles chipped into smaller tiles and drawn out toward the anchors
   * that hold them.
   *
   * Returns the target unchanged when the seed already sits below it, so a sparse profile
   * is never asked to shed material it does not have.
   */
  private volumeTarget(): number {
    // SIMP cannot rebuild a bridge it has eaten; see SolverConfig.volumeFloor. BESO can,
    // so it is allowed the full requested target.
    const end =
      this.mode === 'simp' ? Math.max(this.volumeFraction, this.volumeFloor) : this.volumeFraction
    if (this.vfStart <= end) return end
    const t = Math.min(1, this.iteration / VOLUME_RAMP)
    // Smoothstep rather than linear: the first iterations are where disconnection
    // happens, so the constraint should barely move until the structure has organized.
    const ease = t * t * (3 - 2 * t)
    return this.vfStart + (end - this.vfStart) * ease
  }

  private stableCount = 0
  private identityError = 1
  /** Volume of the seed, measured once. The start of the continuation ramp. */
  private vfStart = 0
  /** SIMP's lower bound; see SolverConfig.volumeFloor. */
  private volumeFloor = 0
  iteration = 0

  constructor(input: OptimizerInput) {
    this.mesh = buildMesh(input.nelx, input.nely, input.state)
    this.pattern = buildPattern(this.mesh)
    this.filter = buildFilter(this.mesh, input.filterRadius)
    this.conn = createConnectivity(this.mesh)
    this.ws = createCgWorkspace(this.mesh.ndof)
    this.oc = createOcState()

    const { nelem, ndof } = this.mesh
    this.values = new Float64Array(this.pattern.nnz)
    this.diag = new Float64Array(ndof)
    this.rho = new Float64Array(nelem)
    this.rhoNew = new Float64Array(nelem)
    this.w = new Float64Array(nelem)
    this.f = new Float64Array(ndof)
    this.u = new Float64Array(ndof)
    this.ce = new Float64Array(nelem)
    this.dc = new Float64Array(nelem)
    this.dcF = new Float64Array(nelem)
    this.alphaRaw = new Float64Array(nelem)
    this.alphaF = new Float64Array(nelem)
    this.pinnedMask = new Uint8Array(ndof)

    for (let e = 0; e < nelem; e++) {
      this.rho[e] = input.rho0[e]!
      this.w[e] = input.w[e]!
    }
    this.vfStart = currentVolume(this.mesh, this.rho)
    // Passive solids are held at 1.0 regardless of what the seed said.
    for (let a = 0; a < this.mesh.designList.length; a++) {
      const e = this.mesh.designList[a]!
      if (this.mesh.state[e] === SOLID_PASSIVE) this.rho[e] = 1
    }

    for (const d of input.fixedDofs) this.pinnedMask[d] = 1
    // Every DOF no assembled element touches is permanently constrained, or K is
    // singular. Folded in once, here.
    for (let i = 0; i < ndof; i++) if (this.diagUntouched(i)) this.pinnedMask[i] = 1

    for (let k = 0; k < input.loadDofs.length; k++) {
      this.f[input.loadDofs[k]!] = input.loadValues[k]!
    }
    this.loadDofs = input.loadDofs

    this.penalty = input.penalty
    this.moveLimit = input.moveLimit
    this.volumeFraction = input.volumeFraction
    this.volumeFloor = input.volumeFloor ?? 0
    this.mode = input.mode

    if (this.mode === 'beso') {
      const v0 = discretize(this.mesh, this.rho)
      this.beso = createBesoState(this.mesh, v0)
    }
  }

  private diagUntouched(dof: number): boolean {
    return this.pattern.diagPos[dof]! < 0
  }

  /** Densities, for the caller to copy out and transfer. */
  get density(): Float64Array {
    return this.rho
  }

  /**
   * One optimization iteration.
   *
   * `tighten` requests the export-grade tolerance for a trustworthy final compliance.
   */
  step(tighten = false): IterationMetrics {
    // The connectivity pass runs EVERY iteration. Its cost is a union-find over the
    // element grid (well under a millisecond) and it is what keeps CG at tens of
    // iterations rather than thousands.
    updateConnectivity(this.conn, this.mesh, this.rho, this.pinnedMask, this.loadDofs)

    // When the supported set changes, u0 must be zeroed at the newly constrained DOFs
    // before entering CG. Otherwise r[c] = 0 silently discards a nonzero component of u
    // and the initial residual is inconsistent with the system being solved.
    for (const d of this.conn.newlyConstrained) this.u[d] = 0

    assemble(
      this.values,
      this.diag,
      this.mesh,
      this.pattern,
      this.rho,
      this.w,
      this.penalty,
      this.conn.fixedMask,
    )

    const tol = tighten ? TOL_EXPORT : Math.min(TOL_ANIMATION, adaptiveTolerance(this.oc.changeLinf))
    const maxIter = tighten ? MAXITER_EXPORT : MAXITER_ANIMATION
    // Warm start from the previous displacement: about 1.5-2.0x, not 10x. On
    // non-convergence we PROCEED and surface the residual rather than hang.
    const cg = pcg(
      this.values,
      this.pattern,
      this.diag,
      this.f,
      this.u,
      this.conn.fixedList,
      tol,
      maxIter,
      this.ws,
    )

    // Compliance and its derivative.
    //   ce_e      = u_e^T KE u_e                       >= 0
    //   c         = sum(E(e) * ce_e)   ( == f^T u )
    //   dc/drho_e = -dE/drho(e) * ce_e                 <= 0
    let compliance = 0
    const list = this.mesh.designList
    for (let a = 0; a < list.length; a++) {
      const e = list[a]!
      const energy = elementEnergy(this.u, this.mesh.edof, e * 8)
      this.ce[e] = energy
      compliance += youngs(this.rho[e]!, this.w[e]!, this.penalty) * energy
      this.dc[e] = -dYoungs(this.rho[e]!, this.w[e]!, this.penalty) * energy
    }

    if (this.iteration === 0) this.firstCompliance = compliance || 1

    // The compliance identity, measured HERE -- before the density update, while `rho`
    // still matches the `u` that was solved for. Measuring it after the update compares
    // new densities against an old displacement and reports a large error for a
    // perfectly correct solve, which is exactly the false alarm this comment exists to
    // prevent.
    let fu = 0
    for (let i = 0; i < this.mesh.ndof; i++) fu += this.f[i]! * this.u[i]!
    this.identityError = Math.abs(compliance - fu) / Math.max(Math.abs(fu), 1e-30)

    /**
     * NO-SIGNAL GUARD. If every load ended up stranded -- on a floating island, or in a
     * region the connectivity pass constrained -- then u is zero, every element energy
     * is zero, and every sensitivity is zero.
     *
     * Running the update anyway is destructive rather than merely useless: with all
     * sensitivities at zero, Be is zero for every element, so every candidate density is
     * zero, the volume bisection has no root to find, and the entire design drops by the
     * move limit each iteration. Observed: a structure fell from a volume fraction of
     * 0.25 to the density floor in four iterations while reporting compliance exactly
     * zero -- which reads from the outside like a converged run.
     *
     * Holding the design instead keeps the state recoverable, and the metrics tell the
     * UI exactly what happened.
     */
    const noSignal = !(compliance > 0)

    const target = this.volumeTarget()

    let converged = false
    if (noSignal) {
      this.oc.changeLinf = 0
    } else if (this.mode === 'beso' && this.beso) {
      const r = besoStep(
        this.beso,
        this.mesh,
        this.filter,
        this.rho,
        this.w,
        this.ce,
        this.alphaRaw,
        this.alphaF,
        this.penalty,
        target,
        compliance,
      )
      converged = r.converged
      this.oc.changeLinf = (r.nAdded + r.nRemoved) / Math.max(1, list.length)
    } else {
      applySensitivityFilter(this.filter, this.mesh, this.rho, this.dc, this.dcF)
      ocUpdate(
        this.oc,
        this.mesh,
        this.rho,
        this.rhoNew,
        this.dcF,
        target,
        this.moveLimit,
      )
      /**
       * Stop when the design has stopped moving for three consecutive iterations, not on
       * a single quiet step -- the sensitivity filter makes the history mildly
       * non-monotonic, so one small step is not evidence of convergence.
       *
       * A design with loads stranded off the load path does not count as quiet, however
       * many quiet steps it strings together. This is the PARTIAL case of the no-signal
       * guard above and it is much easier to hit: with most loads stranded, the
       * sensitivities over most of the domain are exactly zero, so the design genuinely
       * stops moving and changeLinf goes quiet for several iterations running. It is not
       * converged, it is mid-repair, and the difference is not visible in changeLinf.
       *
       * Observed on the sample profile at the 96 grid: iterations 6 through 9 sat at
       * volume 0.321 and compliance 0.180 with 10 of 16 loads stranded, which tripped the
       * three-quiet-steps test and ended the run on a half-formed structure. Two
       * iterations later connectivity was restored on its own, compliance rose to 2.27,
       * and the design kept moving for another twenty iterations before settling at
       * 1.014 -- a third of the compliance the premature stop reported.
       *
       * Deliberately gated on stranded loads rather than on islands: a floating fragment
       * that carries no load does not zero anyone's sensitivity, so it cannot manufacture
       * a false quiet, and blocking on it would mean a profile that always keeps one
       * chip loose could never converge at all.
       */
      const strandedLoads = this.conn.unsupportedLoads > 0
      if (this.oc.changeLinf < 0.01 && !strandedLoads) this.stableCount++
      else this.stableCount = 0
      converged = this.stableCount >= 3
    }

    this.iteration++
    return {
      iteration: this.iteration,
      compliance,
      complianceRel: compliance / this.firstCompliance,
      volume: currentVolume(this.mesh, this.rho),
      changeLinf: this.oc.changeLinf,
      cgIters: cg.iters,
      cgResidual: cg.residual,
      cgConverged: cg.converged,
      islands: this.conn.islands,
      unsupportedLoads: this.conn.unsupportedLoads,
      noSignal,
      converged,
    }
  }

  /**
   * Export hardening: ramp p from 3 to 4.5 and the move limit from 0.2 to 0.05 over
   * `n` iterations. Drives the remaining intermediate density to solid or void for a
   * crisp print, without changing the topology.
   */
  harden(n = 20): IterationMetrics {
    const p0 = this.penalty
    const m0 = this.moveLimit
    let last = this.step(false)
    for (let k = 0; k < n; k++) {
      const t = (k + 1) / n
      this.penalty = p0 + (4.5 - p0) * t
      this.moveLimit = m0 + (0.05 - m0) * t
      last = this.step(k === n - 1)
    }
    this.penalty = p0
    this.moveLimit = m0
    return last
  }

  setPenalty(p: number): void {
    this.penalty = p
  }

  /**
   * Relative error in the identity  f^T u == sum(E(e) * u_e^T KE u_e)  for the most
   * recent step. Catches DOF-ordering and assembly bugs immediately, and is cheap
   * enough to assert once per run in a development build.
   */
  complianceIdentityError(): number {
    return this.identityError
  }
}

export const MATERIAL_CONSTANTS = Object.freeze({ E0, EMIN, RHO_MIN })
