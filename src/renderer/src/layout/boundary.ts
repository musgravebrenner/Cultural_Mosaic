import type { Antagonism, Cat3, PlacedTile, TileRole } from '../domain/types'
import type { Grid } from './fields'

/**
 * PlacedTile[] -> finite element boundary conditions.
 *
 * This is where the app either crashes or does not. Every guard here corresponds to a
 * profile a real user will produce, and several of them make the difference between a
 * singular stiffness matrix and a solvable one.
 *
 * ---------------------------------------------------------------------------
 * MESH CONVENTION -- one convention, used by this module and the solver kernel alike.
 * ---------------------------------------------------------------------------
 *
 *   elements  e  = ey * n + ex          ex, ey in [0, n-1],  ey increasing in +y (UP)
 *   nodes     nd = iy * (n+1) + ix      ix, iy in [0, n],    iy increasing in +y (UP)
 *   node pos     = (-1 + ix*h, -1 + iy*h)
 *   dofs         = 2*nd (x), 2*nd + 1 (y)
 *
 *   element corner nodes, CCW from bottom-left in physical y-up coordinates:
 *     bl = ey*(n+1) + ex,  br = bl + 1,  tr = bl + (n+1) + 1,  tl = bl + (n+1)
 *     edof = [2bl, 2bl+1, 2br, 2br+1, 2tr, 2tr+1, 2tl, 2tl+1]
 *
 * The CCW-from-bottom-left LOCAL ordering is what the closed-form Q4 plane-stress KE
 * requires; getting it wrong produces a matrix that still looks symmetric and still
 * solves, but gives quietly wrong answers. Asserted by the patch test in the kernel.
 */

export interface BoundaryConditions {
  /** DOF indices held at zero displacement. */
  readonly fixedDofs: Uint32Array
  readonly loadDofs: Uint32Array
  readonly loadValues: Float32Array
  /** Elements forced to rho = 1 and excluded from the design variables. */
  readonly solidPassive: Uint32Array
  /**
   * Neutral supports the guards had to invent, so the overlay can DRAW them. Without
   * this the status strip reports more pins than there are visible ground symbols, and
   * the user cannot tell which supports are theirs and which the app added.
   */
  readonly syntheticAnchors: readonly { x: number; y: number; thetaDeg: number }[]
  /** Diagnostics, surfaced in the UI. */
  readonly nAnchors: number
  readonly nLoads: number
  /** Angular extent of the anchor set, in degrees. */
  readonly anchorExtentDeg: number
  /** Guards that fired, for an honest UI banner. */
  readonly repairs: readonly string[]
  /** Final role per answerId, after selection and repair. */
  readonly roles: ReadonlyMap<string, TileRole>
}

/** Target counts. See the notes on each bound below. */
const MIN_ANCHORS = 3
const MAX_ANCHORS = 8
const MIN_ANCHOR_SEP_DEG = 25
const MIN_ANCHOR_EXTENT_DEG = 90
const HARD_MIN_EXTENT_DEG = 40
const MAX_LOADS = 20

const PIN_RADIUS_SIGMAS = 1.2
const PASSIVE_RADIUS_SIGMAS = 1.5

/** Fraction of total load magnitude that authored conflicts may consume. */
const CONFLICT_LOAD_CAP = 0.25
/** Sharpening exponent on relatedness. At 1 everything is related to everything. */
const RELATEDNESS_NU = 2
/** Share of a load that is tangential rather than radial. */
const TANGENTIAL_FRACTION = 0.35

/**
 * Bhattacharyya coefficient between two hues on the simplex.
 *
 * Used rather than cosine similarity because it is the natural affinity for
 * distributions on a simplex (1 - BC is squared Hellinger distance, a proper metric),
 * it goes to exactly 0 for disjoint categories, and it decays faster off-axis. Cosine
 * similarity on the non-negative octant compresses everything into 0.6-1.0, so every
 * pair of hues would look related.
 *
 * One similarity notion runs through the whole model: this is also what defines
 * "related" for load direction.
 */
export function bhattacharyya(a: Cat3, b: Cat3): number {
  return Math.sqrt(a[0] * b[0]) + Math.sqrt(a[1] * b[1]) + Math.sqrt(a[2] * b[2])
}

function angDiffDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

interface Synthetic {
  readonly thetaDeg: number
  readonly x: number
  readonly y: number
  readonly sigma: number
}

/**
 * Select the anchors that will actually be pinned.
 *
 * Capped at MAX_ANCHORS, which is an aesthetic bound with a decisive structural
 * consequence: pin every rim item and the disc is over-constrained, so the optimum
 * becomes a set of short local struts near each pin. No long spans, no load paths
 * crossing the canvas, no "cultural highways" -- the problem becomes trivial and the
 * art becomes boring. Capping keeps spans long, which is what makes truss-like
 * structure appear at all.
 *
 * MIN_ANCHORS is a hard mechanical requirement rather than a preference: 2D elasticity
 * has three rigid-body modes, so fewer than three non-collinear pinned nodes leaves K
 * singular and the solve returns garbage.
 *
 * Selection is greedy farthest-point on the circle rather than simply top-ranked,
 * because angular SPREAD is what actually prevents the near-singular case where the
 * whole structure can rotate about a tight pin cluster.
 */
function selectAnchors(candidates: readonly PlacedTile[]): PlacedTile[] {
  const ranked = candidates
    .slice()
    .sort((a, b) => {
      const ra = a.immutability * a.salience
      const rb = b.immutability * b.salience
      if (rb !== ra) return rb - ra
      // Deterministic tiebreak; never rely on sort stability across engines.
      return a.pairId < b.pairId ? -1 : 1
    })

  const chosen: PlacedTile[] = []
  for (const c of ranked) {
    if (chosen.length >= MAX_ANCHORS) break
    if (chosen.every((k) => angDiffDeg(k.thetaDeg, c.thetaDeg) >= MIN_ANCHOR_SEP_DEG)) {
      chosen.push(c)
    }
  }
  // Relax the separation requirement only if that left us below the mechanical minimum.
  if (chosen.length < MIN_ANCHORS) {
    for (const c of ranked) {
      if (chosen.length >= MIN_ANCHORS) break
      if (!chosen.includes(c)) chosen.push(c)
    }
  }
  return chosen
}

function extentDeg(thetas: readonly number[]): number {
  if (thetas.length < 2) return 0
  const sorted = thetas.slice().sort((a, b) => a - b)
  // Largest gap on the circle; the extent is the complement of it.
  let maxGap = 360 - (sorted[sorted.length - 1]! - sorted[0]!)
  for (let i = 1; i < sorted.length; i++) {
    maxGap = Math.max(maxGap, sorted[i]! - sorted[i - 1]!)
  }
  return 360 - maxGap
}

export interface BoundaryOptions {
  readonly grid: Grid
  readonly antagonisms: readonly Antagonism[]
  /** pairId -> lean, so an antagonism can check whether the tense pole was chosen. */
  readonly leanByPair: ReadonlyMap<string, number>
}

export function buildBoundary(
  tiles: readonly PlacedTile[],
  opts: BoundaryOptions,
): BoundaryConditions {
  const { grid } = opts
  const { n, h, rimRadius } = grid
  const repairs: string[] = []
  const roles = new Map<string, TileRole>()
  for (const t of tiles) roles.set(t.answerId, t.role)

  let anchorCandidates = tiles.filter((t) => t.role === 'anchor')
  let loadCandidates = tiles.filter((t) => t.role === 'load')

  // --- Degenerate profile guards ------------------------------------------

  /**
   * EVERYTHING is an anchor. Then f = 0, so u = 0, compliance is zero and every
   * sensitivity is undefined -- the optimizer silently does nothing at all. This is the
   * nastiest of the degenerate cases because it does not crash.
   */
  if (loadCandidates.length === 0 && tiles.length > 0) {
    const byM = tiles.slice().sort((a, b) => a.immutability - b.immutability)
    const take = Math.max(1, Math.round(tiles.length * 0.4))
    for (const t of byM.slice(0, take)) roles.set(t.answerId, 'load')
    loadCandidates = tiles.filter((t) => roles.get(t.answerId) === 'load')
    anchorCandidates = anchorCandidates.filter((t) => roles.get(t.answerId) === 'anchor')
    repairs.push(`No fluid identities: promoted the ${take} least-fixed to loads.`)
  }

  /** No anchors at all leaves K singular. Promote the most fixed items. */
  if (anchorCandidates.length === 0 && tiles.length > 0) {
    const byM = tiles.slice().sort((a, b) => b.immutability - a.immutability)
    for (const t of byM.slice(0, MIN_ANCHORS)) {
      roles.set(t.answerId, 'anchor')
    }
    anchorCandidates = tiles.filter((t) => roles.get(t.answerId) === 'anchor')
    loadCandidates = loadCandidates.filter((t) => roles.get(t.answerId) !== 'anchor')
    repairs.push('No immutable identities: promoted the most fixed to rim anchors.')
  }

  const anchors = selectAnchors(anchorCandidates)
  for (const t of anchorCandidates) {
    if (!anchors.includes(t)) roles.set(t.answerId, 'mass')
  }

  // Synthetic anchors, used to reach the mechanical minimum and the extent floor. They
  // contribute NO colour -- they exist purely so the system is solvable, and the UI says
  // so rather than pretending the result is a portrait.
  const synthetics: Synthetic[] = []
  const anchorThetas = anchors.map((a) => a.thetaDeg)

  const addSynthetic = (deg: number): void => {
    const a = (deg * Math.PI) / 180
    synthetics.push({
      thetaDeg: deg,
      x: rimRadius * Math.cos(a),
      y: rimRadius * Math.sin(a),
      sigma: 2.5 * h,
    })
    anchorThetas.push(deg)
  }

  if (tiles.length === 0) {
    for (const deg of [60, 180, 300]) addSynthetic(deg)
    repairs.push('Nothing answered: showing a default three-legged support only.')
  }

  // Track synthetics per phase, so every guard that fires is actually REPORTED. The
  // whole purpose of `repairs` is an honest UI banner -- silently propping up a
  // degenerate profile and presenting the result as a portrait would be worse than
  // failing.
  const synthBeforeMin = synthetics.length

  for (const deg of [60, 180, 300]) {
    if (anchorThetas.length >= MIN_ANCHORS) break
    if (anchorThetas.every((t) => angDiffDeg(t, deg) >= MIN_ANCHOR_SEP_DEG)) addSynthetic(deg)
  }
  // Fall back to evenly spaced additions if the canonical three collided with real ones.
  let sweep = 0
  while (anchorThetas.length < MIN_ANCHORS && sweep < 360) {
    if (anchorThetas.every((t) => angDiffDeg(t, sweep) >= MIN_ANCHOR_SEP_DEG)) {
      addSynthetic(sweep)
    }
    sweep += 37
  }
  if (synthetics.length > synthBeforeMin && tiles.length > 0) {
    repairs.push('Too few immutable identities: added neutral supports for stability.')
  }

  /**
   * Anchors clustered in a narrow arc let the whole structure rotate about the cluster.
   * K is technically invertible but horribly conditioned, giving enormous displacements
   * and nonsense sensitivities -- which presents as a solver bug rather than a data one.
   */
  const synthBeforeSpread = synthetics.length
  if (extentDeg(anchorThetas) < MIN_ANCHOR_EXTENT_DEG && anchorThetas.length > 0) {
    const base = anchorThetas[0]!
    for (const off of [120, 240, 60, 180, 300]) {
      if (extentDeg(anchorThetas) >= MIN_ANCHOR_EXTENT_DEG) break
      const deg = (base + off) % 360
      if (anchorThetas.every((t) => angDiffDeg(t, deg) >= MIN_ANCHOR_SEP_DEG)) addSynthetic(deg)
    }
    if (synthetics.length > synthBeforeSpread) {
      repairs.push('Anchors were clustered in one direction: spread them for stability.')
    }
  }

  // Cap the number of loads by merging the weakest into their neighbours' resultant.
  let loads = loadCandidates
  if (loads.length > MAX_LOADS) {
    loads = loads
      .slice()
      .sort((a, b) => b.salience - a.salience)
      .slice(0, MAX_LOADS)
    for (const t of loadCandidates) {
      if (!loads.includes(t)) roles.set(t.answerId, 'mass')
    }
    repairs.push(`More than ${MAX_LOADS} fluid identities: kept the strongest.`)
  }

  // --- Load force vectors -------------------------------------------------

  const forceX = new Map<string, number>()
  const forceY = new Map<string, number>()
  const anchorHues: { hue: Cat3; x: number; y: number; s: number }[] = anchors.map((a) => ({
    hue: a.hue,
    x: a.x,
    y: a.y,
    s: a.salience,
  }))
  // Synthetics participate geometrically but carry no hue, so they attract weakly and
  // equally rather than pretending to a category.
  for (const s of synthetics) {
    anchorHues.push({ hue: [1 / 3, 1 / 3, 1 / 3], x: s.x, y: s.y, s: 0.4 })
  }

  for (const t of loads) {
    let fx = 0
    let fy = 0
    const omegas: number[] = []
    let omegaSum = 0
    for (const a of anchorHues) {
      const w = Math.pow(bhattacharyya(t.hue, a.hue), RELATEDNESS_NU) * a.s
      omegas.push(w)
      omegaSum += w
    }

    /**
     * ATTRACTION toward concordant anchors. A fluid identity pulls toward what it is
     * rooted in, so the optimizer must build material along that line and a truss
     * materializes between the hobby and the heritage that motivates it.
     *
     * Repulsion would push material away from the concordant anchor and grow a strut
     * pointing at nothing -- mechanically arbitrary and semantically backwards.
     */
    for (let k = 0; k < anchorHues.length; k++) {
      const a = anchorHues[k]!
      const dx = a.x - t.x
      const dy = a.y - t.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) continue
      const wk = omegas[k]! / (omegaSum + 1e-9)
      fx += t.salience * wk * (dx / d)
      fy += t.salience * wk * (dy / d)
    }

    /**
     * The discordant term is TANGENTIAL rather than repulsive, for two reasons.
     *
     * First, radial and tangential are orthogonal, so the two terms cannot silently
     * cancel. A repulsive term would partly cancel the attractive one for anchors of
     * middling relatedness, producing near-zero loads with no way to notice -- a whole
     * class of invisible bug where the art quietly stops responding to the profile.
     *
     * Second, shear is structurally richer than axial load: a tangential demand produces
     * diagonal bracing and twisted geometry, which reads far better as a contradictory
     * profile than "another radial strut".
     */
    const omegaMax = Math.max(1e-9, ...omegas)
    let sSum = 0
    for (const a of anchorHues) sSum += a.s
    for (let k = 0; k < anchorHues.length; k++) {
      const a = anchorHues[k]!
      const dx = a.x - t.x
      const dy = a.y - t.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) continue
      const discord = 1 - omegas[k]! / omegaMax
      // Rotate the unit vector by +90 degrees.
      const tx = -dy / d
      const ty = dx / d
      const c = (TANGENTIAL_FRACTION * t.salience * discord * a.s) / (sSum + 1e-9)
      fx += c * tx
      fy += c * ty
    }

    if (Math.hypot(fx, fy) < 1e-9) {
      // Degenerate fallback: push radially outward, so the tile still demands support.
      const a = (t.thetaDeg * Math.PI) / 180
      fx = t.salience * Math.cos(a)
      fy = t.salience * Math.sin(a)
    }
    forceX.set(t.answerId, fx)
    forceY.set(t.answerId, fy)
  }

  /**
   * Authored long-range conflicts, applied as equal and opposite forces pulling the two
   * identities apart along the line between them.
   *
   * Realized as a load rather than a stiffness change on purpose: only `f` changes, so
   * K stays symmetric positive-definite and the problem remains a standard linear
   * elastic compliance minimization. It is also the better semantic reading -- the paper
   * describes cross-tile conflict as competing DEMANDS on behaviour (p. 1134), not as
   * soft material. The structure must then build material to resist being torn, giving
   * either a visible tensile strut (conflict structurally resolved) or a fracture
   * (unresolved). Being self-equilibrated, it adds no net reaction at the pins.
   */
  const byPair = new Map<string, PlacedTile>()
  for (const t of tiles) byPair.set(t.pairId, t)
  const conflictPairs: { a: PlacedTile; b: PlacedTile; c: number }[] = []
  for (const ag of opts.antagonisms) {
    const ta = byPair.get(ag.a)
    const tb = byPair.get(ag.b)
    if (!ta || !tb) continue
    const la = opts.leanByPair.get(ag.a) ?? 0
    const lb = opts.leanByPair.get(ag.b) ?? 0
    // Only fires when BOTH tense poles were actually chosen, scaled by how far toward
    // them the user leaned and how much each identity matters.
    const engaged =
      Math.max(0, la * ag.aPole) * Math.max(0, lb * ag.bPole) * ta.salience * tb.salience
    if (engaged <= 1e-6) continue
    conflictPairs.push({ a: ta, b: tb, c: engaged * ag.weight })
  }

  let baseMag = 0
  for (const t of loads) baseMag += Math.hypot(forceX.get(t.answerId)!, forceY.get(t.answerId)!)
  let conflictMag = 0
  for (const cp of conflictPairs) conflictMag += 2 * cp.c
  // Above the cap the structure spends its whole budget resisting itself and every
  // mosaic becomes a torn mess -- neither informative nor good art.
  const conflictScale =
    conflictMag > 0 && baseMag > 0
      ? Math.min(1, (CONFLICT_LOAD_CAP * baseMag) / conflictMag)
      : conflictMag > 0
        ? 1
        : 0

  for (const cp of conflictPairs) {
    const dx = cp.b.x - cp.a.x
    const dy = cp.b.y - cp.a.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) continue
    const m = cp.c * conflictScale
    const ux = dx / d
    const uy = dy / d
    forceX.set(cp.a.answerId, (forceX.get(cp.a.answerId) ?? 0) - m * ux)
    forceY.set(cp.a.answerId, (forceY.get(cp.a.answerId) ?? 0) - m * uy)
    forceX.set(cp.b.answerId, (forceX.get(cp.b.answerId) ?? 0) + m * ux)
    forceY.set(cp.b.answerId, (forceY.get(cp.b.answerId) ?? 0) + m * uy)
  }

  // --- Discretize onto the mesh -------------------------------------------

  const nn = n + 1
  const nodeAt = (ix: number, iy: number): number => iy * nn + ix
  const nodeX = (ix: number): number => -1 + ix * h
  const nodeY = (iy: number): number => -1 + iy * h

  const fixed = new Set<number>()
  const passive = new Set<number>()

  const pinRegion = (x: number, y: number, sigma: number): void => {
    const r = Math.max(PIN_RADIUS_SIGMAS * sigma, 1.01 * h)
    const ix0 = Math.max(0, Math.floor((x - r + 1) / h))
    const ix1 = Math.min(n, Math.ceil((x + r + 1) / h))
    const iy0 = Math.max(0, Math.floor((y - r + 1) / h))
    const iy1 = Math.min(n, Math.ceil((y + r + 1) / h))
    let count = 0
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        if (Math.hypot(nodeX(ix) - x, nodeY(iy) - y) > r) continue
        const nd = nodeAt(ix, iy)
        fixed.add(2 * nd)
        fixed.add(2 * nd + 1)
        count++
      }
    }
    // A single-node pin creates a stress singularity the optimizer will chase, growing
    // a needle of material into the pin. Guarantee at least the nearest four nodes.
    if (count === 0) {
      const ix = Math.min(n, Math.max(0, Math.round((x + 1) / h)))
      const iy = Math.min(n, Math.max(0, Math.round((y + 1) / h)))
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ] as const) {
        const nd = nodeAt(Math.min(n, ix + dx), Math.min(n, iy + dy))
        fixed.add(2 * nd)
        fixed.add(2 * nd + 1)
      }
    }
  }

  /**
   * Passive solid patches at every pin and every load. Non-optional: without them the
   * optimizer hits the classic SIMP degenerate minimum of deleting the material under a
   * point load, at which point compliance blows up. It also removes the mesh-dependent
   * stress singularity at a single-node load.
   */
  const solidRegion = (x: number, y: number, sigma: number): void => {
    const r = Math.max(PASSIVE_RADIUS_SIGMAS * sigma, 1.5 * h)
    const ex0 = Math.max(0, Math.floor((x - r + 1) / h - 0.5))
    const ex1 = Math.min(n - 1, Math.ceil((x + r + 1) / h - 0.5))
    const ey0 = Math.max(0, Math.floor((y - r + 1) / h - 0.5))
    const ey1 = Math.min(n - 1, Math.ceil((y + r + 1) / h - 0.5))
    for (let ey = ey0; ey <= ey1; ey++) {
      for (let ex = ex0; ex <= ex1; ex++) {
        const e = ey * n + ex
        if (!grid.mask[e]) continue
        if (Math.hypot(grid.cx[e]! - x, grid.cy[e]! - y) <= r) passive.add(e)
      }
    }
  }

  for (const a of anchors) {
    pinRegion(a.x, a.y, a.sigma)
    solidRegion(a.x, a.y, a.sigma)
  }
  for (const s of synthetics) {
    pinRegion(s.x, s.y, s.sigma)
    solidRegion(s.x, s.y, s.sigma)
  }

  const loadDofs: number[] = []
  const loadVals: number[] = []
  for (const t of loads) {
    const fx = forceX.get(t.answerId) ?? 0
    const fy = forceY.get(t.answerId) ?? 0
    if (Math.hypot(fx, fy) < 1e-12) continue
    const ix = Math.min(n, Math.max(0, Math.round((t.x + 1) / h)))
    const iy = Math.min(n, Math.max(0, Math.round((t.y + 1) / h)))
    const nd = nodeAt(ix, iy)
    // A DOF that is both pinned and loaded is a contradiction; the pin wins and the
    // load is dropped rather than silently ignored by the solver.
    if (fixed.has(2 * nd) || fixed.has(2 * nd + 1)) continue
    loadDofs.push(2 * nd, 2 * nd + 1)
    loadVals.push(fx, fy)
    solidRegion(t.x, t.y, t.sigma)
  }

  /**
   * Compliance minimization is scale-invariant in f -- the shape of the optimum depends
   * only on RELATIVE load magnitudes -- so normalizing removes a whole category of
   * force-unit tuning and keeps K u = f equally well conditioned across profiles of
   * very different size.
   */
  let total = 0
  for (let k = 0; k < loadVals.length; k += 2) {
    total += Math.hypot(loadVals[k]!, loadVals[k + 1]!)
  }
  if (total > 1e-12) {
    for (let k = 0; k < loadVals.length; k++) loadVals[k]! /= total
  } else if (tiles.length >= 0) {
    // No usable load at all. Apply a unit centripetal load at the hub so the system is
    // still well posed, and say so.
    const ix = Math.round(1 / h)
    const nd = nodeAt(ix, ix)
    loadDofs.length = 0
    loadVals.length = 0
    loadDofs.push(2 * nd, 2 * nd + 1)
    loadVals.push(0, 1)
    solidRegion(0, 0, 3 * h)
    repairs.push('No directional demands found: applied a single neutral load at the centre.')
  }

  for (const t of loads) if (roles.get(t.answerId) === undefined) roles.set(t.answerId, 'load')

  return {
    fixedDofs: Uint32Array.from([...fixed].sort((a, b) => a - b)),
    loadDofs: Uint32Array.from(loadDofs),
    loadValues: Float32Array.from(loadVals),
    solidPassive: Uint32Array.from([...passive].sort((a, b) => a - b)),
    syntheticAnchors: synthetics.map((s) => ({ x: s.x, y: s.y, thetaDeg: s.thetaDeg })),
    nAnchors: anchors.length + synthetics.length,
    nLoads: loadDofs.length / 2,
    anchorExtentDeg: extentDeg(anchorThetas),
    repairs,
    roles,
  }
}

export const BOUNDARY_CONSTANTS = Object.freeze({
  MIN_ANCHORS,
  MAX_ANCHORS,
  MIN_ANCHOR_SEP_DEG,
  MIN_ANCHOR_EXTENT_DEG,
  HARD_MIN_EXTENT_DEG,
  MAX_LOADS,
  CONFLICT_LOAD_CAP,
  RELATEDNESS_NU,
  TANGENTIAL_FRACTION,
})
