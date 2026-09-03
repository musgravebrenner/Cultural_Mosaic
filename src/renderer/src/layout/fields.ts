import type { PlacedTile } from '../domain/types'

/**
 * PlacedTile[] -> grid fields. The bridge between meaning and physics.
 *
 * Everything here is a pure function of the placed tiles, computed once per profile
 * edit and then held FIXED for the whole optimization. Buffers are allocated once and
 * mutated in place: a rebuild costs ~40 stamps over ~225 cells each, which is tens of
 * microseconds and zero allocation, so a slider can be dragged at any rate.
 */

/** Normalized element grid over [-1,1]^2, masked to a disc. */
export interface Grid {
  readonly n: number
  /** Element count, n*n. */
  readonly count: number
  /** Element width in normalized units, 2/n. */
  readonly h: number
  readonly rimRadius: number
  /** Element centroid coordinates, y-up. Flip only at render time. */
  readonly cx: Float32Array
  readonly cy: Float32Array
  /** 1 inside the disc, 0 outside. Outside elements are never assembled. */
  readonly mask: Uint8Array
  /** Indices of the in-disc elements. */
  readonly designList: Int32Array
}

export function createGrid(n: number, rimRadius: number): Grid {
  const count = n * n
  const h = 2 / n
  const cx = new Float32Array(count)
  const cy = new Float32Array(count)
  const mask = new Uint8Array(count)
  const design: number[] = []
  for (let ey = 0; ey < n; ey++) {
    for (let ex = 0; ex < n; ex++) {
      const i = ey * n + ex
      const x = -1 + (ex + 0.5) * h
      const y = -1 + (ey + 0.5) * h
      cx[i] = x
      cy[i] = y
      if (Math.hypot(x, y) <= rimRadius) {
        mask[i] = 1
        design.push(i)
      }
    }
  }
  return { n, count, h, rimRadius, cx, cy, mask, designList: Int32Array.from(design) }
}

export interface MosaicFields {
  readonly grid: Grid
  /** 3*count -- accumulated category vector field. */
  readonly V: Float32Array
  /** count -- conviction, ||V||_1. How much identity is present here. */
  readonly kappa: Float32Array
  /** 3*count -- hue on the simplex, V / max(kappa, eps). */
  readonly hue: Float32Array
  /** count -- saturating-union presence, before the connectivity floor and volume remap. */
  readonly rhoRaw: Float32Array
  /** count -- the optimizer's initial density. Floored and volume-feasible. */
  readonly rho0: Float32Array
  /** count -- gated spherical coherence in [0,1]. */
  readonly coherence: Float32Array
  /** count -- the concordance stiffness multiplier w_e in [wMin, 1]. NEVER updated with rho. */
  readonly w: Float32Array
  /** count -- index into the tile array of the dominant contributor, or -1. */
  readonly provenance: Int16Array
  /** Derived volume fraction actually used. */
  volumeFraction: number
  /** Fraction of the disc with any material at all. */
  supportFraction: number
  /** True when the profile was too sparse to reach the volume target. */
  sparse: boolean
}

export function createFields(grid: Grid): MosaicFields {
  const c = grid.count
  return {
    grid,
    V: new Float32Array(3 * c),
    kappa: new Float32Array(c),
    hue: new Float32Array(3 * c),
    rhoRaw: new Float32Array(c),
    rho0: new Float32Array(c),
    coherence: new Float32Array(c),
    w: new Float32Array(c),
    provenance: new Int16Array(c),
    volumeFraction: 0.35,
    supportFraction: 0,
    sparse: false,
  }
}

// --- Constants ------------------------------------------------------------

/** Kernel cutoff in sigmas. Offset so the kernel is exactly 0 at the edge. */
const CUTOFF_SIGMAS = 3
const CUTOFF_OFFSET = Math.exp(-4.5)
const CUTOFF_SCALE = 1 / (1 - CUTOFF_OFFSET)

/**
 * Connectivity floor. At iteration 1 the entire disc is one connected component
 * containing every pin and every load, so the user's answers CANNOT create a
 * disconnected starting point -- disconnection can then only arise from the
 * optimizer's own choices, and compliance minimization will not sever a path it needs.
 * This is defence layer 4 of 4 against the floating-material failure mode.
 */
const RHO_FLOOR = 0.25
const RHO_MIN = 1e-3
/**
 * Saturation rate for the density union. -ln(0.4) puts a single full-strength deposit
 * at 0.6 of full density, so overlap has room to read as genuinely denser.
 */
const LAMBDA = -Math.log(0.4)

/** Conviction half-saturation for the concordance gate. */
const KAPPA_HALF = 0.35
/** Where an unlinked neighbourhood sits: neutral, neither concordant nor hostile. */
const S_NEUTRAL = 0.6
const W_MIN = 0.15
const W_EXPONENT = 2

// --- Deposit --------------------------------------------------------------

/**
 * Truncated, offset Gaussian: smooth like a Gaussian, compact like an RBF, and exactly
 * zero at the cutoff so there is no discontinuity artifact along a visible circle.
 * Peak-normalized, so k(0) = 1 exactly.
 */
function kernel(d2: number, sigma: number): number {
  const s2 = sigma * sigma
  if (d2 > CUTOFF_SIGMAS * CUTOFF_SIGMAS * s2) return 0
  return (Math.exp(-d2 / (2 * s2)) - CUTOFF_OFFSET) * CUTOFF_SCALE
}

export interface FieldOptions {
  /** Sensitivity filter radius in ELEMENTS. Also the coherence neighbourhood radius. */
  readonly filterRadius: number
  /** Explicit volume fraction, or 'derived' to compute it from total strength. */
  readonly volumeFraction: number | 'derived'
}

/**
 * Accumulate deposits, then derive everything else. Mutates `f` in place.
 *
 * Colour and density combine by DIFFERENT rules, deliberately:
 *
 *   colour  -- weighted average of hue (accumulate V, then divide by kappa)
 *   density -- saturating union,  1 - exp(-LAMBDA * sum(A*k))
 *
 * Colour must average because summing-and-clamping would let three overlapping pure-blue
 * deposits tone-map toward whitish, and the app would then report "Concordant Core"
 * (all three dimensions align) in a region that is in fact maximally PURE single
 * category. White has to be earned by the co-presence of all three, never manufactured
 * by stacking one. Intensity lives in kappa, where it belongs.
 *
 * Density must union because presence is a union: if ANY identity occupies a location,
 * there is material there, and averaging would let an isolated strong deposit be thinned
 * by its own emptiness. It is monotone and bounded in [0,1) with a non-vanishing
 * gradient everywhere -- summing-then-CLIPPING would instead produce flat rho = 1
 * plateaus, losing all ordering information in exactly the dense regions that matter
 * most.
 *
 * The union is realized as a saturating sum, `1 - exp(-LAMBDA * A)`, rather than as the
 * strict product form `1 - prod(1 - A_i k_i)`. Both are monotone and bounded, but the
 * product form saturates far too fast to be usable: a single full-strength deposit
 * already drives its own centre to 1.0, and a dozen overlapping ones underflow to
 * exactly 1.0 in float64, which is the very plateau the union was chosen to avoid.
 * LAMBDA = -ln(0.4) puts a single full-strength deposit at 0.6, leaving deliberate
 * headroom so that genuine overlap reads as denser, and needs A ~ 40 before it
 * saturates numerically.
 */
export function buildFields(
  f: MosaicFields,
  tiles: readonly PlacedTile[],
  opts: FieldOptions,
): void {
  const { grid, V, kappa, hue, rhoRaw, rho0, provenance } = f
  const { n, h, cx, cy, mask } = grid
  const count = grid.count

  V.fill(0)
  kappa.fill(0)
  hue.fill(0)
  rho0.fill(0)
  provenance.fill(-1)
  // Accumulate the plain amplitude sum A; the saturating union is applied afterward.
  const acc = rhoRaw
  acc.fill(0)
  // Track the largest single contribution per cell, for hover provenance.
  const best = new Float32Array(count)

  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t]!
    const { x, y, sigma, amplitude } = tile
    if (amplitude <= 0 || sigma <= 0) continue
    const reach = CUTOFF_SIGMAS * sigma
    const [hr, hg, hb] = tile.hue

    // Only visit the bounding box of this deposit -- cost is O(sum sigma^2/h^2), not
    // O(tiles * grid).
    const ex0 = Math.max(0, Math.floor((x - reach + 1) / h - 0.5))
    const ex1 = Math.min(n - 1, Math.ceil((x + reach + 1) / h - 0.5))
    const ey0 = Math.max(0, Math.floor((y - reach + 1) / h - 0.5))
    const ey1 = Math.min(n - 1, Math.ceil((y + reach + 1) / h - 0.5))

    for (let ey = ey0; ey <= ey1; ey++) {
      for (let ex = ex0; ex <= ex1; ex++) {
        const i = ey * n + ex
        if (!mask[i]) continue
        const dx = cx[i]! - x
        const dy = cy[i]! - y
        const k = kernel(dx * dx + dy * dy, sigma)
        if (k <= 0) continue

        const contrib = amplitude * k
        V[3 * i]! += contrib * hr
        V[3 * i + 1]! += contrib * hg
        V[3 * i + 2]! += contrib * hb
        acc[i]! += contrib
        if (contrib > best[i]!) {
          best[i] = contrib
          provenance[i] = t
        }
      }
    }
  }

  // Finish the soft-OR and the hue normalization.
  let supported = 0
  for (let d = 0; d < grid.designList.length; d++) {
    const i = grid.designList[d]!
    // -expm1(-x) is 1 - exp(-x) evaluated accurately for small x.
    const raw = -Math.expm1(-LAMBDA * acc[i]!)
    rhoRaw[i] = raw
    if (raw > 1e-6) supported++
    const kap = V[3 * i]! + V[3 * i + 1]! + V[3 * i + 2]!
    kappa[i] = kap
    if (kap > 1e-6) {
      hue[3 * i] = V[3 * i]! / kap
      hue[3 * i + 1] = V[3 * i + 1]! / kap
      hue[3 * i + 2] = V[3 * i + 2]! / kap
    }
  }
  f.supportFraction = supported / grid.designList.length

  computeConcordance(f, opts.filterRadius)

  const vf =
    opts.volumeFraction === 'derived' ? deriveVolumeFraction(tiles) : opts.volumeFraction
  f.volumeFraction = vf
  f.sparse = false
  remapToVolume(f, vf)
}

/**
 * Volume fraction from total identification strength.
 *
 * Volume fraction is the single most visually dominant parameter. Left as a free
 * slider it swamps every other signal and the artwork stops being a portrait. Bound to
 * total strength it reads as: strong decisive identities give a dense, load-bearing
 * mosaic; tentative answers give a thin, filigree one.
 *
 * The clamp is partly a feasibility requirement and partly an aesthetic one. Below
 * about 0.18 a disc carrying a dozen point loads cannot form a connected truss at the
 * default filter radius and the optimizer returns fragments. The UPPER bound was
 * lowered from 0.55 to 0.42 after looking at real output: a strongly-answered profile
 * derived 0.46, at which the optimum is a set of consolidated blobs rather than a
 * structure -- there is simply enough material that nothing has to be spanned. The same
 * profile at 0.24 produces clearly legible load paths and negative space. The range now
 * keeps the whole span in the regime where structure is visible, while preserving the
 * mapping that strong, decisive identities give a denser mosaic than tentative ones.
 *
 * Users who want the dense extreme can still set it manually; the Advanced panel shows
 * the derived value alongside the override.
 */
export function deriveVolumeFraction(tiles: readonly PlacedTile[]): number {
  if (tiles.length === 0) return 0.2
  let sum = 0
  for (const t of tiles) sum += t.salience
  const s = sum / tiles.length
  return Math.min(0.42, Math.max(0.2, 0.2 + 0.22 * s))
}

/**
 * Rescale rho0 so the volume constraint is satisfiable at iteration 1.
 *
 * A monotone gamma remap on the floored field, with the exponent found by bisection.
 * Gamma rather than multiplicative scaling (which crushes weak regions toward zero,
 * losing the faint structure that discordant-boundary erosion acts on) and rather than
 * an additive shift (which inflates genuinely empty regions into a uniform grey sea and
 * destroys the zero set). Gamma fixes 0 -> 0 and 1 -> 1, changing contrast rather than
 * support.
 */
function remapToVolume(f: MosaicFields, target: number): void {
  const { rhoRaw, rho0, grid } = f
  const list = grid.designList
  const nd = list.length
  if (nd === 0) return

  // The connectivity floor is applied first, so the field being remapped is already
  // strictly positive across the whole disc. That guarantees the bisection can reach
  // the target from both sides.
  const hat = (i: number): number => RHO_FLOOR + (1 - RHO_FLOOR) * rhoRaw[i]!

  const meanAt = (t: number): number => {
    let s = 0
    for (let d = 0; d < nd; d++) {
      s += Math.min(1, Math.max(RHO_MIN, Math.pow(hat(list[d]!), t)))
    }
    return s / nd
  }

  // mean(hat^t) decreases as t grows (hat <= 1), so bracket accordingly.
  let lo = 1e-3
  let hi = 1e-3
  if (meanAt(1) > target) {
    lo = 1
    hi = 1
    for (let k = 0; k < 40 && meanAt(hi) > target; k++) hi *= 2
  } else {
    hi = 1
    lo = 1
    for (let k = 0; k < 40 && meanAt(lo) < target; k++) lo *= 0.5
  }
  for (let k = 0; k < 60; k++) {
    const mid = 0.5 * (lo + hi)
    if (meanAt(mid) > target) lo = mid
    else hi = mid
  }
  const t = 0.5 * (lo + hi)

  rho0.fill(0)
  for (let d = 0; d < nd; d++) {
    const i = list[d]!
    rho0[i] = Math.min(1, Math.max(RHO_MIN, Math.pow(hat(i), t)))
  }
  const achieved = meanAt(t)
  // With the floor in place this should not trigger; recorded rather than silently
  // ignored so a genuinely infeasible profile is visible in the UI.
  f.sparse = Math.abs(achieved - target) > 0.02
}

/**
 * Concordance as a material property -- Proposition 1 rendered as stiffness.
 *
 *   M_e = sum_i H_ei * V_i        (3-vector)
 *   Z_e = sum_i H_ei * ||V_i||    (scalar)
 *   s_e = ||M_e|| / Z_e           spherical coherence, exactly 1 when all parallel
 *   g_e = Z_e / (Z_e + kappaHalf) conviction gate
 *   sEff = g*s + (1-g)*S_NEUTRAL
 *   w_e  = W_MIN + (1-W_MIN) * sEff^2
 *
 * The gate is not decoration. Bare coherence rates two near-empty but aligned cells as
 * PERFECTLY concordant, which inverts the paper: "Identity structures that are not
 * strongly related within an individual are not linked together... these identities are
 * discordant" (p. 1135), and "COMPATIBLE AND STRONG value sets can converge" (p. 1135).
 * Gating toward a neutral value gives three correct regimes:
 *
 *   strong + harmonious -> w -> 1     concordant structure, stiff, becomes a load path
 *   strong + conflicting -> w -> WMIN discordant seam, weak, erodes to void
 *   weak / unlinked     -> w mid      independent tile; dies by redundancy, not conflict
 *
 * WELL-POSEDNESS: w_e is computed once here and held fixed for the entire optimization.
 * It must never be recomputed from rho. The colour field is a static spatially-varying
 * base modulus, like a composite layup; rho is the only design variable. If w depended
 * on rho you would have a nonconvex feedback loop with no convergence guarantee,
 * inter-iteration oscillation, and mesh-dependent artifacts that density filtering
 * cannot fix, because the instability would be in the material model rather than the
 * discretization. With w fixed, K = sum(w_e * E(rho_e) * KE) is a positive combination
 * of PSD element matrices and is symmetric positive-definite unconditionally.
 */
function computeConcordance(f: MosaicFields, filterRadiusElems: number): void {
  const { grid, V, coherence, w } = f
  const { n, mask } = grid
  const list = grid.designList
  const R = Math.max(1, filterRadiusElems)
  const Ri = Math.ceil(R)

  // Precompute per-cell magnitudes once.
  const mag = new Float32Array(grid.count)
  for (let d = 0; d < list.length; d++) {
    const i = list[d]!
    mag[i] = V[3 * i]! + V[3 * i + 1]! + V[3 * i + 2]!
  }

  for (let d = 0; d < list.length; d++) {
    const i = list[d]!
    const ex = i % n
    const ey = (i - ex) / n
    let mr = 0
    let mg = 0
    let mb = 0
    let z = 0
    for (let dy = -Ri; dy <= Ri; dy++) {
      const yy = ey + dy
      if (yy < 0 || yy >= n) continue
      for (let dx = -Ri; dx <= Ri; dx++) {
        const xx = ex + dx
        if (xx < 0 || xx >= n) continue
        const j = yy * n + xx
        if (!mask[j]) continue
        // Linear "cone" weight, the same shape as the sensitivity filter.
        const wt = R - Math.hypot(dx, dy)
        if (wt <= 0) continue
        mr += wt * V[3 * j]!
        mg += wt * V[3 * j + 1]!
        mb += wt * V[3 * j + 2]!
        z += wt * mag[j]!
      }
    }
    const s = z > 1e-9 ? Math.hypot(mr, mg, mb) / z : 0
    const g = z > 1e-9 ? z / (z + KAPPA_HALF) : 0
    const sEff = g * s + (1 - g) * S_NEUTRAL
    coherence[i] = sEff
    w[i] = W_MIN + (1 - W_MIN) * Math.pow(sEff, W_EXPONENT)
  }
}

export const FIELD_CONSTANTS = Object.freeze({
  RHO_FLOOR,
  RHO_MIN,
  LAMBDA,
  KAPPA_HALF,
  S_NEUTRAL,
  W_MIN,
  W_EXPONENT,
  CUTOFF_SIGMAS,
})
