/**
 * The worker boundary. Pure types -- no DOM, no WebWorker globals, no imports.
 * Compiled under tsconfig.worker.json so it is usable from both sides.
 */

export type SolverMode = 'simp' | 'beso'

export interface MeshSpec {
  readonly nx: number
  readonly ny: number
  /** nx*ny; 0 outside the circular design domain. */
  readonly domainMask: Uint8Array
}

/**
 * Everything derived from the user's answers, computed on the renderer side by
 * `layout/fields.ts` and `layout/boundary.ts`. The worker treats this as given.
 */
export interface SeedField {
  readonly nx: number
  readonly ny: number
  /** nx*ny -- initial rho, already floored at 0.25 inside the disc and volume-feasible. */
  density: Float32Array
  /** nx*ny*3 -- normalized hue (the record of which identity deposited where). */
  color: Float32Array
  /** nx*ny -- the concordance stiffness multiplier w_e. Computed ONCE, never updated with rho. */
  stiffness: Float32Array
  /** nx*ny -- index of the dominant contributing answer, or -1. For hover provenance. */
  provenance: Int16Array
}

export interface BoundaryConditions {
  /** DOF indices with fixed (zero) displacement -- the pinned rim anchors. */
  readonly fixedDofs: Uint32Array
  readonly loadDofs: Uint32Array
  readonly loadValues: Float32Array
  /** Element indices forced to rho = 1 and excluded from the design variables. */
  readonly solidPassive: Uint32Array
}

export interface SolverConfig {
  readonly mode: SolverMode
  /** 0.20-0.55; derived from total identity strength, overridable. */
  readonly volumeFraction: number
  /** SIMP penalization exponent. */
  readonly penalty: number
  /** Sensitivity filter radius in elements. Must be <= sigma_min or the filter erases the seed. */
  readonly filterRadius: number
  readonly iterations: number
  readonly moveLimit: number
  /** BESO evolutionary volume ratio. */
  readonly erosionRate: number
  /** All stochasticity derives from this. No bare Math.random anywhere in the kernel. */
  readonly seed: number
}

export type SolverRequest =
  | { type: 'init'; mesh: MeshSpec; seed: SeedField; bc: BoundaryConditions; config: SolverConfig }
  | { type: 'step'; n: number }
  | { type: 'abort' }
  /** Buffer pool return -- the ping-pong that makes steady-state allocation zero. */
  | { type: 'recycle'; density: Float32Array }
  /**
   * Permanent diagnostic, not a throwaway. Round-trips a typed array so the app can
   * assert zero-copy transfer actually happened under the packaged file:// origin.
   */
  | { type: 'smokeTest'; probe: Float32Array }

export interface FrameMetrics {
  readonly iteration: number
  readonly compliance: number
  readonly complianceRel: number
  readonly volume: number
  readonly changeLinf: number
  readonly cgIters: number
  readonly cgResidual: number
  readonly cgConverged: boolean
  /** Non-anchored connected components larger than 8 elements. */
  readonly islands: number
  readonly unsupportedLoads: number
}

export type SolverResponse =
  | { type: 'ready'; dofCount: number; nDesign: number; nFree: number }
  | ({ type: 'frame'; density: Float32Array } & FrameMetrics)
  | { type: 'done'; iteration: number; reason: 'converged' | 'iterations' | 'aborted' }
  | { type: 'error'; where: string; message: string }
  | { type: 'smokeResult'; sum: number; length: number }
