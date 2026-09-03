/**
 * The worker boundary. Pure types -- no DOM, no WebWorker globals, no imports.
 * Compiled under tsconfig.worker.json so it is usable from both sides.
 */

export type SolverMode = 'simp' | 'beso'

/**
 * Element states. Part of the worker CONTRACT rather than a kernel internal: the
 * renderer builds this array from the disc mask and the load/pin patches, so both sides
 * must agree on the encoding.
 */
/** Outside the design domain. Never assembled, so K's support is exactly the domain. */
export const VOID_PASSIVE = 0
/** A design variable. */
export const FREE = 1
/** Held at rho = 1 and excluded from the design variables. Load and pin patches. */
export const SOLID_PASSIVE = 2

/**
 * Everything the kernel needs to set up a run. Deliberately flat typed arrays: this
 * whole object crosses the worker boundary, and a structure of objects would be far
 * more expensive to clone.
 */
export interface SolverProblem {
  readonly nelx: number
  readonly nely: number
  /** nelem element states: 0 void-passive, 1 free, 2 solid-passive. */
  readonly state: Uint8Array
  /** nelem initial densities, already floored and volume-feasible. */
  readonly rho0: Float32Array
  /**
   * nelem concordance stiffness multipliers. Computed once from the colour field and
   * held FIXED for the whole run -- see layout/fields.ts for why that matters.
   */
  readonly w: Float32Array
  readonly fixedDofs: Uint32Array
  readonly loadDofs: Uint32Array
  readonly loadValues: Float32Array
}

/** Tuning that the kernel reads. Everything here is stable for the life of a run. */
export interface SolverConfig {
  readonly mode: SolverMode
  /** 0.20-0.55; derived from total identity strength unless overridden. */
  readonly volumeFraction: number
  /** SIMP penalization exponent. */
  readonly penalty: number
  /**
   * Sensitivity filter radius in ELEMENTS. Must stay at or below the minimum deposit
   * sigma, or the filter erases the seed structure before the optimizer can act on it
   * and every profile produces the same art.
   */
  readonly filterRadius: number
  readonly moveLimit: number
}

export type SolverRequest =
  | { type: 'init'; problem: SolverProblem; config: SolverConfig }
  | { type: 'step'; n: number }
  | { type: 'harden' }
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
  /** Every load was stranded, so the design was held rather than updated. */
  readonly noSignal: boolean
  readonly converged: boolean
}

export type SolverResponse =
  | { type: 'ready'; dofCount: number; nDesign: number; nFree: number }
  | { type: 'paused'; iteration: number }
  | ({ type: 'frame'; density: Float32Array } & FrameMetrics)
  | { type: 'done'; iteration: number; reason: 'converged' | 'iterations' | 'aborted' }
  | { type: 'error'; where: string; message: string }
  | { type: 'smokeResult'; sum: number; length: number }
