import { describe, it, expect } from 'vitest'
import { assignTerritory, createTerritory } from './territory'
import { createGrid, createFields, buildFields } from '../layout/fields'
import { DEFAULT_LAYOUT, placeAnswers, tileGeometry } from '../layout/polar'
import { LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex, StrengthLevel, TileAnswer } from '../domain/types'

/**
 * The property this whole module exists for: territory is assigned WHOLESALE to one
 * tile, never blended between two. Every assertion here is really checking for the
 * absence of the "melted chocolate" bug -- a cell whose colour is some third hue that
 * belongs to neither of its two nearest tiles.
 */

const N = 64
const LAYOUT = { ...DEFAULT_LAYOUT, gridSize: N as 64 }
const GRID = createGrid(N, DEFAULT_LAYOUT.rimRadius)
const LO = 0.25

function ans(pairId: string, leanIndex: LeanIndex, strength: StrengthLevel, k: number): TileAnswer {
  return { answerId: `a-${pairId}`, pairId, leanIndex, strength, addedAt: k }
}

function fieldsFor(answers: TileAnswer[]): {
  tiles: ReturnType<typeof placeAnswers>
  f: ReturnType<typeof createFields>
} {
  const tiles = placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
  const f = createFields(GRID)
  buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 'derived' })
  return { tiles, f }
}

/** A density field solid everywhere in the disc: maximum room for territory to spread. */
function solidEverywhere(): Float32Array {
  const d = new Float32Array(GRID.count)
  for (const i of GRID.designList) d[i] = 1
  return d
}

/**
 * True if (r,g,b) matches some tile's authored hue (or is neutral/zero), within
 * float32 rounding. Never string-keyed equality: `out.hue` is a Float32Array, so a
 * value read back from it is only float32-close to the float64 the tile itself
 * carries, not bit-identical.
 */
function isKnownHue(tiles: ReturnType<typeof placeAnswers>, r: number, g: number, b: number): boolean {
  const close = (a: number, b2: number): boolean => Math.abs(a - b2) < 1e-5
  if (close(r, 0) && close(g, 0) && close(b, 0)) return true
  return tiles.some((t) => close(t.hue[0], r) && close(t.hue[1], g) && close(t.hue[2], b))
}

describe('assignTerritory', () => {
  it('copies owned cells through byte-identical to the seed', () => {
    const { tiles, f } = fieldsFor(
      LIBRARY.slice(0, 20).map((p, k) => ans(p.id, ((k * 3) % 7) as LeanIndex, 2, k)),
    )
    const out = createTerritory(GRID.count)
    assignTerritory(
      GRID,
      tiles,
      f.hue,
      f.kappa,
      f.provenance,
      solidEverywhere(),
      { solidLo: LO, pitch: tileGeometry(tiles.length, LAYOUT).pitch },
      out,
    )
    for (const i of GRID.designList) {
      if (f.provenance[i]! < 0) continue
      expect(out.kappa[i]!, `elem ${i} kappa`).toBe(f.kappa[i]!)
      for (let c = 0; c < 3; c++) {
        expect(out.hue[3 * i + c]!, `elem ${i} ch${c}`).toBe(f.hue[3 * i + c]!)
      }
    }
  })

  /**
   * THE core property. Every unowned cell that gets a colour at all must get EXACTLY
   * one tile's authored hue -- not an average, not a third colour. A continuous blend
   * would produce values that are not in this set; a correct discrete assignment
   * cannot.
   */
  it('gives every claimed cell EXACTLY one tile\'s authored hue, never a blend', () => {
    const { tiles, f } = fieldsFor(
      LIBRARY.slice(0, 20).map((p, k) => ans(p.id, ((k * 3) % 7) as LeanIndex, 2, k)),
    )
    const out = createTerritory(GRID.count)
    assignTerritory(
      GRID,
      tiles,
      f.hue,
      f.kappa,
      f.provenance,
      solidEverywhere(),
      { solidLo: LO, pitch: tileGeometry(tiles.length, LAYOUT).pitch },
      out,
    )
    let claimed = 0
    for (const i of GRID.designList) {
      if (f.provenance[i]! >= 0) continue
      const r = out.hue[3 * i]!
      const g = out.hue[3 * i + 1]!
      const b = out.hue[3 * i + 2]!
      expect(
        isKnownHue(tiles, r, g, b),
        `elem ${i} hue (${r},${g},${b}) is not any tile's exact hue`,
      ).toBe(true)
      if (out.kappa[i]! > 0) claimed++
    }
    expect(claimed, 'some bridge material was actually claimed').toBeGreaterThan(0)
  })

  /**
   * The two-bar case, named after the metaphor: a fully intact "red" tile and a fully
   * intact "blue" tile with a gap between them. The gap must split into a red side and
   * a blue side with a boundary somewhere between -- not a uniform purple.
   */
  it('splits a gap between two equally-intact tiles into two pure sides', () => {
    const red = {
      answerId: 'red', pairId: 'red', label: 'r', activePole: 'r',
      hue: [1, 0, 0] as const, purity: 1, lean: 0, polarity: 0, salience: 1,
      immutability: 0.5, thetaDeg: 0, radius: 0, x: -0.3, y: 0,
      tileCol: -3, tileRow: 0, sigma: 0.05, amplitude: 1, role: 'mass' as const,
    }
    const blue = { ...red, answerId: 'blue', pairId: 'blue', hue: [0, 0, 1] as const, x: 0.3, tileCol: 3 }
    const tiles = [red, blue]

    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 'derived' })

    const out = createTerritory(GRID.count)
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, solidEverywhere(),
      { solidLo: LO, pitch: 14 }, out)

    const h = 2 / N
    const at = (x: number): number => {
      const ex = Math.round((x + 1) / h - 0.5)
      const ey = Math.round((0 + 1) / h - 0.5)
      return ey * N + ex
    }
    // Just off red's own body, toward blue: must be pure red, not a mix.
    expect(out.hue[3 * at(-0.15)]).toBeCloseTo(1, 6)
    expect(out.hue[3 * at(-0.15) + 2]).toBeCloseTo(0, 6)
    // Just off blue's own body, toward red: must be pure blue.
    expect(out.hue[3 * at(0.15) + 2]).toBeCloseTo(1, 6)
    expect(out.hue[3 * at(0.15)]).toBeCloseTo(0, 6)
    // And nowhere in between is there a cell with BOTH channels nonzero -- the
    // signature of a blend.
    for (let ex = 0; ex < N; ex++) {
      const i = at(-1 + (ex + 0.5) * h)
      if (f.provenance[i]! >= 0) continue
      const r = out.hue[3 * i]!
      const b = out.hue[3 * i + 2]!
      expect(r > 0 && b > 0, `elem ${i} is a blend (${r}, ${b})`).toBe(false)
    }
  })

  /** A tile the solver ate down to near-zero survival cannot claim new territory. */
  it('lets a heavily-eaten tile keep its own body but not spread into a neighbour', () => {
    const strong = {
      answerId: 'strong', pairId: 'strong', label: 's', activePole: 's',
      hue: [1, 0, 0] as const, purity: 1, lean: 0, polarity: 0, salience: 1,
      immutability: 0.5, thetaDeg: 0, radius: 0, x: -0.2, y: 0,
      tileCol: -2, tileRow: 0, sigma: 0.05, amplitude: 1, role: 'mass' as const,
    }
    const eaten = { ...strong, answerId: 'eaten', pairId: 'eaten', hue: [0, 0, 1] as const, x: 0.2, tileCol: 2 }
    const tiles = [strong, eaten]
    const f = createFields(GRID)
    buildFields(f, tiles, { filterRadius: 2.2, volumeFraction: 'derived' })

    const density = solidEverywhere()
    // Eat "eaten"'s own material down to almost nothing.
    for (const i of GRID.designList) if (f.provenance[i] === 1) density[i] = 0.26

    const out = createTerritory(GRID.count)
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, density,
      { solidLo: LO, pitch: 14 }, out)

    // "eaten"'s own cells still show its own colour -- owned cells are never touched.
    let ownCellSeen = false
    for (const i of GRID.designList) {
      if (f.provenance[i] !== 1) continue
      ownCellSeen = true
      expect(out.hue[3 * i + 2]).toBeCloseTo(1, 6)
    }
    expect(ownCellSeen).toBe(true)

    // But the midpoint between them, which "strong" can reach and "eaten" barely can,
    // belongs to "strong" -- not to the tile that has almost nothing left to spread.
    const h = 2 / N
    const mid = Math.round((0 + 1) / h - 0.5) + Math.round((0 + 1) / h - 0.5) * N
    if (f.provenance[mid]! < 0) {
      expect(out.hue[3 * mid]!, 'midpoint should favour the intact tile').toBeGreaterThan(
        out.hue[3 * mid + 2]!,
      )
    }
  })

  it('renders unreachable material as neutral (zero kappa, zero hue)', () => {
    const { tiles, f } = fieldsFor([ans('D-AGE-01', 5, 3, 0)])
    const density = new Float32Array(GRID.count)
    // Only the tile's own cells are solid; everything else is void, so nothing can
    // ever be reached from it.
    for (const i of GRID.designList) density[i] = f.provenance[i]! >= 0 ? 1 : 0
    const out = createTerritory(GRID.count)
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, density,
      { solidLo: LO, pitch: tileGeometry(1, LAYOUT).pitch }, out)
    for (const i of GRID.designList) {
      if (f.provenance[i]! >= 0) continue
      expect(out.kappa[i]!, `elem ${i}`).toBe(0)
      expect(out.hue[3 * i]! + out.hue[3 * i + 1]! + out.hue[3 * i + 2]!, `elem ${i}`).toBe(0)
    }
  })

  it('handles zero tiles without throwing', () => {
    const f = createFields(GRID)
    buildFields(f, [], { filterRadius: 2.2, volumeFraction: 0.2 })
    const out = createTerritory(GRID.count)
    expect(() =>
      assignTerritory(GRID, [], f.hue, f.kappa, f.provenance, f.rho0, { solidLo: LO, pitch: 8 }, out),
    ).not.toThrow()
    for (const i of GRID.designList) expect(out.kappa[i]!).toBe(0)
  })

  it('is deterministic across runs and safe to reuse its buffers', () => {
    const { tiles, f } = fieldsFor(
      LIBRARY.slice(0, 15).map((p, k) => ans(p.id, ((k * 3) % 7) as LeanIndex, 2, k)),
    )
    const density = solidEverywhere()
    const opts = { solidLo: LO, pitch: tileGeometry(tiles.length, LAYOUT).pitch }
    const a = createTerritory(GRID.count)
    const b = createTerritory(GRID.count)
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, density, opts, a)
    // b is used for something else first, to prove reuse doesn't leak stale state.
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, new Float32Array(GRID.count), opts, b)
    assignTerritory(GRID, tiles, f.hue, f.kappa, f.provenance, density, opts, b)
    expect(Array.from(b.hue)).toEqual(Array.from(a.hue))
    expect(Array.from(b.kappa)).toEqual(Array.from(a.kappa))
  })

  it('produces no NaN or Infinity for the full library', () => {
    const { tiles, f } = fieldsFor(LIBRARY.map((p, k) => ans(p.id, ((k * 3) % 7) as LeanIndex, 2, k)))
    const out = createTerritory(GRID.count)
    assignTerritory(
      GRID, tiles, f.hue, f.kappa, f.provenance, solidEverywhere(),
      { solidLo: LO, pitch: tileGeometry(tiles.length, LAYOUT).pitch }, out,
    )
    for (const i of GRID.designList) {
      expect(Number.isFinite(out.kappa[i]!), `elem ${i}`).toBe(true)
      for (let c = 0; c < 3; c++) expect(Number.isFinite(out.hue[3 * i + c]!)).toBe(true)
    }
  })

  it('never writes outside the disc', () => {
    const { tiles, f } = fieldsFor(
      LIBRARY.slice(0, 20).map((p, k) => ans(p.id, ((k * 3) % 7) as LeanIndex, 2, k)),
    )
    const out = createTerritory(GRID.count)
    assignTerritory(
      GRID, tiles, f.hue, f.kappa, f.provenance, solidEverywhere(),
      { solidLo: LO, pitch: tileGeometry(tiles.length, LAYOUT).pitch }, out,
    )
    for (let i = 0; i < GRID.count; i++) {
      if (GRID.mask[i]) continue
      expect(out.kappa[i]!, `elem ${i}`).toBe(0)
    }
  })
})
