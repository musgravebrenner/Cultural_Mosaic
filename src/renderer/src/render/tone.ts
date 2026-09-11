/**
 * Tone mapping for the mosaic.
 *
 * The single biggest "why does this look cheap" fix is compositing in LINEAR light.
 * Alpha-blending sRGB values directly makes every fading edge and every colour
 * transition go muddy and dark -- the classic dark-fringe artifact.
 *
 * The second is the rule this module now enforces everywhere: **"less" means "closer to
 * the background", never "closer to black"**. Those are the same thing only when the
 * background IS black. Getting it wrong is what made the paper theme render faint
 * identities as dark smudges on cream.
 *
 * The third is that the two axes stay apart. COVERAGE decides whether material exists
 * and fades toward the background; SATURATION decides how much identity that material
 * carries and fades toward a neutral structural ink. Collapsing them makes the truss
 * connecting the tiles disappear, because the optimizer legitimately routes structure
 * through regions no answer ever deposited into.
 */

export type Lin3 = readonly [number, number, number]

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

export function srgbHexToLinear(hex: string): Lin3 {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return [SRGB_TO_LINEAR[r]!, SRGB_TO_LINEAR[g]!, SRGB_TO_LINEAR[b]!]
}

export function linearToSrgbHex(c: Lin3): string {
  const p = (v: number): string => linearToSrgb8(v).toString(16).padStart(2, '0')
  return `#${p(c[0])}${p(c[1])}${p(c[2])}`
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

// ---------------------------------------------------------------------------
// The category palette
// ---------------------------------------------------------------------------

/**
 * Category basis colours, keyed to the taxonomy: R = Demographic, G = Geographic,
 * B = Associative.
 *
 * Not the raw sRGB primaries. Pure #ff0000 / #00ff00 / #0000ff are wildly unequal in
 * perceived lightness (green reads roughly six times brighter than blue), so a mosaic
 * built from them looks like a bug report rather than a composition. These are tuned to
 * comparable luminance while staying unmistakably red / green / blue, so a two-way blend
 * reads as a genuine secondary colour rather than as whichever primary was brighter.
 */
const INK_CATEGORY = ['#e5484d', '#46a758', '#5b6ee8'] as const

/**
 * The paper inks are the ink inks scaled UNIFORMLY in linear light. Nothing else.
 *
 * That specific transform is chosen because it commutes with the weighted average that
 * produces every blend -- scaling each basis vector by s scales every mixture by s -- and
 * a uniform scale leaves the sRGB hue angle unchanged. So the paper palette reproduces
 * the ink palette's ENTIRE taxonomy reading: all three secondaries and the achromatic
 * core, to within rounding. That is exactly the property a palette change has to
 * preserve here, since the colour mapping is load-bearing meaning and not decoration.
 *
 * Meanwhile HSL saturation falls on its own as lightness drops (red 75% -> 54%, blue
 * 75% -> 45%), which is the "deep printing ink rather than screen colour" quality wanted
 * on paper -- with no separate desaturation step to go wrong.
 *
 * At 0.40 the resulting inks are #982d30 (madder), #2b6e38 (hunter), #3a479a
 * (ultramarine). `PAPER_INK_SCALE` is the single tuning dial; larger is lighter.
 * Asserted against the ink palette in tone.test.ts.
 */
export const PAPER_INK_SCALE = 0.4

function scaleLinear(c: Lin3, s: number): Lin3 {
  return [c[0] * s, c[1] * s, c[2] * s]
}

const INK_CATEGORY_LINEAR = INK_CATEGORY.map(srgbHexToLinear) as unknown as [Lin3, Lin3, Lin3]
const PAPER_CATEGORY_LINEAR = INK_CATEGORY_LINEAR.map((c) =>
  scaleLinear(c, PAPER_INK_SCALE),
) as unknown as [Lin3, Lin3, Lin3]

/** Kept for the few places that still need the ink palette as CSS. */
export const CATEGORY_LINEAR: readonly Lin3[] = INK_CATEGORY_LINEAR

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export interface ThemeColors {
  /** Background in linear light. COVERAGE fades toward this; saturation does not. */
  readonly bgLinear: Lin3
  /** Must stay equal to the `--bg` token in styles/theme.css. */
  readonly bgHex: string
  readonly inkHex: string
  readonly dimHex: string
  /** Category basis in linear light: [Demographic, Geographic, Associative]. */
  readonly catLinear: readonly [Lin3, Lin3, Lin3]
  /** The same three as CSS, for overlay marks and chrome swatches. */
  readonly catCss: readonly [string, string, string]
  /**
   * The colour of material that carries NO identity -- structure the optimizer built in
   * a region no answer deposited into. Must be clearly visible against the background
   * on its own theme; see hueToLinear for why it cannot simply be the background.
   */
  readonly neutralLinear: Lin3
  /** Multiplier on RenderConfig.edgeAccent. */
  readonly edgeScale: number
  /**
   * Scaffolding alphas. An explicit table rather than one global boost, because the
   * ink-to-paper mapping is not linear in alpha: a boost that makes the faint 0.18
   * immutability rings legible on cream drives the 0.35 rim ring to roughly twice the
   * contrast it has on ink.
   */
  readonly guide: {
    readonly ring: number
    readonly rim: number
    readonly divider: number
    readonly arc: number
  }
}

export const THEMES: Readonly<Record<'paper' | 'ink', ThemeColors>> = {
  // Never pure white or pure black: that is the fastest way to make generative output
  // look like a screenshot of a debug view.
  ink: {
    bgLinear: srgbHexToLinear('#101014'),
    bgHex: '#101014',
    inkHex: '#e8e8ea',
    dimHex: '#8b8b96',
    catLinear: INK_CATEGORY_LINEAR,
    catCss: INK_CATEGORY,
    neutralLinear: srgbHexToLinear('#6f6f78'),
    edgeScale: 1,
    guide: { ring: 0.18, rim: 0.35, divider: 0.14, arc: 0.32 },
  },
  paper: {
    bgLinear: srgbHexToLinear('#f4f1ea'),
    bgHex: '#f4f1ea',
    inkHex: '#1c1a17',
    dimHex: '#6a655c',
    catLinear: PAPER_CATEGORY_LINEAR,
    catCss: [
      linearToSrgbHex(PAPER_CATEGORY_LINEAR[0]),
      linearToSrgbHex(PAPER_CATEGORY_LINEAR[1]),
      linearToSrgbHex(PAPER_CATEGORY_LINEAR[2]),
    ] as unknown as readonly [string, string, string],
    // A warm graphite, dark enough to read as a drawn mark on cream rather than as a
    // smudge of the paper itself.
    neutralLinear: srgbHexToLinear('#8a8377'),
    // A paper boundary pixel starts from a far higher L*, so the same multiply costs it
    // roughly twice as much lightness.
    edgeScale: 0.6,
    guide: { ring: 0.55, rim: 0.72, divider: 0.45, arc: 0.75 },
  },
}

/**
 * Map a hue on the simplex plus a saturation in [0,1] to a linear-light MATERIAL colour.
 *
 * The division of labour, and it took a screenshot to get right:
 *
 *   coverage (density)  ->  whether there is material here at all
 *   saturation (kappa)  ->  how much IDENTITY that material carries
 *
 * So saturation interpolates between a neutral structural ink and the full category
 * colour -- NOT between the background and the category colour. Fading toward the
 * background conflates "no identity" with "no material", and the optimizer routinely
 * builds load-bearing structure through regions no answer deposited into: the
 * connectivity floor and the volume remap fill the whole disc. Fade those to the
 * background and the truss connecting the tiles becomes invisible; on paper they instead
 * came out as one large pale slab that dominated the composition, which is what exposed
 * the confusion.
 *
 * With a neutral floor, unclaimed structure reads honestly as structure without identity
 * -- graphite on cream, grey on near-black -- and colour is reserved for material that
 * actually belongs to an answer. The caller then composites toward the background by
 * coverage, so BOTH axes still fade correctly on a light ground.
 *
 * Index reads rather than destructuring: this runs once per pixel, up to 16.7M times for
 * a 4096px export, and array destructuring goes through the iterator protocol.
 */
export function hueToLinear(
  hr: number,
  hg: number,
  hb: number,
  saturation: number,
  theme: ThemeColors,
  out: [number, number, number],
): void {
  const cat = theme.catLinear
  const dr = cat[0]
  const dg = cat[1]
  const db = cat[2]
  const n = theme.neutralLinear
  const n0 = n[0]
  const n1 = n[1]
  const n2 = n[2]
  out[0] = n0 + saturation * (hr * dr[0] + hg * dg[0] + hb * db[0] - n0)
  out[1] = n1 + saturation * (hr * dr[1] + hg * dg[1] + hb * db[1] - n1)
  out[2] = n2 + saturation * (hr * dr[2] + hg * dg[2] + hb * db[2] - n2)
}

/**
 * Conviction -> saturation, for the discrete tile view.
 *
 * Each answered question is one tile of uniform size, so conviction has to be carried by
 * COLOUR INTENSITY rather than by area. `kappa` in the tile field is exactly the
 * answer's strength value (0.33 / 0.66 / 1.0), and the old `kappa / (kappa + 1)` curve
 * would squash those three into 0.25-0.50 -- visually indistinguishable, which defeats
 * the point of the encoding. This ramp spreads them across a legible range instead.
 */
export function convictionToSaturation(kappa: number): number {
  if (kappa <= 0) return 0
  // Anchored on the three strength levels: Minor 0.33 -> 0.45, Notable 0.66 -> 0.72,
  // Core 1.0 -> 1.0. Linear between, clamped, so an interpolated or legacy field still
  // maps sensibly.
  const t = Math.min(1, kappa)
  return Math.min(1, 0.2 + 0.8 * t)
}

export const BLEND_MEANING = {
  /**
   * NOTE: an equal Demographic+Geographic blend actually lands at hue 32 degrees -- an
   * amber or ochre, not a lemon yellow -- and Geographic+Associative at 203 degrees, a
   * steel blue rather than a true cyan. That is a consequence of choosing basis colours
   * of comparable LIGHTNESS over ones with matched channel structure, and correcting it
   * costs either a 4.5x luminance spread across the three primaries or a magenta blend
   * that collapses to 16% saturation. Distinguishability carries the meaning here, not
   * hue precision, so the names below describe the readings honestly.
   */
  amber: { mix: 'Demographic + Geographic', name: 'Regional Heritage / Roots' },
  steel: { mix: 'Geographic + Associative', name: 'Localized Communities' },
  magenta: { mix: 'Demographic + Associative', name: 'Affinity Groups' },
  /**
   * On ink this is a pale neutral against near-black; on paper it is a dark graphite-plum
   * against cream. Both are correct, because the Concordant Core's meaning was never
   * literally "white" -- it is the ACHROMATIC extreme relative to the ground, which is
   * what overprinting all three plates gives you.
   */
  neutral: { mix: 'All three integrated', name: 'Concordant Core' },
} as const
