import type { Antagonism, PlacedTile } from '../domain/types'

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
  /** count -- 1 inside a tile, 0 in the gutters. Before the connectivity floor. */
  readonly rhoRaw: Float32Array
  /** count -- the optimizer's initial density. Floored and volume-feasible. */
  readonly rho0: Float32Array
  /** count -- gated spherical coherence in [0,1]. */
  readonly coherence: Float32Array
  /** count -- the concordance stiffness multiplier w_e in [wMin, 1]. NEVER updated with rho. */
  readonly w: Float32Array
  /**
   * count -- index into the tile array of the tile owning this cell, or -1 for gutter.
   * EXACT now that tiles do not overlap, which is what makes per-tile hover reliable.
   */
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

/**
 * Connectivity floor, and with discrete tiles it does more work than before.
 *
 * At iteration 1 the entire disc must be ONE connected component containing every pin
 * and every load, so a user profile cannot hand the optimizer a disconnected starting
 * point. That matters far more now: tiles are separated by a one-element gutter, so if
 * the gutters sat at the density minimum every single tile would be its own island under
 * 4-connectivity, the connectivity pass would constrain nearly every DOF, and the solve
 * would return no signal at all.
 *
 * The floor is also what the gutters render as: it equals the default solidLo, so
 * smoothstep maps it to zero coverage and the gutters read as background -- tiles look
 * discrete with no border-drawing code -- while still being real, weak material that
 * the optimizer can thicken into a bridge or erode.
 */
const RHO_FLOOR = 0.25
const RHO_MIN = 1e-3

/** Conviction half-saturation for the concordance gate. */
const KAPPA_HALF = 0.35
/** Where an unlinked neighbourhood sits: neutral, neither concordant nor hostile. */
const S_NEUTRAL = 0.6
const W_MIN = 0.15
const W_EXPONENT = 2
/**
 * A floor on `w` earned by a tile's OWN salience, independent of concordance.
 *
 * Without this, a "Core" identity that lands somewhere structurally redundant is
 * exactly as disposable as a "Dormant" one would be, because concordance alone reads
 * the neighbourhood, never the tile's own conviction -- contradicting the promise
 * elsewhere in this app that a decisively held identity keeps more of itself. Capped
 * well below 1, and combined with concordance by MAX rather than by replacing it: this
 * guarantees a strongly-held tile a real floor of resistance, without making it
 * immune, so a genuinely well-integrated tile can still earn full protection on
 * concordance alone, and position can still overrule conviction at the extreme.
 */
const SALIENCE_PROTECTION_CAP = 0.6
const SALIENCE_EXPONENT = 2
/**
 * How much of a tile's stiffness an engaged conflict can take away.
 *
 * DESTRUCTIVE INTERFERENCE. Two identities the library declares to be in tension do not
 * simply sit next to each other; each makes the other structurally less able to carry
 * load, so the optimizer removes material from BOTH -- which is the whole point, and why
 * it reads as interference rather than as one winning.
 *
 * Implemented as a stiffness penalty rather than as a smaller deposit, for two reasons.
 * The seed stays a faithful record of what was actually answered, at the conviction it
 * was answered with, so the static picture never understates an identity the person
 * holds strongly. And the erosion is then CONDITIONAL: weakened material that still
 * happens to be the only path to an anchor survives, because removing it would cost more
 * compliance than it saves. A conflict that is load-bearing stays; a conflict that is
 * decorative is eaten. That is a much better claim than "conflict always destroys", and
 * it is the optimizer that decides which case applies rather than this constant.
 *
 * At 0.7 a fully engaged conflict leaves 30% of the stiffness, which BESO's removal
 * threshold reliably takes and SIMP grinds down over a dozen iterations.
 */
const ANTAGONISM_BITE = 0.7

// --- Stamp ----------------------------------------------------------------

export interface FieldOptions {
  /** Sensitivity filter radius in ELEMENTS. Also the coherence neighbourhood radius. */
  readonly filterRadius: number
  /** Explicit volume fraction, or 'derived' to compute it from total strength. */
  readonly volumeFraction: number | 'derived'
  /**
   * Authored value conflicts. Omitted means no destructive interference, which is what
   * the unit tests for the field maths want.
   */
  readonly antagonisms?: readonly Antagonism[]
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

  V.fill(0)
  kappa.fill(0)
  hue.fill(0)
  rho0.fill(0)
  rhoRaw.fill(0)
  provenance.fill(-1)

  /**
   * One uniform square per answered question.
   *
   * Tiles claim disjoint lattice cells, so nothing overlaps and each cell belongs to
   * exactly one answer. That is a simplification everywhere downstream: the hue is the
   * tile's own hue rather than a weighted average, `kappa` is exactly the tile's
   * strength value (which the renderer maps to saturation, so conviction reads as colour
   * intensity rather than as area), and provenance is exact, which is what makes
   * per-tile hover trustworthy.
   */
  for (let t = 0; t < tiles.length; t++) {
    const tile = tiles[t]!
    const { x, y, sigma, amplitude } = tile
    if (amplitude <= 0 || sigma <= 0) continue
    const [hr, hg, hb] = tile.hue

    // Bounding box of the square, in element indices.
    const ex0 = Math.max(0, Math.floor((x - sigma + 1) / h - 0.5))
    const ex1 = Math.min(n - 1, Math.ceil((x + sigma + 1) / h - 0.5))
    const ey0 = Math.max(0, Math.floor((y - sigma + 1) / h - 0.5))
    const ey1 = Math.min(n - 1, Math.ceil((y + sigma + 1) / h - 0.5))

    for (let ey = ey0; ey <= ey1; ey++) {
      for (let ex = ex0; ex <= ex1; ex++) {
        const i = ey * n + ex
        if (!mask[i]) continue
        // Square, not radial: Chebyshev distance rather than Euclidean.
        if (Math.abs(cx[i]! - x) > sigma || Math.abs(cy[i]! - y) > sigma) continue

        V[3 * i] = amplitude * hr
        V[3 * i + 1] = amplitude * hg
        V[3 * i + 2] = amplitude * hb
        rhoRaw[i] = 1
        provenance[i] = t
      }
    }
  }

  let covered = 0
  for (let d = 0; d < grid.designList.length; d++) {
    const i = grid.designList[d]!
    if (rhoRaw[i]! > 0) covered++
    const kap = V[3 * i]! + V[3 * i + 1]! + V[3 * i + 2]!
    kappa[i] = kap
    if (kap > 1e-6) {
      hue[3 * i] = V[3 * i]! / kap
      hue[3 * i + 1] = V[3 * i + 1]! / kap
      hue[3 * i + 2] = V[3 * i + 2]! / kap
    }
    /**
     * Solid inside a tile, at the connectivity floor everywhere else in the disc.
     *
     * Deliberately NOT rescaled to the volume target. With a smooth Gaussian seed a
     * gamma remap was worth it, because the seed was the optimizer's whole starting
     * guess; with discrete tiles a remap can only do one of two harmful things -- crush
     * the gutters below the solid threshold, which fragments every tile into its own
     * island, or dim the tiles themselves, which throws away the saturation encoding.
     *
     * Starting above the volume target is fine: the optimality-criteria update enforces
     * the constraint every iteration and walks the volume down by at most the move limit,
     * so it lands on target within a couple of steps. Structural honesty is worth more
     * here than a feasible iteration zero.
     */
    rho0[i] = rhoRaw[i]! > 0 ? 1 : RHO_FLOOR
  }
  f.supportFraction = covered / Math.max(1, grid.designList.length)

  computeConcordance(f, opts.filterRadius)
  if (opts.antagonisms && opts.antagonisms.length > 0) {
    applyDestructiveInterference(f, tiles, opts.antagonisms)
  }

  const vf =
    opts.volumeFraction === 'derived'
      ? // The measured coverage, so the target is a share of what was actually deposited.
        deriveVolumeFraction(tiles, f.supportFraction)
      : opts.volumeFraction
  f.volumeFraction = vf
  // A profile so sparse that even the floor cannot reach the target; the optimizer will
  // still run, but the UI should say the mosaic is thin.
  f.sparse = f.supportFraction * 1 + (1 - f.supportFraction) * RHO_FLOOR < vf * 0.75
}

/**
 * Weaken both sides of every engaged conflict.
 *
 * Runs AFTER computeConcordance, because it multiplies into the stiffness field that
 * concordance produces rather than replacing it. The two are complementary and operate
 * at different ranges: concordance is local and automatic -- unlike hues touching along a
 * tile seam weaken each other wherever they happen to meet -- while this is long-range
 * and authored, so two identities that genuinely contradict each other interfere from
 * opposite sides of the disc, where no local rule could ever connect them.
 *
 * Uses `provenance`, so the penalty lands on exactly the cells the two answers own and
 * nowhere else. That is only possible because tiles are discrete; with overlapping
 * Gaussian deposits there was no cell that belonged to one answer.
 */
function applyDestructiveInterference(
  f: MosaicFields,
  tiles: readonly PlacedTile[],
  antagonisms: readonly Antagonism[],
): void {
  const byPair = new Map<string, PlacedTile>()
  for (const t of tiles) byPair.set(t.pairId, t)

  /** answerId -> total engagement against it, summed over every conflict it is in. */
  const bite = new Map<string, number>()
  for (const ag of antagonisms) {
    const ta = byPair.get(ag.a)
    const tb = byPair.get(ag.b)
    if (!ta || !tb) continue
    /**
     * Only fires when BOTH tense poles were actually chosen.
     *
     * `aPole` is -1 for poleA and +1 for poleB, so `lean * aPole` is positive exactly
     * when the answer leans toward the pole this conflict is about, and its magnitude is
     * how far. An answer that leans the other way contributes zero: holding the
     * compatible pole of a contested pair is not a conflict.
     */
    const ea = Math.max(0, ta.lean * ag.aPole)
    const eb = Math.max(0, tb.lean * ag.bPole)
    const engaged = ea * eb * ta.salience * tb.salience * ag.weight
    if (engaged <= 1e-6) continue
    bite.set(ta.answerId, (bite.get(ta.answerId) ?? 0) + engaged)
    bite.set(tb.answerId, (bite.get(tb.answerId) ?? 0) + engaged)
  }
  if (bite.size === 0) return

  // Resolve per tile index once, rather than per cell.
  const perTile = new Float32Array(tiles.length)
  for (let i = 0; i < tiles.length; i++) {
    perTile[i] = Math.min(1, bite.get(tiles[i]!.answerId) ?? 0)
  }

  const { w, provenance, grid } = f
  for (let d = 0; d < grid.designList.length; d++) {
    const i = grid.designList[d]!
    const owner = provenance[i]!
    if (owner < 0) continue
    const b = perTile[owner]!
    if (b <= 0) continue
    // Clamped to W_MIN: w multiplies the element stiffness, so it must stay strictly
    // positive or the global matrix stops being positive definite and CG will not
    // converge.
    w[i] = Math.max(W_MIN, w[i]! * (1 - ANTAGONISM_BITE * b))
  }
}

/**
 * How much of the deposited material survives the optimizer.
 *
 * Expressed as a SHARE OF WHAT THE ANSWERS DEPOSITED rather than as an absolute fraction
 * of the disc, and that is the difference between tiles getting chipped and tiles just
 * sitting there.
 *
 * The tile lattice covers a roughly fixed share of the disc -- PACK times the tile-body
 * share of a cell, so about 0.34 for a small profile down to 0.26 for a full one. An
 * absolute target of 0.2 to 0.42 straddles that: a strongly-answered 16-question profile
 * derived 0.374 against 0.325 of tile coverage, so the optimizer had MORE budget than
 * the answers asked for. Nothing had to be given up, so nothing was: every tile survived
 * intact and the spare budget went into blobby fillets between them. The whole point of
 * running the solve is that the answers propose more than the structure can afford and
 * the physics decides what earns its place.
 *
 * Anchoring to measured coverage instead makes the behaviour identical at every profile
 * size: about a fifth of the deposited material has to go, and WHICH fifth is the
 * artwork. Weak convictions, discordant seams and both sides of an engaged conflict are
 * the cheapest things to remove, so they are what gets eaten.
 *
 * The survival share still carries the original reading -- decisive identities keep more
 * of themselves than tentative ones -- and the absolute clamp still holds: below this
 * floor the truss does not merely lose material, it stops being a truss. Measured
 * directly on the shipped sample (21 answers, the default 96-element grid, BESO): at
 * 0.16 the structure nominally stays one connected component -- zero islands, zero
 * stranded loads -- but the surviving members are so thin that compliance is 150x its
 * value at iteration 1 and still climbing with no convergence after 100 iterations, i.e.
 * a mechanism in everything but name. 0.20 is still 3.5x and still unconverged. 0.25 is
 * the first value that converges cleanly (about 2x), so the floor sits meaningfully
 * above that rather than right at the edge of it, since a different profile's anchor and
 * load geometry can shift exactly where the cliff falls.
 *
 * `supportFraction` is optional so the function stays callable with tiles alone, for the
 * Advanced panel's readout and for tests of the strength mapping itself. buildFields
 * always passes the measured value.
 */
export function deriveVolumeFraction(
  tiles: readonly PlacedTile[],
  supportFraction?: number,
): number {
  if (tiles.length === 0) return 0.2
  let sum = 0
  for (const t of tiles) sum += t.salience
  const s = sum / tiles.length

  // 0.62 at all-Minor to 0.86 at all-Core: even a wholly decisive profile gives up a
  // seventh of its material, so the solve always has something to say.
  const survival = 0.62 + 0.24 * s
  const target =
    supportFraction !== undefined && supportFraction > 0
      ? supportFraction * survival
      : // No coverage measured: fall back to the absolute mapping, kept in the same band
        // the support-relative path produces so the two never disagree wildly.
        0.18 + 0.12 * s
  return Math.min(0.42, Math.max(0.28, target))
}

/**
 * Concordance as a material property -- Proposition 1 rendered as stiffness.
 *
 *   M_e = sum_i H_ei * V_i        (3-vector)
 *   Z_e = sum_i H_ei * ||V_i||    (scalar)
 *   s_e = ||M_e|| / Z_e           spherical coherence, exactly 1 when all parallel
 *   g_e = Z_e / (Z_e + kappaHalf) conviction gate
 *   sEff = g*s + (1-g)*S_NEUTRAL
 *   w_e  = max( W_MIN + (1-W_MIN)*sEff^2,  W_MIN + (SALIENCE_CAP-W_MIN)*kappa_e^2 )
 *
 * The gate is not decoration. Bare coherence rates two near-empty but aligned cells as
 * PERFECTLY concordant, which inverts the paper: "Identity structures that are not
 * strongly related within an individual are not linked together... these identities are
 * discordant" (p. 1135), and "COMPATIBLE AND STRONG value sets can converge" (p. 1135).
 * Gating toward a neutral value gives the concordance term's three regimes:
 *
 *   strong + harmonious -> w -> 1     concordant structure, stiff, becomes a load path
 *   strong + conflicting -> w -> WMIN discordant seam, weak, erodes to void
 *   weak / unlinked     -> w mid      independent tile; dies by redundancy, not conflict
 *
 * The second term in the max is what stops a fourth, previously unhandled regime --
 * strong + ISOLATED, no authored conflict and no neighbourly agreement either -- from
 * quietly falling into the same "mid, dies by redundancy" bucket as a weak one. Position
 * and neighbourhood are accidents of the lattice-packing algorithm, not a claim about
 * how much the person meant an answer; a Core-strength identity that happens to land
 * somewhere structurally redundant should not be exactly as disposable as a Dormant one
 * would be. Capped at SALIENCE_CAP rather than 1, and combined by MAX rather than by
 * replacing the concordance term: conviction earns a real floor, not immunity, so a
 * genuinely well-integrated tile can still out-earn a merely-strong one, and position
 * can still overrule conviction at the extreme.
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
    const concordanceW = W_MIN + (1 - W_MIN) * Math.pow(sEff, W_EXPONENT)
    // `mag[i]` is this cell's own kappa (0 outside any tile): the owning tile's own
    // salience, unsmoothed by the neighbourhood loop above. MAX rather than replace,
    // so a decisively held tile is never WORSE off than concordance alone would leave
    // it, and a merely well-integrated one can still earn full protection without
    // needing to also be strongly held.
    const salienceW = W_MIN + (SALIENCE_PROTECTION_CAP - W_MIN) * Math.pow(mag[i]!, SALIENCE_EXPONENT)
    w[i] = Math.max(concordanceW, salienceW)
  }
}

export const FIELD_CONSTANTS = Object.freeze({
  RHO_FLOOR,
  RHO_MIN,
  KAPPA_HALF,
  S_NEUTRAL,
  W_MIN,
  W_EXPONENT,
})
