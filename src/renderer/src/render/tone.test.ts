import { describe, it, expect } from 'vitest'
import {
  PAPER_INK_SCALE,
  THEMES,
  convictionToSaturation,
  hueToLinear,
  linearToSrgb8,
  smoothstep,
  srgbHexToLinear,
} from './tone'
import type { Lin3, ThemeColors } from './tone'

/**
 * Every claim behind the paper theme is a numeric one, so it is checkable without an eye.
 * The most valuable assertion in this file is that the two palettes agree on the taxonomy
 * to within a few degrees of hue -- that is exactly "the load-bearing colour mapping
 * survived the palette change", and it fails loudly if anyone edits one palette alone.
 */

function toSrgb(c: Lin3): [number, number, number] {
  return [linearToSrgb8(c[0]), linearToSrgb8(c[1]), linearToSrgb8(c[2])]
}

/** Hue angle in degrees and HSL saturation, from an sRGB byte triple. */
function hsl(rgb: [number, number, number]): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map((v) => v / 255) as [number, number, number]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 1e-9) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = 60 * (((g - b) / d) % 6)
  else if (max === g) h = 60 * ((b - r) / d + 2)
  else h = 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s, l }
}

/** Relative luminance from a linear-light triple. */
function lum(c: Lin3): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** CIE L* from relative luminance. */
function lstar(y: number): number {
  return y <= 216 / 24389 ? y * (24389 / 27) : 116 * Math.cbrt(y) - 16
}

function mixLinear(cats: readonly Lin3[], w: readonly number[]): Lin3 {
  return [
    w[0]! * cats[0]![0] + w[1]! * cats[1]![0] + w[2]! * cats[2]![0],
    w[0]! * cats[0]![1] + w[1]! * cats[1]![1] + w[2]! * cats[2]![1],
    w[0]! * cats[0]![2] + w[1]! * cats[1]![2] + w[2]! * cats[2]![2],
  ]
}

const THIRD = 1 / 3
/** The seven taxonomy readings, as weights on the L1-normalized simplex. */
const READINGS: [string, [number, number, number]][] = [
  ['Demographic', [1, 0, 0]],
  ['Geographic', [0, 1, 0]],
  ['Associative', [0, 0, 1]],
  ['Regional Heritage (D+G)', [0.5, 0.5, 0]],
  ['Localized Communities (G+A)', [0, 0.5, 0.5]],
  ['Affinity Groups (D+A)', [0.5, 0, 0.5]],
  ['Concordant Core (all)', [THIRD, THIRD, THIRD]],
]

const themes: [string, ThemeColors][] = [
  ['ink', THEMES.ink],
  ['paper', THEMES.paper],
]

describe('hueToLinear separates identity from coverage', () => {
  /**
   * Zero saturation is the NEUTRAL structural ink, not the background.
   *
   * The bug this replaced conflated the two axes: it faded identity toward the
   * background, so material the optimizer built through regions no answer deposited into
   * became invisible -- and on paper that same material came out as one large pale slab
   * dominating the composition. Coverage is what fades to the background, and the caller
   * applies it.
   */
  it('returns the neutral structural ink at zero saturation', () => {
    const out: [number, number, number] = [0, 0, 0]
    for (const [name, theme] of themes) {
      for (const [, w] of READINGS) {
        hueToLinear(w[0], w[1], w[2], 0, theme, out)
        for (let k = 0; k < 3; k++) {
          expect(out[k], `${name} channel ${k}`).toBeCloseTo(theme.neutralLinear[k]!, 12)
        }
      }
    }
  })

  /** Unclaimed structure has to be visible; that is the whole point of the neutral. */
  it('keeps the neutral clearly distinct from the background on both themes', () => {
    for (const [name, theme] of themes) {
      const bgL = lstar(lum(theme.bgLinear))
      const nL = lstar(lum(theme.neutralLinear))
      expect(Math.abs(nL - bgL), `${name}: neutral L* ${nL.toFixed(1)} vs bg ${bgL.toFixed(1)}`)
        .toBeGreaterThan(20)
    }
  })

  /** ...and it must read as neutral, not as a fourth category. */
  it('keeps the neutral achromatic', () => {
    for (const [name, theme] of themes) {
      const c = hsl(toSrgb(theme.neutralLinear))
      expect(c.s, `${name} neutral saturation ${c.s.toFixed(3)}`).toBeLessThan(0.12)
    }
  })

  it('returns the category ink at full saturation', () => {
    const out: [number, number, number] = [0, 0, 0]
    for (const [name, theme] of themes) {
      for (let k = 0; k < 3; k++) {
        const w = [0, 0, 0]
        w[k] = 1
        hueToLinear(w[0]!, w[1]!, w[2]!, 1, theme, out)
        for (let c = 0; c < 3; c++) {
          expect(out[c], `${name} cat ${k} channel ${c}`).toBeCloseTo(theme.catLinear[k]![c]!, 10)
        }
      }
    }
  })

  /**
   * COVERAGE is the axis that fades toward the background, and the caller applies it.
   * Restated here as the composite the renderer performs, because that is what the
   * property "more material reads brighter on dark, darker on light" actually rests on.
   */
  it('composites monotone brighter on ink and monotone darker on paper', () => {
    const out: [number, number, number] = [0, 0, 0]
    for (const [name, theme] of themes) {
      for (const [label, w] of READINGS) {
        hueToLinear(w[0], w[1], w[2], 1, theme, out)
        let prev = lum(theme.bgLinear)
        for (const a of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
          const composited: Lin3 = [
            theme.bgLinear[0] + a * (out[0] - theme.bgLinear[0]),
            theme.bgLinear[1] + a * (out[1] - theme.bgLinear[1]),
            theme.bgLinear[2] + a * (out[2] - theme.bgLinear[2]),
          ]
          const y = lum(composited)
          if (name === 'ink') expect(y, `${label} @${a}`).toBeGreaterThanOrEqual(prev - 1e-9)
          else expect(y, `${label} @${a}`).toBeLessThanOrEqual(prev + 1e-9)
          prev = y
        }
      }
    }
  })

  /** The ink look at full conviction must not regress; that is the common case. */
  it('matches the legacy formula on ink at full saturation', () => {
    const theme = THEMES.ink
    const out: [number, number, number] = [0, 0, 0]
    for (const [label, w] of READINGS) {
      hueToLinear(w[0], w[1], w[2], 1, theme, out)
      const legacy = mixLinear(theme.catLinear, w)
      const a = toSrgb(out)
      const b = toSrgb(legacy)
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(a[k]! - b[k]!), `${label} ch${k}`).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('the paper palette preserves the taxonomy', () => {
  it('is the ink palette scaled uniformly in linear light', () => {
    for (let k = 0; k < 3; k++) {
      for (let c = 0; c < 3; c++) {
        expect(THEMES.paper.catLinear[k]![c]!, `cat ${k} ch ${c}`).toBeCloseTo(
          THEMES.ink.catLinear[k]![c]! * PAPER_INK_SCALE,
          12,
        )
      }
    }
  })

  /**
   * THE assertion. A uniform linear scale commutes with the weighted average that makes
   * every blend and leaves the sRGB hue angle unchanged, so all seven readings must land
   * on the same hue in both palettes. If this fails, the two palettes disagree about what
   * a colour MEANS.
   */
  it('lands every one of the seven readings on the same hue in both palettes', () => {
    for (const [label, w] of READINGS) {
      const inkH = hsl(toSrgb(mixLinear(THEMES.ink.catLinear, w)))
      const paperH = hsl(toSrgb(mixLinear(THEMES.paper.catLinear, w)))
      // The achromatic core has no meaningful hue angle; check its saturation instead.
      if (inkH.s < 0.2) {
        expect(paperH.s, `${label} core saturation`).toBeLessThan(0.2)
        continue
      }
      let d = Math.abs(inkH.h - paperH.h)
      if (d > 180) d = 360 - d
      expect(d, `${label}: ink ${inkH.h.toFixed(1)} vs paper ${paperH.h.toFixed(1)}`).toBeLessThan(3)
    }
  })

  /**
   * The secondary readings must stay mutually distinguishable, which is what actually
   * carries the meaning. Bands are wide on purpose: D+G genuinely lands at amber (~32
   * degrees) rather than lemon yellow, and G+A at steel blue (~203) rather than cyan --
   * a documented consequence of choosing basis colours of comparable lightness. See
   * BLEND_MEANING.
   */
  it('keeps the three secondaries in distinct, saturated bands', () => {
    const bands: [string, [number, number, number], [number, number]][] = [
      ['D+G amber', [0.5, 0.5, 0], [15, 75]],
      ['G+A steel', [0, 0.5, 0.5], [180, 220]],
      ['D+A magenta', [0.5, 0, 0.5], [280, 320]],
    ]
    for (const [name, theme] of themes) {
      for (const [label, w, [lo, hi]] of bands) {
        const c = hsl(toSrgb(mixLinear(theme.catLinear, w)))
        expect(c.h, `${name} ${label} hue ${c.h.toFixed(1)}`).toBeGreaterThanOrEqual(lo)
        expect(c.h, `${name} ${label} hue ${c.h.toFixed(1)}`).toBeLessThanOrEqual(hi)
        expect(c.s, `${name} ${label} saturation`).toBeGreaterThan(0.25)
      }
    }
  })

  it('keeps the concordant core achromatic on both themes', () => {
    for (const [name, theme] of themes) {
      const c = hsl(toSrgb(mixLinear(theme.catLinear, [THIRD, THIRD, THIRD])))
      expect(c.s, `${name} core saturation ${c.s.toFixed(3)}`).toBeLessThan(0.18)
    }
  })

  /**
   * Every reading has to stand off its own ground. On paper the core becomes a dark
   * graphite-plum rather than white -- correct, because the core's meaning was always
   * "achromatic relative to the ground", not literally white.
   */
  it('separates every reading from its background by a wide lightness margin', () => {
    for (const [name, theme] of themes) {
      const bgL = lstar(lum(theme.bgLinear))
      for (const [label, w] of READINGS) {
        const l = lstar(lum(mixLinear(theme.catLinear, w)))
        expect(Math.abs(l - bgL), `${name} ${label}: L* ${l.toFixed(1)} vs bg ${bgL.toFixed(1)}`)
          .toBeGreaterThan(25)
      }
    }
  })

  it('keeps the three primaries within a modest luminance spread', () => {
    // The whole reason for not using the raw sRGB primaries: green would read six times
    // brighter than blue and the mosaic would look like a bug report.
    for (const [name, theme] of themes) {
      const ls = theme.catLinear.map((c) => lum(c))
      const spread = Math.max(...ls) / Math.min(...ls)
      expect(spread, `${name} luminance spread ${spread.toFixed(2)}`).toBeLessThan(2)
    }
  })
})

describe('theme tokens agree with the stylesheet', () => {
  /**
   * The canvas pane is painted from tone.ts and butts directly against chrome painted
   * from theme.css. A mismatch shows up as a seam down the middle of the window.
   */
  it('derives bgLinear from bgHex', () => {
    for (const [name, theme] of themes) {
      const fromHex = srgbHexToLinear(theme.bgHex)
      for (let k = 0; k < 3; k++) {
        expect(theme.bgLinear[k]!, `${name} ch ${k}`).toBeCloseTo(fromHex[k]!, 12)
      }
    }
  })

  it('uses the documented background hexes', () => {
    expect(THEMES.ink.bgHex).toBe('#101014')
    expect(THEMES.paper.bgHex).toBe('#f4f1ea')
  })

  it('gives paper stronger guide alphas than ink at every site', () => {
    // L* is a cube-root curve, so the same alpha is a much smaller perceptual step on
    // cream than on near-black; without a boost every scaffolding mark is invisible.
    // 'label' and 'legend' are gone: both label groups now halo instead of tint, so
    // their contrast comes from the halo, not from a theme-tuned alpha.
    const keys = ['ring', 'rim', 'divider', 'arc'] as const
    for (const k of keys) {
      expect(THEMES.paper.guide[k], k).toBeGreaterThan(THEMES.ink.guide[k])
      expect(THEMES.paper.guide[k], k).toBeLessThanOrEqual(1)
    }
  })
})

describe('convictionToSaturation', () => {
  /**
   * With one uniform tile per question, conviction has to be carried by colour intensity
   * rather than area. The old kappa/(kappa+1) curve squashed the three strength levels
   * into 0.25-0.50 -- visually identical, which defeats the encoding.
   */
  it('spreads the three strength levels across a legible range', () => {
    const minor = convictionToSaturation(0.33)
    const notable = convictionToSaturation(0.66)
    const core = convictionToSaturation(1)
    expect(minor).toBeLessThan(notable)
    expect(notable).toBeLessThan(core)
    expect(core).toBeCloseTo(1, 6)
    // Each step must be a real perceptual gap, not a rounding difference.
    expect(notable - minor).toBeGreaterThan(0.15)
    expect(core - notable).toBeGreaterThan(0.15)
  })

  it('is zero for nothing and clamped to one', () => {
    expect(convictionToSaturation(0)).toBe(0)
    expect(convictionToSaturation(-1)).toBe(0)
    expect(convictionToSaturation(5)).toBe(1)
  })

  it('is monotone', () => {
    let prev = -1
    for (let k = 0; k <= 1.0001; k += 0.05) {
      const v = convictionToSaturation(k)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('smoothstep', () => {
  it('is clamped, monotone and symmetric about the midpoint', () => {
    expect(smoothstep(0.25, 0.6, 0)).toBe(0)
    expect(smoothstep(0.25, 0.6, 1)).toBe(1)
    expect(smoothstep(0.25, 0.6, 0.425)).toBeCloseTo(0.5, 10)
    let prev = -1
    for (let x = 0; x <= 1.0001; x += 0.02) {
      const v = smoothstep(0.25, 0.6, x)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('degenerates to a hard threshold rather than dividing by zero', () => {
    expect(smoothstep(0.5, 0.5, 0.4)).toBe(0)
    expect(smoothstep(0.5, 0.5, 0.5)).toBe(1)
  })
})
