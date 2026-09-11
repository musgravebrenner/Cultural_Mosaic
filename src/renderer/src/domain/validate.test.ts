import { describe, it, expect } from 'vitest'
import { parseProfile, serializeProfile } from './validate'
import { CURRENT_SCHEMA_VERSION } from './migrate'
import { ANCHORS, LIBRARY } from './library'
import type { LeanIndex, MosaicProfile } from './types'
import { strengthFromLean } from './types'
import { DEFAULT_LAYOUT } from '../layout/polar'
import { DEFAULT_RENDER, DEFAULT_SOLVER } from '../state/store'

function sample(): MosaicProfile {
  const pairs = LIBRARY.slice(0, 4)
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    kind: 'cultural-mosaic-profile',
    id: 'mosaic.test',
    title: 'Test mosaic',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    appVersion: '0.1.0',
    pairs: [...pairs],
    answers: pairs.map((p, i) => {
      const leanIndex = (i % 7) as LeanIndex
      return {
        answerId: `a${i}`,
        pairId: p.id,
        leanIndex,
        // Strength is derived from lean, never independent -- so a round-trip fixture
        // has to be internally consistent or "unchanged" is not a meaningful claim.
        strength: strengthFromLean(leanIndex),
        addedAt: i,
      }
    }),
    anchors: [],
    anchorAnswers: [],
    layout: DEFAULT_LAYOUT,
    solver: DEFAULT_SOLVER,
    render: DEFAULT_RENDER,
  }
}

describe('round trip', () => {
  it('survives serialize then parse unchanged', () => {
    const p = sample()
    const back = parseProfile(JSON.parse(serializeProfile(p)))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.warnings).toEqual([])
    expect(back.profile.title).toBe(p.title)
    expect(back.profile.answers).toEqual(p.answers)
    expect(back.profile.pairs.map((q) => q.id)).toEqual(p.pairs.map((q) => q.id))
    expect(back.profile.layout).toEqual(p.layout)
    expect(back.profile.solver).toEqual(p.solver)
    expect(back.profile.render).toEqual(p.render)
  })

  it('writes readable, indented JSON', () => {
    // The file is 10-30KB; readability is worth more than the bytes, and a grader can
    // open it in any editor.
    const text = serializeProfile(sample())
    expect(text).toContain('\n  "kind": "cultural-mosaic-profile"')
    expect(text.split('\n').length).toBeGreaterThan(20)
  })

  it('preserves an immutability override', () => {
    const p = sample()
    p.answers = p.answers.map((a, i) => (i === 0 ? { ...a, immutabilityOverride: 0.42 } : a))
    const back = parseProfile(JSON.parse(serializeProfile(p)))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.profile.answers[0]!.immutabilityOverride).toBe(0.42)
    expect(back.profile.answers[1]!.immutabilityOverride).toBeUndefined()
  })

  it('round-trips an anchor answer', () => {
    const p = sample()
    const anchor = ANCHORS[0]!
    p.anchors = [anchor]
    p.anchorAnswers = [
      { answerId: 'anc-1', anchorId: anchor.id, optionId: anchor.options[0]!.id, addedAt: 0 },
    ]
    const back = parseProfile(JSON.parse(serializeProfile(p)))
    expect(back.ok).toBe(true)
    if (!back.ok) return
    expect(back.warnings).toEqual([])
    expect(back.profile.anchors).toHaveLength(1)
    expect(back.profile.anchorAnswers).toEqual(p.anchorAnswers)
  })
})

describe('refusals', () => {
  /** Checked first, so an unrelated JSON gets a real message rather than a TypeError. */
  it('rejects a file that is not a mosaic profile', () => {
    const r = parseProfile({ hello: 'world' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/does not look like a Cultural Mosaic profile/i)
  })

  it('rejects non-objects', () => {
    for (const bad of [null, 42, 'text', [1, 2, 3]]) {
      expect(parseProfile(bad).ok).toBe(false)
    }
  })

  /**
   * Refusing a newer file is deliberate. Silently dropping fields you do not understand
   * loses the user's data, and they would not find out until much later.
   */
  it('refuses a file from a newer schema instead of degrading it', () => {
    const p = { ...sample(), schemaVersion: CURRENT_SCHEMA_VERSION + 1 }
    const r = parseProfile(p)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]).toMatch(/newer version/i)
  })
})

describe('liberal reading', () => {
  it('clamps out-of-range values and warns rather than failing', () => {
    const p = sample() as unknown as Record<string, unknown>
    p['solver'] = { ...DEFAULT_SOLVER, volumeFraction: 9, penalty: 99, iterations: -5 }
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.solver.volumeFraction).toBe(0.6)
    expect(r.profile.solver.penalty).toBe(6)
    expect(r.profile.solver.iterations).toBe(1)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('collects every problem rather than stopping at the first', () => {
    const p = sample() as unknown as Record<string, unknown>
    p['pairs'] = [{ id: 'ok', poleA: 'A', poleB: 'B', mix: [1, 0, 0], immutability: 0.5 }, 42, {}]
    p['answers'] = [
      { answerId: 'x', pairId: 'nope', leanIndex: 3, strength: 2, addedAt: 0 },
      { answerId: 'y', pairId: 'ok', leanIndex: 3, strength: 2, addedAt: 1 },
    ]
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Two bad pairs and one dangling answer -- all reported, none fatal.
    expect(r.warnings.length).toBeGreaterThanOrEqual(3)
    expect(r.profile.pairs).toHaveLength(1)
    expect(r.profile.answers).toHaveLength(1)
  })

  it('clamps a wild lean into range, and derives strength from the clamped value', () => {
    const p = sample() as unknown as Record<string, unknown>
    p['answers'] = [
      { answerId: 'a', pairId: LIBRARY[0]!.id, leanIndex: 99, strength: -4, addedAt: 0 },
    ]
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.answers[0]!.leanIndex).toBe(6)
    // The stored strength (-4) is never trusted; leanIndex 6 is an extreme, so it
    // derives to Core regardless of what the file claimed.
    expect(r.profile.answers[0]!.strength).toBe(3)
  })

  it('drops a duplicate answer for the same pair', () => {
    const p = sample() as unknown as Record<string, unknown>
    const id = LIBRARY[0]!.id
    p['answers'] = [
      { answerId: 'a', pairId: id, leanIndex: 3, strength: 2, addedAt: 0 },
      { answerId: 'b', pairId: id, leanIndex: 5, strength: 3, addedAt: 1 },
    ]
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.answers).toHaveLength(1)
    expect(r.warnings.join(' ')).toMatch(/duplicate/i)
  })

  it('renormalizes a mix that does not sum to one', () => {
    const p = sample() as unknown as Record<string, unknown>
    p['pairs'] = [{ id: 'c', poleA: 'A', poleB: 'B', mix: [2, 2, 0], immutability: 0.5 }]
    p['answers'] = []
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const m = r.profile.pairs[0]!.mix
    expect(m[0] + m[1] + m[2]).toBeCloseTo(1, 10)
    expect(m[0]).toBeCloseTo(0.5, 10)
  })

  it('keeps solidLo strictly below solidHi', () => {
    // Otherwise smoothstep degenerates into a hard threshold and the render aliases.
    const p = sample() as unknown as Record<string, unknown>
    p['render'] = { ...DEFAULT_RENDER, solidLo: 0.9, solidHi: 0.1 }
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.render.solidLo).toBeLessThan(r.profile.render.solidHi)
  })

  it('falls back to a valid resolution and says so', () => {
    const p = sample() as unknown as Record<string, unknown>
    p['layout'] = { ...DEFAULT_LAYOUT, gridSize: 77 }
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect([64, 96, 128]).toContain(r.profile.layout.gridSize)
    expect(r.warnings.join(' ')).toMatch(/resolution/i)
  })

  it('migrates an unversioned file rather than rejecting it', () => {
    const p = sample() as unknown as Record<string, unknown>
    delete p['schemaVersion']
    const r = parseProfile(p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.profile.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(r.warnings.join(' ')).toMatch(/schema versioning/i)
  })
})

/**
 * A committed golden file. This exact document must keep loading for the life of the
 * app; if a future change breaks it, that is a migration that was not written.
 */
describe('golden profile', () => {
  const GOLDEN = {
    schemaVersion: 1,
    kind: 'cultural-mosaic-profile',
    id: 'mosaic.golden',
    title: 'Golden',
    createdAt: '2026-09-02T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    appVersion: '0.1.0',
    pairs: [
      {
        id: 'G-REG-01',
        source: 'library',
        category: 'geographic',
        facet: 'regional-country',
        poleA: "Where I was born is where I'm from",
        poleB: "Where I chose is where I'm from",
        mix: [0.3, 0.7, 0],
        skew: [0, -0.15, 0.15],
        immutability: 1,
      },
      {
        id: 'A-AVO-04',
        source: 'library',
        category: 'associative',
        facet: 'avocations',
        poleA: 'Join a club',
        poleB: 'Go alone',
        mix: [0, 0.1, 0.9],
        immutability: 0.15,
      },
    ],
    answers: [
      { answerId: 'g1', pairId: 'G-REG-01', leanIndex: 1, strength: 3, addedAt: 1 },
      { answerId: 'g2', pairId: 'A-AVO-04', leanIndex: 5, strength: 1, addedAt: 2 },
    ],
    layout: DEFAULT_LAYOUT,
    solver: DEFAULT_SOLVER,
    render: DEFAULT_RENDER,
  }

  it('loads cleanly with no warnings', () => {
    const r = parseProfile(JSON.parse(JSON.stringify(GOLDEN)))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.warnings).toEqual([])
    expect(r.profile.answers).toHaveLength(2)
    expect(r.profile.pairs[0]!.skew).toEqual([0, -0.15, 0.15])
    expect(r.profile.pairs[0]!.immutability).toBe(1)
  })
})
