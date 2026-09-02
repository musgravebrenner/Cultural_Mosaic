import { describe, it, expect } from 'vitest'
import {
  createGrid,
  createFields,
  buildFields,
  deriveVolumeFraction,
  FIELD_CONSTANTS,
} from './fields'
import type { FieldOptions, MosaicFields } from './fields'
import { DEFAULT_LAYOUT, placeAnswers } from './polar'
import { LIBRARY, LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex, PlacedTile, StrengthLevel, TileAnswer } from '../domain/types'

const N = 64
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
  return placeAnswers({
    answers,
    pairs: LIBRARY_BY_ID,
    layout: { ...DEFAULT_LAYOUT, gridSize: N },
  })
}

function build(tiles: PlacedTile[], opts: FieldOptions = OPTS): MosaicFields {
  const f = createFields(GRID)
  buildFields(f, tiles, opts)
  return f
}

/** A synthetic tile, so colour behaviour can be tested without library coupling. */
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
    sigma: 0.12,
    amplitude: 1,
    role: 'mass',
    ...over,
  }
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

  it('puts centroids inside their cells and the origin at the centre', () => {
    expect(GRID.h).toBeCloseTo(2 / N, 12)
    for (const i of GRID.designList) {
      expect(Math.abs(GRID.cx[i]!)).toBeLessThanOrEqual(1)
      expect(Math.abs(GRID.cy[i]!)).toBeLessThanOrEqual(1)
      expect(Math.hypot(GRID.cx[i]!, GRID.cy[i]!)).toBeLessThanOrEqual(DEFAULT_LAYOUT.rimRadius)
    }
  })
})

describe('deposit and colour', () => {
  /**
   * The union's calibration, and it is deliberate: a single full-strength deposit
   * reaches 0.6 rather than 1.0, so genuine overlap still has room to read as denser.
   * A form that saturated a lone deposit at its own centre would make every dense
   * region indistinguishable.
   */
  it('puts a single full-strength deposit at ~0.6, leaving overlap headroom', () => {
    const f = build([tile({ sigma: 0.2, amplitude: 1 })], { ...OPTS, volumeFraction: 0.35 })
    // Centre of the domain; the nearest cell centroid is half a cell away.
    const i = (N / 2) * N + N / 2
    expect(f.kappa[i]!).toBeGreaterThan(0.9)
    expect(f.rhoRaw[i]!).toBeCloseTo(0.6, 2)

    // ...and overlap genuinely exceeds it rather than clipping.
    const pair = build(
      [tile({ sigma: 0.2, amplitude: 1 }), tile({ sigma: 0.2, amplitude: 1 })],
      { ...OPTS, volumeFraction: 0.35 },
    )
    expect(pair.rhoRaw[i]!).toBeGreaterThan(0.8)
    expect(pair.rhoRaw[i]!).toBeLessThan(1)
  })

  it('is exactly zero beyond the kernel cutoff', () => {
    const f = build([tile({ sigma: 0.05, amplitude: 1, x: 0, y: 0 })], {
      ...OPTS,
      volumeFraction: 0.35,
    })
    for (const i of GRID.designList) {
      const d = Math.hypot(GRID.cx[i]!, GRID.cy[i]!)
      if (d > FIELD_CONSTANTS.CUTOFF_SIGMAS * 0.05 + GRID.h) {
        expect(f.rhoRaw[i]!, `cell at d=${d.toFixed(3)}`).toBeLessThan(1e-9)
      }
    }
  })

  /**
   * The semantic bug this rule exists to prevent: if colour summed and clamped, three
   * overlapping pure-blue deposits would tone-map toward whitish and the app would
   * report "Concordant Core" -- all three dimensions align -- in a region that is in
   * fact maximally PURE single-category.
   */
  it('keeps stacked same-hue deposits pure instead of drifting toward white', () => {
    const stacked = build(
      [
        tile({ hue: [0, 0, 1], sigma: 0.2, x: 0, y: 0 }),
        tile({ hue: [0, 0, 1], sigma: 0.2, x: 0.02, y: 0 }),
        tile({ hue: [0, 0, 1], sigma: 0.2, x: 0, y: 0.02 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const i = (N / 2) * N + N / 2
    expect(stacked.hue[3 * i]!).toBeCloseTo(0, 6)
    expect(stacked.hue[3 * i + 1]!).toBeCloseTo(0, 6)
    expect(stacked.hue[3 * i + 2]!).toBeCloseTo(1, 6)
    // Conviction rose even though hue did not move -- intensity lives in kappa.
    expect(stacked.kappa[i]!).toBeGreaterThan(2)
  })

  it('only reaches white where all three categories are genuinely co-present', () => {
    const f = build(
      [
        tile({ hue: [1, 0, 0], sigma: 0.25, x: 0, y: 0 }),
        tile({ hue: [0, 1, 0], sigma: 0.25, x: 0, y: 0 }),
        tile({ hue: [0, 0, 1], sigma: 0.25, x: 0, y: 0 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const i = (N / 2) * N + N / 2
    expect(f.hue[3 * i]!).toBeCloseTo(1 / 3, 4)
    expect(f.hue[3 * i + 1]!).toBeCloseTo(1 / 3, 4)
    expect(f.hue[3 * i + 2]!).toBeCloseTo(1 / 3, 4)
  })

  /**
   * Density unions rather than averages: if ANY identity occupies a location there is
   * material there, and averaging would let an isolated strong deposit be thinned by
   * its own emptiness.
   */
  it('unions density so overlap is denser than either deposit alone', () => {
    const one = build([tile({ amplitude: 0.5, sigma: 0.2 })], { ...OPTS, volumeFraction: 0.35 })
    const i = (N / 2) * N + N / 2
    const single = one.rhoRaw[i]!
    const two = build(
      [tile({ amplitude: 0.5, sigma: 0.2 }), tile({ amplitude: 0.5, sigma: 0.2 })],
      { ...OPTS, volumeFraction: 0.35 },
    )
    expect(two.rhoRaw[i]!).toBeGreaterThan(single)
    // Bounded in [0,1) by construction -- no clamping needed, no plateau.
    expect(two.rhoRaw[i]!).toBeLessThan(1)
  })

  it('never produces a flat rho=1 plateau that would kill the SIMP gradient', () => {
    const many = Array.from({ length: 12 }, (_, k) =>
      tile({ amplitude: 1, sigma: 0.3, x: 0.01 * k, y: 0 }),
    )
    const f = build(many, { ...OPTS, volumeFraction: 0.35 })
    for (const i of GRID.designList) expect(f.rhoRaw[i]!).toBeLessThan(1)
  })

  it('records provenance for the dominant contributor', () => {
    const f = build(
      [
        tile({ hue: [1, 0, 0], sigma: 0.15, x: -0.4, y: 0, amplitude: 1 }),
        tile({ hue: [0, 0, 1], sigma: 0.15, x: 0.4, y: 0, amplitude: 1 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const at = (x: number, y: number): number => {
      const ex = Math.floor((x + 1) / GRID.h)
      const ey = Math.floor((y + 1) / GRID.h)
      return ey * N + ex
    }
    expect(f.provenance[at(-0.4, 0)]).toBe(0)
    expect(f.provenance[at(0.4, 0)]).toBe(1)
    // Empty cells stay at -1 so the hover handler can report "nothing here".
    expect(f.provenance[at(0, 0.85)]).toBe(-1)
  })
})

describe('concordance -> stiffness', () => {
  it('gives a monochrome region coherence 1 and near-maximum stiffness', () => {
    const f = build(
      [
        tile({ hue: [0, 0, 1], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
        tile({ hue: [0, 0, 1], sigma: 0.3, x: 0.05, y: 0.05, amplitude: 1 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const i = (N / 2) * N + N / 2
    expect(f.coherence[i]!).toBeGreaterThan(0.97)
    expect(f.w[i]!).toBeGreaterThan(0.92)
  })

  it('drives a three-way contested region toward the low-stiffness floor', () => {
    // Equal three-way overlap gives ||(1,1,1)||/3 = 0.577 coherence.
    const f = build(
      [
        tile({ hue: [1, 0, 0], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
        tile({ hue: [0, 1, 0], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
        tile({ hue: [0, 0, 1], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const i = (N / 2) * N + N / 2
    expect(f.coherence[i]!).toBeCloseTo(0.577, 2)
    expect(f.w[i]!).toBeLessThan(0.5)
    expect(f.w[i]!).toBeGreaterThan(FIELD_CONSTANTS.W_MIN)
  })

  it('gives a two-way seam coherence about 0.707', () => {
    const f = build(
      [
        tile({ hue: [1, 0, 0], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
        tile({ hue: [0, 1, 0], sigma: 0.3, x: 0, y: 0, amplitude: 1 }),
      ],
      { ...OPTS, volumeFraction: 0.35 },
    )
    const i = (N / 2) * N + N / 2
    expect(f.coherence[i]!).toBeCloseTo(0.707, 2)
  })

  /**
   * The failure the conviction gate exists to fix. Bare spherical coherence rates two
   * near-empty but aligned cells as PERFECTLY concordant, which inverts the paper's
   * claim that unlinked identities are discordant rather than concordant.
   */
  it('holds a weak but aligned region at neutral, not at maximum stiffness', () => {
    const strong = build([tile({ hue: [0, 0, 1], sigma: 0.3, amplitude: 1 })], {
      ...OPTS,
      volumeFraction: 0.35,
    })
    const weak = build([tile({ hue: [0, 0, 1], sigma: 0.3, amplitude: 0.02 })], {
      ...OPTS,
      volumeFraction: 0.35,
    })
    const i = (N / 2) * N + N / 2
    // Both are perfectly aligned -- identical hue everywhere -- so ungated coherence
    // would be 1.0 for both.
    expect(strong.coherence[i]!).toBeGreaterThan(0.97)
    expect(weak.coherence[i]!).toBeLessThan(0.8)
    expect(weak.coherence[i]!).toBeGreaterThan(0.55)
    expect(weak.w[i]!).toBeLessThan(strong.w[i]!)
  })

  it('leaves an empty neighbourhood neutral rather than actively hostile', () => {
    const f = build([tile({ sigma: 0.05, x: -0.6, y: 0 })], { ...OPTS, volumeFraction: 0.35 })
    const far = Math.floor((0.6 + 1) / GRID.h) + Math.floor((0 + 1) / GRID.h) * N
    expect(f.coherence[far]!).toBeCloseTo(FIELD_CONSTANTS.S_NEUTRAL, 3)
  })

  /** SPD guarantee: w is a strictly positive scalar multiplier everywhere in the disc. */
  it('keeps w strictly inside [W_MIN, 1] for every in-disc element of a real profile', () => {
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
      expect(deriveVolumeFraction(t)).toBeLessThanOrEqual(0.55)
    }
  })

  it('hits the requested volume fraction to within a fraction of a percent', () => {
    for (const target of [0.2, 0.3, 0.35, 0.45, 0.55]) {
      const f = build(place(LIBRARY.slice(0, 18).map((p, k) => ans(p.id, 5, 2, k))), {
        ...OPTS,
        volumeFraction: target,
      })
      let sum = 0
      for (const i of GRID.designList) sum += f.rho0[i]!
      expect(sum / GRID.designList.length, `target ${target}`).toBeCloseTo(target, 3)
      expect(f.sparse).toBe(false)
    }
  })

  /**
   * The connectivity guarantee. At iteration 1 the whole disc must be one connected
   * component containing every pin and load, so that no user profile can hand the
   * optimizer a disconnected starting point.
   */
  it('leaves every in-disc element strictly positive, even for a 1-answer profile', () => {
    const f = build(place([ans('A-AVO-04', 6, 1)]), { ...OPTS, volumeFraction: 0.3 })
    for (const i of GRID.designList) {
      expect(f.rho0[i]!, `elem ${i}`).toBeGreaterThan(0)
      expect(f.rho0[i]!).toBeGreaterThanOrEqual(FIELD_CONSTANTS.RHO_MIN)
    }
  })

  it('keeps rho0 exactly zero outside the disc', () => {
    const f = build(place(LIBRARY.slice(0, 12).map((p, k) => ans(p.id, 5, 2, k))))
    for (let i = 0; i < GRID.count; i++) {
      if (!GRID.mask[i]) expect(f.rho0[i]!).toBe(0)
    }
  })

  it('preserves the ordering of the seed field after the gamma remap', () => {
    // Gamma changes contrast, not support -- so a denser seed cell stays denser.
    const f = build(place(LIBRARY.slice(0, 20).map((p, k) => ans(p.id, 4, 2, k))))
    const list = Array.from(GRID.designList)
    for (let k = 1; k < 400; k++) {
      const a = list[k]!
      const b = list[list.length - k]!
      if (f.rhoRaw[a]! > f.rhoRaw[b]! + 1e-6) {
        expect(f.rho0[a]!).toBeGreaterThanOrEqual(f.rho0[b]! - 1e-9)
      }
    }
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
    // An empty profile leaves only the connectivity floor, and no colour at all.
    for (const i of GRID.designList) {
      expect(f.kappa[i]!).toBe(0)
      expect(f.provenance[i]!).toBe(-1)
      expect(f.rhoRaw[i]!).toBeCloseTo(0, 9)
      expect(f.rho0[i]!).toBeGreaterThan(0)
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

  it('produces no NaN for the full 79-pair profile at every strength', () => {
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

  it('reports support fraction rising with profile size', () => {
    const few = build(place(LIBRARY.slice(0, 3).map((p, k) => ans(p.id, 5, 2, k))))
    const many = build(place(LIBRARY.map((p, k) => ans(p.id, 5, 2, k))))
    expect(few.supportFraction).toBeGreaterThan(0)
    expect(many.supportFraction).toBeGreaterThan(few.supportFraction)
    expect(many.supportFraction).toBeLessThanOrEqual(1)
  })
})
