import type { Grid } from '../layout/fields'
import type { PlacedTile } from '../domain/types'

/**
 * Which answer's colour a piece of solver-built structure belongs to -- and NEVER a
 * blend of two.
 *
 * The problem this replaces. An earlier version diffused each tile's hue outward and
 * averaged whatever arrived at a cell, then quantized the average into blocks. That
 * reads exactly like melted chocolate: a red bar and a blue bar sitting next to each
 * other come out purple in between, a colour that belongs to neither original piece.
 * Two tiles that are simply concordant neighbours should not produce a third identity
 * nobody chose.
 *
 * The right mental model, from the person who asked for this: two chocolate bars,
 * bought separately, broken into squares. Where they sit together, you see distinct
 * red squares and distinct blue squares -- identical in colour and conviction to their
 * own bar -- interleaved in proportion to how much of each bar is left. Where they
 * conflict, both get eaten down, and what is left in that gap is neither colour: it is
 * the neutral structural ink, the "something else" that fills a contested gap.
 *
 * That "proportion of bar left" is exactly a tile's SURVIVAL -- the mean final density
 * over the cells it owns, 1 = fully intact, 0 = fully eaten (by conflict, by ordinary
 * uselessness, the visual result is the same: less of that bar to hand out). Territory
 * is assigned by a multi-source weighted shortest path, seeded at cost 0 from every
 * tile's own cells and travelling outward through solid material only, where a step
 * away from a tile costs 1/survival: a fully intact tile reaches far into a shared
 * bridge, a heavily eaten one barely leaves its own body, and past a fixed cost budget
 * (assumed to be lava, essentially) nothing is left to claim it and it renders neutral.
 * Two tiles of comparable survival contest a shared boundary and each wins the cells
 * closer to itself -- which is the geometry of two things sitting NEXT TO each other,
 * not stirred INTO each other.
 *
 * A cell's neighbours are only ever entered through material that is actually there
 * (density above solidLo), so identity travels along the same struts a viewer can see
 * and never crosses open space -- it cannot jump a gap the optimizer left empty.
 *
 * Cells a tile owns are never touched: their hue and kappa are copied through exactly
 * as authored, which is what keeps every tile itself pure regardless of what its
 * neighbours are doing.
 */

/** Output buffers, reused every frame. */
export interface TerritoryBuffers {
  /** 3 per cell, one tile's exact authored hue or 0 (neutral) where nothing claims it. */
  readonly hue: Float32Array
  readonly kappa: Float32Array
  /** Scratch: -1 unclaimed, else the tile index owning that cell. */
  readonly owner: Int16Array
  /** Scratch: accumulated path cost to reach that cell, Infinity if unreached. */
  readonly cost: Float64Array
}

export function createTerritory(count: number): TerritoryBuffers {
  return {
    hue: new Float32Array(count * 3),
    kappa: new Float32Array(count),
    owner: new Int16Array(count),
    cost: new Float64Array(count),
  }
}

/** Floor under a tile's survival, so a fully-eaten tile costs a lot rather than infinity. */
const SURVIVAL_EPS = 0.02

/**
 * Reach budget, in element-steps at full survival, i.e. survival 1.0 reaches exactly
 * this many 4-connected hops before the budget runs out.
 *
 * `pitch` is the tile lattice spacing in elements (layout/polar.ts's tileGeometry). At
 * 2x pitch a fully intact tile can just clear its own gutter and cross most of the way
 * into the NEXT lattice cell, which is the range at which two intact neighbours ought to
 * visibly contest a shared boundary; a tile at half survival only reaches half that far,
 * matching the "half a bar left, half the squares" reading.
 */
function reachBudget(pitch: number): number {
  return 2 * pitch
}

/**
 * Minimal binary min-heap of (cost, tileIndex, cellIndex), so Dijkstra never needs to
 * scan for the smallest frontier element. Ties break on tile index then cell index --
 * deterministic regardless of insertion order, which insertion order itself is fixed by
 * iterating cells in index order, so the whole assignment is reproducible.
 */
class Frontier {
  private cost: number[] = []
  private tile: number[] = []
  private cell: number[] = []

  get size(): number {
    return this.cost.length
  }

  push(cost: number, tile: number, cell: number): void {
    const c = this.cost
    const t = this.tile
    const k = this.cell
    let i = c.length
    c.push(cost)
    t.push(tile)
    k.push(cell)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(i, parent)) {
        this.swap(i, parent)
        i = parent
      } else break
    }
  }

  /** Removes and returns the smallest entry, or null if empty. */
  pop(): { cost: number; tile: number; cell: number } | null {
    const n = this.cost.length
    if (n === 0) return null
    const top = { cost: this.cost[0]!, tile: this.tile[0]!, cell: this.cell[0]! }
    const last = n - 1
    this.cost[0] = this.cost[last]!
    this.tile[0] = this.tile[last]!
    this.cell[0] = this.cell[last]!
    this.cost.pop()
    this.tile.pop()
    this.cell.pop()
    let i = 0
    const size = this.cost.length
    for (;;) {
      const l = 2 * i + 1
      const r = 2 * i + 2
      let smallest = i
      if (l < size && this.less(l, smallest)) smallest = l
      if (r < size && this.less(r, smallest)) smallest = r
      if (smallest === i) break
      this.swap(i, smallest)
      i = smallest
    }
    return top
  }

  private less(a: number, b: number): boolean {
    if (this.cost[a]! !== this.cost[b]!) return this.cost[a]! < this.cost[b]!
    if (this.tile[a]! !== this.tile[b]!) return this.tile[a]! < this.tile[b]!
    return this.cell[a]! < this.cell[b]!
  }

  private swap(a: number, b: number): void {
    let tmp = this.cost[a]!
    this.cost[a] = this.cost[b]!
    this.cost[b] = tmp
    tmp = this.tile[a]!
    this.tile[a] = this.tile[b]!
    this.tile[b] = tmp
    tmp = this.cell[a]!
    this.cell[a] = this.cell[b]!
    this.cell[b] = tmp
  }
}

/** Mean of `density` over the cells `tileIndex` owns. 0 if it owns none. */
function survivalOf(
  grid: Grid,
  provenance: Int16Array,
  density: Float32Array,
  tileIndex: number,
): number {
  let sum = 0
  let n = 0
  for (let d = 0; d < grid.designList.length; d++) {
    const i = grid.designList[d]!
    if (provenance[i] === tileIndex) {
      sum += density[i]!
      n++
    }
  }
  return n > 0 ? sum / n : 0
}

export interface TerritoryOptions {
  readonly solidLo: number
  /** Tile lattice pitch in elements, from tileGeometry. Sets how far identity reaches. */
  readonly pitch: number
}

/**
 * Assigns every solid, unowned cell to the tile that can reach it most cheaply, and
 * copies owned cells through unchanged. Writes `out.hue` / `out.kappa`; `out.owner` and
 * `out.cost` are scratch, exposed only so a test can inspect the intermediate labelling.
 */
export function assignTerritory(
  grid: Grid,
  tiles: readonly PlacedTile[],
  seedHue: Float32Array,
  seedKappa: Float32Array,
  provenance: Int16Array,
  density: Float32Array,
  opts: TerritoryOptions,
  out: TerritoryBuffers,
): void {
  const { n, mask, designList } = grid
  const { owner, cost, hue, kappa } = out

  owner.fill(-1)
  cost.fill(Infinity)
  // Owned cells pass through byte-identical to the seed; only unowned cells change.
  hue.set(seedHue)
  kappa.set(seedKappa)

  if (tiles.length === 0) return

  const survival = new Float64Array(tiles.length)
  for (let t = 0; t < tiles.length; t++) {
    survival[t] = survivalOf(grid, provenance, density, t)
  }

  const budget = reachBudget(opts.pitch)
  const frontier = new Frontier()

  // Seed every owned cell that is actually SOLID at cost 0, in cell-index order for
  // determinism. A tile with no solid material of its own must not get a free
  // zero-cost foothold here: that would let it walk outward (via the same
  // `tryRelax` below) and claim a NEIGHBOUR's actually-solid, actually-connected
  // cell purely because nothing else happened to be cheaper -- painting real,
  // load-bearing structure with a fully-eroded tile's colour. A tile's own void
  // cells still render correctly regardless (see the unconditional `hue.set`
  // above): they are simply never a source other cells can be claimed FROM.
  for (let d = 0; d < designList.length; d++) {
    const i = designList[d]!
    const t = provenance[i]!
    if (t < 0 || density[i]! <= opts.solidLo) continue
    owner[i] = t
    cost[i] = 0
    frontier.push(0, t, i)
  }

  const tryRelax = (j: number, t: number, next: number): void => {
    if (!mask[j] || density[j]! <= opts.solidLo) return
    if (provenance[j]! >= 0) return // owned cells never change owner
    if (next >= cost[j]!) return
    cost[j] = next
    owner[j] = t
    frontier.push(next, t, j)
  }

  for (;;) {
    const top = frontier.pop()
    if (!top) break
    const { cost: c, tile: t, cell: i } = top
    // Stale entry: a cheaper path already finalized this (tile, cell) or a different
    // tile has since claimed it more cheaply.
    if (c > cost[i]! || owner[i] !== t) continue

    const step = 1 / Math.max(SURVIVAL_EPS, survival[t]!)
    const ex = i % n
    const ey = (i - ex) / n
    const next = c + step
    if (next > budget) continue

    if (ex > 0) tryRelax(i - 1, t, next)
    if (ex < n - 1) tryRelax(i + 1, t, next)
    if (ey > 0) tryRelax(i - n, t, next)
    if (ey < n - 1) tryRelax(i + n, t, next)
  }

  for (let d = 0; d < designList.length; d++) {
    const i = designList[d]!
    if (provenance[i]! >= 0) continue // already copied through above
    const t = owner[i]!
    if (t < 0) continue // never reached: stays neutral (hue/kappa already 0)
    const tile = tiles[t]!
    hue[3 * i] = tile.hue[0]
    hue[3 * i + 1] = tile.hue[1]
    hue[3 * i + 2] = tile.hue[2]
    kappa[i] = tile.amplitude
  }
}
