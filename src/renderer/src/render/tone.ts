/**
 * Tone mapping for the mosaic.
 *
 * The single biggest "why does this look cheap" fix is compositing in LINEAR light.
 * Alpha-blending sRGB values directly makes every fading edge and every colour
 * transition go muddy and dark -- the classic dark-fringe artifact. Everything else in
 * the render pipeline is a refinement; this one is the difference between "rendered"
 * and "computed".
 */

/** sRGB byte -> linear float. 256 entries, built once. */
export const SRGB_TO_LINEAR = ((): Float32Array => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }
  return t
})()

const LIN_TABLE_SIZE = 4096

/** Linear float in [0,1] -> sRGB byte. 4096 entries, built once. */
export const LINEAR_TO_SRGB8 = ((): Uint8Array => {
  const t = new Uint8Array(LIN_TABLE_SIZE)
  for (let i = 0; i < LIN_TABLE_SIZE; i++) {
    const c = i / (LIN_TABLE_SIZE - 1)
    const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
    t[i] = Math.max(0, Math.min(255, Math.round(s * 255)))
  }
  return t
})()

export function linearToSrgb8(v: number): number {
  const i = v <= 0 ? 0 : v >= 1 ? LIN_TABLE_SIZE - 1 : (v * (LIN_TABLE_SIZE - 1)) | 0
  return LINEAR_TO_SRGB8[i]!
}

export function srgbHexToLinear(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return [SRGB_TO_LINEAR[r]!, SRGB_TO_LINEAR[g]!, SRGB_TO_LINEAR[b]!]
}

/**
 * Hermite smoothstep. Used on rho rather than a hard threshold (which aliases badly and
 * throws away SIMP's gradient information) and rather than raw `alpha = rho` (which
 * gives washed-out grey mush, because early SIMP iterations are almost entirely
 * intermediate density). The band gives a decisive solid/void read AND free
 * anti-aliasing, since the continuous field's gradient spans one or two cells at the
 * boundary.
 */
export function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x >= hi ? 1 : 0
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)))
  return t * t * (3 - 2 * t)
}

/**
 * Category basis colours in LINEAR light, keyed to the taxonomy: R = Demographic,
 * G = Geographic, B = Associative.
 *
 * Not the raw sRGB primaries. Pure #ff0000 / #00ff00 / #0000ff are wildly unequal in
 * perceived lightness (green reads roughly six times brighter than blue), so a mosaic
 * built from them looks like a bug report rather than a composition. These are tuned to
 * comparable luminance while staying unmistakably red / green / blue, so a two-way blend
 * reads as a genuine secondary colour rather than as whichever primary happened to be
 * brighter.
 */
export const CATEGORY_LINEAR: readonly [number, number, number][] = [
  srgbHexToLinear('#e5484d'), // Demographic
  srgbHexToLinear('#46a758'), // Geographic
  srgbHexToLinear('#5b6ee8'), // Associative
]

export interface ThemeColors {
  /** Background, in linear light. */
  readonly bgLinear: [number, number, number]
  readonly bgHex: string
  readonly inkHex: string
  readonly dimHex: string
}

export const THEMES: Readonly<Record<'paper' | 'ink', ThemeColors>> = {
  // Never pure white or pure black: that is the fastest way to make generative output
  // look like a screenshot of a debug view.
  paper: {
    bgLinear: srgbHexToLinear('#f4f1ea'),
    bgHex: '#f4f1ea',
    inkHex: '#1a1a1c',
    dimHex: '#6b6b70',
  },
  ink: {
    bgLinear: srgbHexToLinear('#101014'),
    bgHex: '#101014',
    inkHex: '#e8e8ea',
    dimHex: '#8b8b96',
  },
}

/**
 * Map a hue on the simplex plus a conviction value to a linear-light colour.
 *
 * Conviction is tone-mapped as kappa/(kappa+1) so a weak region is DARK BUT HUED rather
 * than grey. Grey reads as missing data; a dim version of its own colour reads as
 * negative space.
 */
export function hueToLinear(
  hr: number,
  hg: number,
  hb: number,
  kappa: number,
  out: [number, number, number],
): void {
  const value = kappa / (kappa + 1)
  const dr = CATEGORY_LINEAR[0]!
  const dg = CATEGORY_LINEAR[1]!
  const db = CATEGORY_LINEAR[2]!
  out[0] = value * (hr * dr[0] + hg * dg[0] + hb * db[0])
  out[1] = value * (hr * dr[1] + hg * dg[1] + hb * db[1])
  out[2] = value * (hr * dr[2] + hg * dg[2] + hb * db[2])
}
