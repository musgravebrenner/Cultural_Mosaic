import type { Antagonism, PlacedTile } from '../domain/types'
import type { Grid } from './fields'

/**
 * What the solver actually did to specific pairs of tiles, read back off a completed
 * run's density field.
 *
 * Two questions, and both are answerable from data the solver already produces:
 *
 *   - Of the identities the library says are in TENSION, which ones did the optimizer
 *     actually eat the most of? That is `rankConflicts`: it restricts to antagonisms
 *     that are ENGAGED for this profile (see the identical formula in
 *     layout/fields.ts's applyDestructiveInterference) and ranks by how much of each
 *     tile's OWN material survived to the final frame.
 *
 *   - Of the tiles sitting next to each other on the lattice, which pair did the
 *     optimizer build the most real material BETWEEN, growing a one-element gutter into
 *     a load-bearing strut? That is `rankBonds`. There is no authored "harmony" list to
 *     drive this the way ANTAGONISMS drives conflict -- it is read purely off the
 *     result, which is the more honest signal anyway: it shows what the physics decided
 *     to build, not what the library predicted it would.
 *
 * Both are POST-HOC reports on a specific (seed, final) pair of density fields. Neither
 * mutates anything or feeds back into the solve.
 */

export interface ConflictEntry {
  readonly a: PlacedTile
  readonly b: PlacedTile
  readonly weight: number
  readonly why: string
  /** Mean final density over each tile's own cells, 0 = fully eaten, 1 = fully kept. */
  readonly survivalA: number
  readonly survivalB: number
  /** (1-survivalA)+(1-survivalB), 0..2. Higher = more combined material eliminated. */
  readonly loss: number
}

export interface BondEntry {
  readonly a: PlacedTile
  readonly b: PlacedTile
  /** Mean density in the connecting gutter cells, seed vs. final, both in [0,1]. */
  readonly seedDensity: number
  readonly finalDensity: number
  /** finalDensity - seedDensity. The amount of NEW real material the solver grew. */
  readonly growth: number
}

/** Mean value of `arr` over the cells `tileIndex` owns, per `provenance`. Null if none. */
function ownedMean(
  grid: Grid,
  provenance: Int16Array,
  arr: Float32Array,
  tileIndex: number,
): number | null {
  let sum = 0
  let n = 0
  for (let d = 0; d < grid.designList.length; d++) {
    const i = grid.designList[d]!
    if (provenance[i] === tileIndex) {
      sum += arr[i]!
      n++
    }
  }
  return n > 0 ? sum / n : null
}

/** Element index nearest a normalized (x, y) point, using the same convention as cx/cy. */
function nearestElement(grid: Grid, x: number, y: number): number {
  const ex = Math.max(0, Math.min(grid.n - 1, Math.round((x + 1) / grid.h - 0.5)))
  const ey = Math.max(0, Math.min(grid.n - 1, Math.round((y + 1) / grid.h - 0.5)))
  return ey * grid.n + ex
}

/**
 * Mean of `arr` over the UNOWNED cells (provenance < 0) at and around a normalized
 * point: the centre cell plus its four cardinal neighbours. Null if none of the five
 * qualify, which only happens if the midpoint landed inside a tile body -- geometrically
 * impossible for genuine lattice neighbours, since the gutter between them is real
 * space, but guarded rather than assumed.
 */
function sampleGutter(
  grid: Grid,
  provenance: Int16Array,
  arr: Float32Array,
  x: number,
  y: number,
): number | null {
  const centre = nearestElement(grid, x, y)
  const cex = centre % grid.n
  const cey = Math.floor(centre / grid.n)
  const candidates = [
    centre,
    cey > 0 ? centre - grid.n : -1,
    cey < grid.n - 1 ? centre + grid.n : -1,
    cex > 0 ? centre - 1 : -1,
    cex < grid.n - 1 ? centre + 1 : -1,
  ]
  let sum = 0
  let n = 0
  for (const i of candidates) {
    if (i < 0 || !grid.mask[i] || provenance[i]! >= 0) continue
    sum += arr[i]!
    n++
  }
  return n > 0 ? sum / n : null
}

/**
 * Antagonism pairs actually engaged by this profile's leans, ranked by how much of each
 * side's own material the optimizer removed.
 *
 * "Engaged" uses the identical formula applyDestructiveInterference does, so this chart
 * can never show a conflict as active that the physics itself treated as inactive (or
 * vice versa) -- the two are reading the same condition, not two approximations of it.
 */
export function rankConflicts(
  tiles: readonly PlacedTile[],
  antagonisms: readonly Antagonism[],
  grid: Grid,
  provenance: Int16Array,
  finalDensity: Float32Array,
  limit = 5,
): ConflictEntry[] {
  const byPair = new Map<string, { tile: PlacedTile; index: number }>()
  tiles.forEach((t, i) => byPair.set(t.pairId, { tile: t, index: i }))

  const out: ConflictEntry[] = []
  for (const ag of antagonisms) {
    const a = byPair.get(ag.a)
    const b = byPair.get(ag.b)
    if (!a || !b) continue
    const ea = Math.max(0, a.tile.lean * ag.aPole)
    const eb = Math.max(0, b.tile.lean * ag.bPole)
    const engaged = ea * eb * a.tile.salience * b.tile.salience * ag.weight
    if (engaged <= 1e-6) continue

    const survivalA = ownedMean(grid, provenance, finalDensity, a.index)
    const survivalB = ownedMean(grid, provenance, finalDensity, b.index)
    if (survivalA === null || survivalB === null) continue

    out.push({
      a: a.tile,
      b: b.tile,
      weight: ag.weight,
      why: ag.why,
      survivalA,
      survivalB,
      loss: 1 - survivalA + (1 - survivalB),
    })
  }
  out.sort((x, y) => y.loss - x.loss)
  return out.slice(0, limit)
}

/**
 * Lattice-adjacent tile pairs ranked by how much real material grew in the gutter
 * between them -- the solver deciding two identities' bridge was worth building into a
 * load path, rather than leaving it at the connectivity floor.
 *
 * Restricted to Chebyshev distance exactly 1 (immediate lattice neighbours, including
 * diagonals). That guarantees the sampled midpoint is genuine gutter and not a third
 * tile's body: no other tile can occupy the cell exactly between two lattice-adjacent
 * cells, by construction of the lattice itself. A wider radius would need real geometry
 * (segment sampling) to avoid that risk, which is more machinery than a chart aside
 * needs.
 */
export function rankBonds(
  tiles: readonly PlacedTile[],
  grid: Grid,
  provenance: Int16Array,
  seedDensity: Float32Array,
  finalDensity: Float32Array,
  limit = 5,
): BondEntry[] {
  const out: BondEntry[] = []
  for (let i = 0; i < tiles.length; i++) {
    for (let j = i + 1; j < tiles.length; j++) {
      const a = tiles[i]!
      const b = tiles[j]!
      const dCol = Math.abs(a.tileCol - b.tileCol)
      const dRow = Math.abs(a.tileRow - b.tileRow)
      if (dCol > 1 || dRow > 1 || (dCol === 0 && dRow === 0)) continue

      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const seed = sampleGutter(grid, provenance, seedDensity, mx, my)
      const final = sampleGutter(grid, provenance, finalDensity, mx, my)
      if (seed === null || final === null) continue

      out.push({ a, b, seedDensity: seed, finalDensity: final, growth: final - seed })
    }
  }
  out.sort((x, y) => y.growth - x.growth)
  return out.slice(0, limit)
}
