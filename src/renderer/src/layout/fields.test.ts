import { describe, it, expect } from 'vitest'
import { createGrid, createFields, buildFields, deriveVolumeFraction, FIELD_CONSTANTS } from './fields'
import type { FieldOptions, MosaicFields } from './fields'
import { DEFAULT_LAYOUT, placeAnswers } from './polar'
import { ANTAGONISMS, LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex, PlacedTile, StrengthLevel, TileAnswer } from '../domain/types'

const N = 64
const LAYOUT = { ...DEFAULT_LAYOUT, gridSize: N as 64 }
const GRID = createGrid(N, DEFAULT_LAYOUT.rimRadius)
const OPTS: FieldOptions = { filterRadius: 2.2, volumeFraction: 'derived' }

function ans(
  pairId: string,
  leanIndex: LeanIndex = 3,
  strength: StrengthLevel = 2,
  addedAt = 0,
): TileAnswer {
  return { answerId: `a-${pairId}`, pairId, leanIndex, strength, addedAt }
}

function place(answers: TileAnswer[]): PlacedTile[] {
  return placeAnswers({ answers, pairs: LIBRARY_BY_ID, layout: LAYOUT })
}

function build(tiles: PlacedTile[], opts: FieldOptions = OPTS): MosaicFields {
  const f = createFields(GRID)
  buildFields(f, tiles, opts)
  return f
}

/** A synthetic tile, so field behaviour can be tested without library coupling. */
function tile(over: Partial<PlacedTile> = {}): PlacedTile {
  return {
    answerId: 'synthetic',
    pairId: 'synthetic',
    label: 'a ↔ b',
    activePole: 'a',
    hue: [1, 0, 0],
    purity: 1,
    lean: 1,
    polarity: 1,
    salience: 1,
    immutability: 0.5,
    thetaDeg: 0,
    radius: 0,
    x: 0,
    y: 0,
    tileCol: 0,
    tileRow: 0,
    sigma: 0.1,
    amplitude: 1,
    role: 'mass',
    ...over,
  }
}

/** Element index containing a normalized point. */
function at(x: number, y: number): number {
  const ex = Math.floor((x + 1) / GRID.h)
  const ey = Math.floor((y + 1) / GRID.h)
  return ey * N + ex
}

describe('createGrid', () => {
  it('masks a disc whose area matches pi*r^2', () => {
    const expected = Math.PI * DEFAULT_LAYOUT.rimRadius ** 2
    const actual = (GRID.designList.length / GRID.count) * 4 // domain is [-1,1]^2, area 4
    expect(actual).toBeCloseTo(expected, 1)
  })

  it('agrees between mask and designList', () => {
    let m = 0
    for (const v of GRID.mask) m += v
    expect(m).toBe(GRID.designList.length)
    for (const i of GRID.designList) expect(GRID.mask[i]).toBe(1)
  })
})

describe('the tile stamp', () => {
  it('is a filled square, not a radial falloff', () => {
    const f = build([tile({ sigma: 0.2, x: 0, y: 0 })], { ...OPTS, volumeFraction: 0.35 })
    // The corner of the square is inside, while a point the same distance out along the
    // axis is beyond it. No radial kernel can satisfy both.
    expect(f.rhoRaw[at(0.18, 0.18)]!, 'corner inside').toBe(1)
    expect(f.rhoRaw[at(0.25, 0)]!, 'past the edge on the axis').toBe(0)
    expect(f.rhoRaw[at(0.18, 0)]!, 'inside on the axis').toBe(1)
  })

  it('is uniform across its whole body -- conviction is colour, not area', () => {
    const f = build([tile({ sigma: 0.2, amplitude: 0.66 })], { ...OPTS, volumeFraction: 0.35 })
    for (const i of [at(0, 0), at(0.1, 0.1), at(-0.15, 0.05), at(0.18, -0.18)]) {
      expect(f.rhoRaw[i]!, `cell ${i} density`).toBe(1)
      // kappa IS the strength value, which the renderer maps to saturation.
      expect(f.kappa[i]!, `cell ${i} conviction`).toBeCloseTo(0.66, 6)
    }
  })

  it('carries the tile hue exactly, with no averaging', () => {
    // Tiles claim disjoint lattice cells, so a cell belongs to exactly one answer and
    // needs no weighted average.
    const f = build([tile({ hue: [0.5, 0, 0.5], sigma: 0.2 })], { ...OPTS, volumeFraction: 0.35 })
    const i = at(0, 0)
    expect(f.hue[3 * i]!).toBeCloseTo(0.5, 6)
    expect(f.hue[3 * i + 1]!).toBeCloseTo(0, 6)
    expect(f.hue[3 * i + 2]!).toBeCloseTo(0.5, 6)
  })

  it('scales conviction with strength while density stays flat', () => {
    const strong = build([tile({ amplitude: 1, sigma: 0.2 })], { ...OPTS, volumeFraction: 0.35 })
    const weak = build([tile({ amplitude: 0.33, sigma: 0.2 })], { ...OPTS, volumeFraction: 0.35 })
    const i = at(0, 0)
    // Same area, same density: only conviction differs, which is exactly the point of
    // moving the encoding off size and onto saturation.
    expect(strong.rhoRaw[i]!).toBe(weak.rhoRaw[i]!)
    expect(strong.kappa[i]!).toBeGreaterThan(weak.kappa[i]!)
  })

  it('records exact provenance inside a tile and none in the gutters', () => {
    const f = build(
      [
        tile({ sigma: 0.1, x: -0.4, y: 0 }),
        tile({ hue: [0, 0, 1], sigma: 0.1, x: 0.4, y: 0, tileCol: 4 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    expect(f.provenance[at(-0.4, 0)]).toBe(0)
    expect(f.provenance[at(0.4, 0)]).toBe(1)
    // Between them is floor, owned by nobody -- which is what lets hover report
    // "nothing here" instead of guessing.
    expect(f.provenance[at(0, 0)]).toBe(-1)
    expect(f.provenance[at(0, 0.7)]).toBe(-1)
  })

  it('never writes outside the disc', () => {
    const f = build(place(LIBRARY.slice(0, 30).map((p, k) => ans(p.id, 5, 3, k))))
    for (let i = 0; i < GRID.count; i++) {
      if (GRID.mask[i]) continue
      expect(f.rho0[i]!, `elem ${i}`).toBe(0)
      expect(f.rhoRaw[i]!).toBe(0)
      expect(f.provenance[i]!).toBe(-1)
    }
  })

  it('skips Dormant answers entirely', () => {
    const f = build([tile({ amplitude: 0, sigma: 0.2 })], { ...OPTS, volumeFraction: 0.35 })
    for (const i of GRID.designList) expect(f.provenance[i]!).toBe(-1)
  })
})

describe('tiles are discrete', () => {
  it('gives every real profile disjoint tile footprints', () => {
    // The property the whole visual model rests on: one question, one identifiable tile.
    for (const count of [8, 24, 50, LIBRARY.length]) {
      const tiles = place(
        LIBRARY.slice(0, count).map((p, k) => ans(p.id, (k % 7) as LeanIndex, 2, k)),
      )
      const f = build(tiles)
      const owners = new Set<number>()
      for (const i of GRID.designList) {
        const owner = f.provenance[i]!
        if (owner >= 0) owners.add(owner)
      }
      // Every non-Dormant tile got at least one cell, and no cell has two owners --
      // guaranteed by construction since provenance holds a single index per cell.
      expect(owners.size, `${count} answers -> ${owners.size} tiles rendered`).toBe(tiles.length)
    }
  })

  it('separates tiles by gutter cells held at the floor', () => {
    const tiles = place(LIBRARY.slice(0, 30).map((p, k) => ans(p.id, 4, 2, k)))
    const f = build(tiles)
    const { RHO_FLOOR } = FIELD_CONSTANTS
    // The gutter sits exactly at the default solidLo, so smoothstep maps it to zero
    // coverage: tiles read as discrete with no border drawing at all.
    expect(RHO_FLOOR).toBe(0.25)
    let gutters = 0
    for (const i of GRID.designList) {
      if (f.provenance[i]! < 0) {
        expect(f.rho0[i]!).toBe(RHO_FLOOR)
        gutters++
      }
    }
    expect(gutters, 'some gutter exists between tiles').toBeGreaterThan(0)
  })

  /**
   * The connectivity guarantee, and it matters far more with tiles than with blobs: at
   * the density minimum every tile would be its own island under 4-connectivity, the
   * connectivity pass would constrain nearly every DOF, and the solve would return no
   * signal at all.
   */
  it('keeps every in-disc cell above the solid threshold at iteration 1', () => {
    for (const count of [1, 12, 40, LIBRARY.length]) {
      const f = build(place(LIBRARY.slice(0, count).map((p, k) => ans(p.id, 5, 2, k))))
      for (const i of GRID.designList) {
        // 0.12 is the connectivity pass's solid-entry threshold.
        expect(f.rho0[i]!, `${count} answers, elem ${i}`).toBeGreaterThan(0.12)
      }
    }
  })
})

describe('concordance -> stiffness', () => {
  it('gives the interior of a single tile maximum coherence', () => {
    const f = build([tile({ hue: [0, 0, 1], sigma: 0.25 })], { ...OPTS, volumeFraction: 0.35 })
    const i = at(0, 0)
    expect(f.coherence[i]!).toBeGreaterThan(0.95)
    expect(f.w[i]!).toBeGreaterThan(0.9)
  })

  /**
   * The seam between unlike tiles is a sharp discordance, which is the behaviour the
   * artwork wants: Proposition 1 says discordant identities erode. With Gaussian blobs
   * the seam was smeared; with tiles it is exact.
   */
  it('drops stiffness at a seam between unlike tiles', () => {
    const f = build(
      [
        tile({ hue: [1, 0, 0], sigma: 0.09, x: -0.1, y: 0 }),
        tile({ hue: [0, 1, 0], sigma: 0.09, x: 0.1, y: 0, tileCol: 1 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    expect(f.w[at(0, 0)]!, 'seam is weaker than tile interior').toBeLessThan(f.w[at(-0.1, 0)]!)
  })

  it('holds an empty region at neutral rather than actively hostile', () => {
    const f = build([tile({ sigma: 0.06, x: -0.6, y: 0 })], { ...OPTS, volumeFraction: 0.35 })
    expect(f.coherence[at(0.6, 0)]!).toBeCloseTo(FIELD_CONSTANTS.S_NEUTRAL, 3)
  })

  /** SPD guarantee: w is a strictly positive scalar multiplier everywhere in the disc. */
  it('keeps w inside [W_MIN, 1] for every in-disc element of a real profile', () => {
    const f = build(place(LIBRARY.map((p, k) => ans(p.id, (k % 7) as LeanIndex, 2, k))))
    for (const i of GRID.designList) {
      expect(f.w[i]!, `elem ${i}`).toBeGreaterThanOrEqual(FIELD_CONSTANTS.W_MIN - 1e-9)
      expect(f.w[i]!, `elem ${i}`).toBeLessThanOrEqual(1 + 1e-9)
      expect(Number.isFinite(f.w[i]!)).toBe(true)
    }
  })
})

describe('volume fraction', () => {
  it('derives from mean strength within the feasible clamp', () => {
    expect(deriveVolumeFraction([])).toBe(0.2)
    const allCore = place(LIBRARY.slice(0, 10).map((p, k) => ans(p.id, 6, 3, k)))
    const allMinor = place(LIBRARY.slice(0, 10).map((p, k) => ans(p.id, 6, 1, k)))
    expect(deriveVolumeFraction(allCore)).toBeGreaterThan(deriveVolumeFraction(allMinor))
    for (const t of [allCore, allMinor]) {
      expect(deriveVolumeFraction(t)).toBeGreaterThanOrEqual(0.2)
      expect(deriveVolumeFraction(t)).toBeLessThanOrEqual(0.42)
    }
    // The whole derived range must sit where structure is actually visible: above ~0.45
    // the optimum is consolidated blobs, because nothing has to be spanned.
    expect(deriveVolumeFraction(allCore)).toBeLessThan(0.43)
  })

  /**
   * The seed deliberately starts ABOVE the target and lets the optimizer walk it down.
   * Rescaling it could only crush the gutters below the solid threshold (fragmenting
   * every tile into an island) or dim the tiles (discarding the saturation encoding).
   */
  it('reports the target while starting the field above it', () => {
    const tiles = place(LIBRARY.slice(0, 24).map((p, k) => ans(p.id, 5, 3, k)))
    const f = build(tiles, { ...OPTS, volumeFraction: 0.3 })
    expect(f.volumeFraction).toBe(0.3)
    let sum = 0
    for (const i of GRID.designList) sum += f.rho0[i]!
    expect(sum / GRID.designList.length).toBeGreaterThan(0.3)
  })
})

describe('determinism and robustness', () => {
  it('produces byte-identical fields for identical input', () => {
    const tiles = place(LIBRARY.slice(0, 25).map((p, k) => ans(p.id, (k % 7) as LeanIndex, 2, k)))
    const a = build(tiles)
    const b = build(tiles)
    for (const key of ['V', 'kappa', 'hue', 'rhoRaw', 'rho0', 'coherence', 'w'] as const) {
      expect(Array.from(a[key]), key).toEqual(Array.from(b[key]))
    }
    expect(Array.from(a.provenance)).toEqual(Array.from(b.provenance))
  })

  it('is safe to rebuild into the same buffers without stale residue', () => {
    const f = createFields(GRID)
    buildFields(f, place(LIBRARY.map((p, k) => ans(p.id, 5, 3, k))), OPTS)
    buildFields(f, [], { ...OPTS, volumeFraction: 0.3 })
    for (const i of GRID.designList) {
      expect(f.kappa[i]!).toBe(0)
      expect(f.provenance[i]!).toBe(-1)
      expect(f.rhoRaw[i]!).toBe(0)
      // Only the connectivity floor is left, so the disc is still one component.
      expect(f.rho0[i]!).toBe(FIELD_CONSTANTS.RHO_FLOOR)
    }
  })

  it('handles an empty profile without NaN', () => {
    const f = build([], { ...OPTS, volumeFraction: 0.2 })
    for (const i of GRID.designList) {
      expect(Number.isFinite(f.rho0[i]!)).toBe(true)
      expect(Number.isFinite(f.w[i]!)).toBe(true)
    }
    expect(f.supportFraction).toBe(0)
  })

  it('produces no NaN for the full library at every strength', () => {
    for (const s of [1, 2, 3] as StrengthLevel[]) {
      const f = build(place(LIBRARY.map((p, k) => ans(p.id, (k % 7) as LeanIndex, s, k))))
      for (const i of GRID.designList) {
        expect(Number.isFinite(f.rho0[i]!), `rho0 ${i}`).toBe(true)
        expect(Number.isFinite(f.w[i]!), `w ${i}`).toBe(true)
        expect(Number.isFinite(f.kappa[i]!), `kappa ${i}`).toBe(true)
        for (let c = 0; c < 3; c++) {
          expect(Number.isFinite(f.hue[3 * i + c]!), `hue ${i}.${c}`).toBe(true)
        }
      }
    }
  })

  it('keeps hue on the simplex wherever there is conviction', () => {
    const f = build(place(LIBRARY.slice(0, 30).map((p, k) => ans(p.id, 2, 3, k))))
    for (const i of GRID.designList) {
      if (f.kappa[i]! <= 1e-6) continue
      const s = f.hue[3 * i]! + f.hue[3 * i + 1]! + f.hue[3 * i + 2]!
      expect(s, `elem ${i}`).toBeCloseTo(1, 4)
    }
  })

  it('reports coverage rising with profile size', () => {
    const few = build(place(LIBRARY.slice(0, 3).map((p, k) => ans(p.id, 5, 2, k))))
    const many = build(place(LIBRARY.map((p, k) => ans(p.id, 5, 2, k))))
    expect(few.supportFraction).toBeGreaterThan(0)
    expect(many.supportFraction).toBeGreaterThan(few.supportFraction)
    expect(many.supportFraction).toBeLessThanOrEqual(1)
  })
})

/**
 * Destructive interference: two identities the library declares to be in tension make
 * each other structurally weaker, so the optimizer removes material from BOTH.
 *
 * Asserted on the stiffness field rather than on the deposit, because that is where it
 * happens -- the seed deliberately keeps recording the conviction that was answered, and
 * only the ABILITY of that material to carry load is reduced. That distinction is what
 * makes the erosion conditional: weakened material still on the only path to an anchor
 * survives, because removing it costs more compliance than it saves.
 */
describe('destructive interference', () => {
  // A-EMP-02 poleA against A-PRO-01 poleA, weight 0.30. Both engagement poles are the
  // "A" side here (aPole -1, bPole -1), unlike a mixed-sign antagonism -- this pairing
  // survived the distillation to 30 pairs and exercises that case too.
  const conflict = ANTAGONISMS.find((a) => a.a === 'A-EMP-02' && a.b === 'A-PRO-01')!

  /** Mean stiffness over the cells a given answer owns. */
  function ownStiffness(f: MosaicFields, tiles: PlacedTile[], pairId: string): number {
    const idx = tiles.findIndex((t) => t.pairId === pairId)
    let sum = 0
    let n = 0
    for (const i of GRID.designList) {
      if (f.provenance[i] === idx) {
        sum += f.w[i]!
        n++
      }
    }
    expect(n, `${pairId} owns no cells`).toBeGreaterThan(0)
    return sum / n
  }

  function run(empLean: LeanIndex, proLean: LeanIndex, withAntagonisms: boolean): {
    f: MosaicFields
    tiles: PlacedTile[]
  } {
    const answers = [ans('A-EMP-02', empLean, 3, 0), ans('A-PRO-01', proLean, 3, 1)]
    const tiles = place(answers)
    const f = createFields(GRID)
    buildFields(f, tiles, {
      ...OPTS,
      volumeFraction: 0.3,
      ...(withAntagonisms ? { antagonisms: ANTAGONISMS } : {}),
    })
    return { f, tiles }
  }

  it('is declared by the library for this pairing', () => {
    expect(conflict).toBeDefined()
    expect(conflict.aPole).toBe(-1)
    expect(conflict.bPole).toBe(-1)
  })

  it('weakens BOTH sides when both tense poles are chosen', () => {
    // leanIndex 0 is poleA (lean -1) for both pairs; both aPole and bPole are -1 here,
    // so engagement needs BOTH answers leaning toward their own poleA.
    const off = run(0, 0, false)
    const on = run(0, 0, true)
    for (const id of ['A-EMP-02', 'A-PRO-01']) {
      const before = ownStiffness(off.f, off.tiles, id)
      const after = ownStiffness(on.f, on.tiles, id)
      expect(after, `${id}: ${before.toFixed(3)} -> ${after.toFixed(3)}`).toBeLessThan(before)
    }
  })

  /** Holding the compatible pole of a contested pair is not a conflict. */
  it('does nothing when either side leans the other way', () => {
    const engaged = run(0, 0, true)
    const notEngaged = run(6, 0, true)
    const baseline = run(6, 0, false)
    expect(ownStiffness(notEngaged.f, notEngaged.tiles, 'A-PRO-01')).toBeCloseTo(
      ownStiffness(baseline.f, baseline.tiles, 'A-PRO-01'),
      6,
    )
    // ...and the engaged case really is different, so the comparison above means something.
    expect(ownStiffness(engaged.f, engaged.tiles, 'A-PRO-01')).toBeLessThan(
      ownStiffness(baseline.f, baseline.tiles, 'A-PRO-01'),
    )
  })

  it('scales with how far each side leans', () => {
    const hard = run(0, 0, true)
    const slight = run(2, 2, true)
    expect(ownStiffness(hard.f, hard.tiles, 'A-PRO-01')).toBeLessThan(
      ownStiffness(slight.f, slight.tiles, 'A-PRO-01'),
    )
  })

  /** SPD guarantee: the penalty must never drive stiffness to or below zero. */
  it('never takes stiffness to zero, however many conflicts engage', () => {
    const answers = LIBRARY.map((p, k) => ans(p.id, 0, 3, k))
    const tiles = place(answers)
    const f = createFields(GRID)
    buildFields(f, tiles, { ...OPTS, antagonisms: ANTAGONISMS })
    for (const i of GRID.designList) {
      expect(f.w[i]!, `elem ${i}`).toBeGreaterThanOrEqual(FIELD_CONSTANTS.W_MIN - 1e-9)
      expect(Number.isFinite(f.w[i]!)).toBe(true)
    }
  })

  it('leaves the deposit itself untouched -- conviction is still what was answered', () => {
    const off = run(0, 0, false)
    const on = run(0, 0, true)
    expect(Array.from(on.f.kappa)).toEqual(Array.from(off.f.kappa))
    expect(Array.from(on.f.hue)).toEqual(Array.from(off.f.hue))
    expect(Array.from(on.f.rho0)).toEqual(Array.from(off.f.rho0))
  })
})
