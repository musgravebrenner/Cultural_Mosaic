import type { PlacedTile, RenderConfig } from '../domain/types'
import type { CategoryId } from '../domain/taxonomy'
import { CATEGORY_LABEL, SECTOR_CENTER_DEG } from '../domain/taxonomy'
import { M_ANCHOR } from '../layout/polar'
import { THEMES } from './tone'
import type { ThemeColors } from './tone'
import { hueToCss } from './useThemeColors'

/**
 * Sector guides, pinned-anchor ground symbols, load arrows, hover ring.
 *
 * A separate canvas from the field, for three reasons: the field redraws at 60fps
 * during a run while this changes only on edit or hover; the two layers want OPPOSITE
 * context settings (imageSmoothingEnabled false vs true, plus anti-aliased text) which
 * are per-context; and hit-testing state belongs here.
 *
 * EVERY length, line width and font size is a function of `scale`. That is what makes
 * the high-resolution PNG export work without a second renderer -- render fresh at the
 * target size with a different scale rather than upscaling the display canvas.
 */

const CATS = ['demographic', 'geographic', 'associative'] as const

/**
 * Where the three category labels sit. ONE definition, read by both the scaffolding that
 * draws them and the anchor labels that must avoid them -- two copies of this drifted
 * apart the first time the rim radius was retuned.
 */
function categoryLabelRing(R: number): { x: number; y: number }[] {
  return CATS.map((c) => {
    const a = (SECTOR_CENTER_DEG[c] * Math.PI) / 180
    // Just outside the rim, so labels never sit on top of the deposits -- but still
    // inside the [-1,1] box, since anything beyond r = 1 is clipped by the canvas.
    const rr = Math.min(0.97, R + 0.075)
    return { x: rr * Math.cos(a), y: rr * Math.sin(a) }
  })
}

/** Horizontal anchoring that keeps a label inside the canvas box. */
function alignFor(lx: number, widthN: number): CanvasTextAlign {
  // Derived from the measured width rather than from a magic x threshold, so it cannot
  // clip. It reduces to the old "centre unless far out" rule in the common case.
  if (Math.abs(lx) + widthN / 2 <= 0.98) return 'center'
  return lx > 0 ? 'right' : 'left'
}

/** A category label with no drag applied -- its default position from `categoryLabelRing`. */
export const NO_LABEL_OFFSETS: Readonly<Record<CategoryId, { readonly x: number; readonly y: number }>> =
  Object.freeze({
    demographic: { x: 0, y: 0 },
    geographic: { x: 0, y: 0 },
    associative: { x: 0, y: 0 },
  })

const FONT = '"Segoe UI", system-ui, sans-serif'

/** Never shrunk smaller than this, however long the text or small the tile. */
const MIN_LABEL_FONT_PX = 4
/** Ceiling for the shrink-to-fit search, as a fraction of `scale` -- never bigger than a category label. */
const MAX_LABEL_FONT_FRAC = 0.04
const LABEL_LINE_HEIGHT_MULT = 1.15
/** Fraction of the tile's own body available to the wrapped label, leaving a small margin. */
const LABEL_FIT_FRACTION = 0.86
/** Blur radius of the paper-theme glow behind the text, as a multiple of its own font size. */
const LABEL_GLOW_BLUR_MULT = 0.9
/** Blur radius of the ink-theme drop shadow -- tighter than the paper glow, so it reads as cast rather than diffuse. */
const LABEL_SHADOW_BLUR_MULT = 0.4
/** Directional offset of the ink-theme drop shadow, as a multiple of font size. */
const LABEL_SHADOW_OFFSET_MULT = 0.14

/**
 * Greedy word-wrap at the CURRENT font. A single word wider than `maxWidthPx` still
 * gets its own line rather than being split mid-word or dropped -- an overflowing line
 * is the accepted cost of never truncating text.
 */
function wrapLabel(ctx: CanvasRenderingContext2D, text: string, maxWidthPx: number): string[] {
  const words = text.split(' ')
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`
    if (current === '' || ctx.measureText(candidate).width <= maxWidthPx) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current !== '') lines.push(current)
  return lines
}

/**
 * The largest font size (down to `MIN_LABEL_FONT_PX`) at which `text`, wrapped to
 * `maxWidthPx`, fits within `maxHeightPx`. Never truncates: if even the floor size
 * overflows the height, that best-effort wrap is returned anyway, so a label may spill
 * a little past its own tile rather than lose words -- "small but complete" over
 * "clipped".
 */
function fitLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidthPx: number,
  maxHeightPx: number,
  startFontPx: number,
): { fontPx: number; lines: string[]; lineHeightPx: number } {
  let best = {
    fontPx: MIN_LABEL_FONT_PX,
    lines: [text],
    lineHeightPx: MIN_LABEL_FONT_PX * LABEL_LINE_HEIGHT_MULT,
  }
  for (let fontPx = Math.max(MIN_LABEL_FONT_PX, Math.round(startFontPx)); fontPx >= MIN_LABEL_FONT_PX; fontPx--) {
    ctx.font = `${fontPx}px ${FONT}`
    const lines = wrapLabel(ctx, text, maxWidthPx)
    const lineHeightPx = fontPx * LABEL_LINE_HEIGHT_MULT
    best = { fontPx, lines, lineHeightPx }
    if (lines.length * lineHeightPx <= maxHeightPx) break
  }
  return best
}

/** A category label's on-screen chip, in the overlay canvas's own backing-pixel space. */
export interface CategoryLabelBox {
  readonly category: CategoryId
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

interface CategoryLabelLayout extends CategoryLabelBox {
  readonly text: string
  /** Text anchor point -- NOT the box centre, since alignment can put it at an edge. */
  readonly cxPx: number
  readonly cyPx: number
  readonly align: CanvasTextAlign
}

export interface OverlayInput {
  readonly tiles: readonly PlacedTile[]
  readonly rimRadius: number
  /** answerId currently hovered, or null. */
  /** Neutral supports the app invented; drawn hollow so they read as not-yours. */
  readonly synthetics: readonly { x: number; y: number; thetaDeg: number; sigma: number }[]
  readonly hovered: string | null
  /** Iteration count, for the load-arrow pulse. 0 when idle. */
  readonly phase: number
  /**
   * Per-category drag offset from its default position (see `categoryLabelRing`), in
   * normalized [-1,1] units. A viewer drags a label clear of whatever tile it landed
   * on; see `categoryLabelBoxes` for the hit-testing side of that.
   */
  readonly labelOffsets: Readonly<Record<CategoryId, { readonly x: number; readonly y: number }>>
}

export class OverlayRenderer {
  constructor(
    private canvas: HTMLCanvasElement,
    private ctx: CanvasRenderingContext2D,
  ) {}

  /**
   * `scale` is device pixels per normalized unit of the [-1,1] domain, i.e. half the
   * canvas backing width.
   */
  draw(input: OverlayInput, cfg: RenderConfig): void {
    const { ctx } = this
    const w = this.canvas.width
    const h = this.canvas.height
    ctx.clearRect(0, 0, w, h)
    if (w === 0 || h === 0) return

    const scale = Math.min(w, h) / 2
    const cx = w / 2
    const cy = h / 2
    const theme = THEMES[cfg.theme]

    // Normalized (y-up) -> canvas (y-down).
    const px = (x: number): number => cx + x * scale
    const py = (y: number): number => cy - y * scale

    ctx.save()
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'

    if (cfg.showScaffolding) {
      this.drawScaffolding(input, theme, scale, px, py)
    }

    for (const t of input.tiles) {
      if (t.role === 'anchor') this.drawGroundSymbol(t, theme, scale, px, py)
    }
    for (const s of input.synthetics) {
      this.drawGroundSymbol(s, theme, scale, px, py, true)
    }
    for (const t of input.tiles) {
      if (t.role === 'load' && t.load) this.drawLoadArrow(t, theme, input.phase, scale, px, py)
    }

    // `showPoleLabels` is a superset of `showAnchorLabels` (EVERY tile, hub loads
    // included, not just the anchors), drawn through the same call so a tile is never
    // labelled twice when both are on.
    //
    // `showAnchorLabels` selects by the pair's own AUTHORED immutability
    // (`>= M_ANCHOR`), not by final `role`. Those two can disagree: boundary.ts caps
    // how many tiles actually get pinned (MAX_ANCHORS, plus a minimum angular
    // separation), so a genuinely fixed identity can lose that competition and get
    // finished as `role: 'mass'` -- which used to mean it silently lost its label too,
    // and losers skew toward lower-salience (Minor/Notable) answers, since the
    // competition is ranked by immutability*salience. The GROUND SYMBOL still only
    // marks tiles that actually WON a pinned slot (drawn elsewhere, keyed on the
    // final `role`); the label now answers a different question -- "is this identity
    // fixed enough to be anchor-tier" -- so a labelled tile with no glyph under it is
    // exactly that: anchor-tier, but this profile's competition seated it elsewhere.
    if (cfg.showAnchorLabels || cfg.showPoleLabels) {
      const include: (t: PlacedTile) => boolean = cfg.showPoleLabels
        ? () => true
        : (t) => t.immutability >= M_ANCHOR
      this.drawTileLabels(input, theme, cfg.theme, scale, px, py, include)
    }

    // Drawn after every tile label, not alongside the rest of the scaffolding, so a
    // tile pinned close to its own sector's centre angle can never end up painted on
    // top of the label that names that sector. See `drawCategoryLabels`.
    if (cfg.showScaffolding) {
      this.drawCategoryLabels(input, theme, scale, px, py)
    }

    const hov = input.tiles.find((t) => t.answerId === input.hovered)
    if (hov) this.drawHoverRing(hov, theme, scale, px, py)

    ctx.restore()
  }

  private drawScaffolding(
    input: OverlayInput,
    theme: ThemeColors,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
  ): void {
    const { ctx } = this
    const R = input.rimRadius

    // Concentric immutability rings, labelled at the extremes so the radial axis reads.
    ctx.strokeStyle = theme.dimHex
    ctx.globalAlpha = theme.guide.ring
    ctx.lineWidth = Math.max(1, scale * 0.002)
    for (const frac of [0.25, 0.5, 0.75]) {
      ctx.beginPath()
      ctx.arc(px(0), py(0), R * frac * scale, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.globalAlpha = theme.guide.rim
    ctx.beginPath()
    ctx.arc(px(0), py(0), R * scale, 0, Math.PI * 2)
    ctx.stroke()

    // Sector arcs in their category colours, and the dividers at 0 / 120 / 240 deg.
    ctx.lineWidth = Math.max(2, scale * 0.012)
    const cats = CATS
    for (let k = 0; k < 3; k++) {
      const centre = SECTOR_CENTER_DEG[cats[k]!]
      const a0 = ((centre - 60) * Math.PI) / 180
      const a1 = ((centre + 60) * Math.PI) / 180
      ctx.strokeStyle = theme.catCss[k]!
      ctx.globalAlpha = theme.guide.arc
      ctx.beginPath()
      // Canvas angles run clockwise with y down, so negate.
      ctx.arc(px(0), py(0), Math.min(0.985, R * 1.045) * scale, -a1, -a0)
      ctx.stroke()
    }

    ctx.globalAlpha = theme.guide.divider
    ctx.strokeStyle = theme.dimHex
    ctx.lineWidth = Math.max(1, scale * 0.002)
    for (const deg of [0, 120, 240]) {
      const a = (deg * Math.PI) / 180
      ctx.beginPath()
      ctx.moveTo(px(0), py(0))
      ctx.lineTo(px(R * Math.cos(a)), py(R * Math.sin(a)))
      ctx.stroke()
    }

    // The category labels themselves are NOT drawn here -- see `drawCategoryLabels`,
    // called last in `draw()`, for why.

    // The radial axis legend -- same halo-and-bold treatment, at the smaller size this
    // caption has always used.
    ctx.font = `bold ${Math.max(8, Math.round(scale * 0.036))}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.lineWidth = Math.max(2, scale * 0.007)
    ctx.strokeStyle = theme.bgHex
    ctx.strokeText('chosen daily', px(0.03), py(0.04))
    ctx.strokeText('unchangeable', px(0.03), py(R - 0.05))
    ctx.fillStyle = theme.dimHex
    ctx.fillText('chosen daily', px(0.03), py(0.04))
    ctx.fillText('unchangeable', px(0.03), py(R - 0.05))
    ctx.globalAlpha = 1
  }

  /**
   * The three category labels (DEMOGRAPHIC / GEOGRAPHIC / ASSOCIATIVE), drawn LAST in
   * `draw()` -- after every tile's own pole label -- so nothing can subsequently paint
   * over them.
   *
   * `categoryLabelRing` sits them just outside the rim, but "just outside" is a
   * point, not a lane: the text itself has width, and `alignFor` grows that width
   * INWARD (back toward the disc) whenever the point sits too close to the canvas edge
   * to centre it, which is exactly the case at Geographic's own 180 deg. That is also
   * exactly where that sector's most immutable answers are pinned, at a radius that
   * runs right up to the rim -- so the label and a real tile routinely want the same
   * pixels. A halo can lose that fight (a later-drawn tile label paints its own halo
   * straight over it); a solid backing chip cannot, regardless of what ends up under
   * it or which pass drew last. `labelOffsets` is the other half of that fix: whatever
   * the chip still ends up covering, a viewer can drag it aside -- see
   * `categoryLabelBoxes` for the hit-testing this shares geometry with.
   */
  private drawCategoryLabels(
    input: OverlayInput,
    theme: ThemeColors,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
  ): void {
    const { ctx } = this
    const layouts = this.layoutCategoryLabels(input, scale, px, py)

    ctx.save()
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    for (let k = 0; k < layouts.length; k++) {
      const L = layouts[k]!
      const chipRadius = L.height * 0.24

      ctx.globalAlpha = 0.9
      ctx.fillStyle = theme.bgHex
      ctx.beginPath()
      ctx.roundRect(L.left, L.top, L.width, L.height, chipRadius)
      ctx.fill()
      ctx.globalAlpha = 0.55
      ctx.lineWidth = Math.max(1, scale * 0.0025)
      ctx.strokeStyle = theme.catCss[k]!
      ctx.stroke()

      ctx.globalAlpha = 1
      ctx.textAlign = L.align
      ctx.fillStyle = theme.catCss[k]!
      ctx.fillText(L.text, L.cxPx, L.cyPx)
    }
    ctx.restore()
  }

  /**
   * The geometry `drawCategoryLabels` paints and `categoryLabelBoxes` hit-tests --
   * ONE definition, so a click can never land on a box the drawing disagrees with.
   */
  private layoutCategoryLabels(
    input: OverlayInput,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
  ): CategoryLabelLayout[] {
    const { ctx } = this
    const fontPx = Math.max(9, Math.round(scale * 0.048))
    const padX = fontPx * 0.5
    const padY = fontPx * 0.34
    ctx.font = `bold ${fontPx}px ${FONT}`

    const ring = categoryLabelRing(input.rimRadius)
    return CATS.map((category, k) => {
      const base = ring[k]!
      const offset = input.labelOffsets[category]
      const lx = base.x + offset.x
      const ly = base.y + offset.y
      const text = CATEGORY_LABEL[category].toUpperCase()
      const textW = ctx.measureText(text).width
      // Same rule as before: a label centred at 180 deg would extend past x = -1 and
      // clip mid-word, so anchor it on whichever side keeps it inside the canvas. Once
      // dragged, this can still occasionally re-anchor a label from the side its text
      // grows on -- a deliberate trade for never letting a drag walk it off-canvas.
      const align = alignFor(lx, textW / scale)
      const cxPx = px(lx)
      const cyPx = py(ly)
      // The chip always spans the measured text box itself, whichever side the text
      // actually grew from -- so it never drifts off-centre under the glyphs.
      const textLeft = align === 'center' ? cxPx - textW / 2 : align === 'left' ? cxPx : cxPx - textW

      return {
        category,
        text,
        cxPx,
        cyPx,
        align,
        left: textLeft - padX,
        top: cyPx - fontPx / 2 - padY,
        width: textW + padX * 2,
        height: fontPx + padY * 2,
      }
    })
  }

  /**
   * Chip bounding boxes in the overlay canvas's own backing-pixel space, for
   * hit-testing a click-and-drag on a category label. `MosaicCanvas` converts a mouse
   * event into this same pixel space (as it already does for tile hit-testing) and
   * tests the point against each box.
   */
  categoryLabelBoxes(input: OverlayInput): readonly CategoryLabelBox[] {
    const w = this.canvas.width
    const h = this.canvas.height
    if (w === 0 || h === 0) return []
    const scale = Math.min(w, h) / 2
    const cx = w / 2
    const cy = h / 2
    const px = (x: number): number => cx + x * scale
    const py = (y: number): number => cy - y * scale
    return this.layoutCategoryLabels(input, scale, px, py)
  }

  /**
   * Name a tile's chosen pole -- either just the anchor-tier identities
   * (`showAnchorLabels`) or literally every answered tile, hub loads included
   * (`showPoleLabels`). Two separate concerns share this one drawing path:
   * `showAnchorLabels` says which identities are fixed enough to anchor the
   * structure, `showPoleLabels` says what was actually answered -- e.g. so two
   * people's printed mosaics can be compared pole by pole -- and `include` decides
   * which; `showPoleLabels`'s predicate is a superset of `showAnchorLabels`'s, so a
   * tile is never drawn twice when both are on.
   *
   * `showAnchorLabels` selects on the pair's own immutability, not on final `role`:
   * see the call site in `draw()` for why those can disagree.
   *
   * Set INSIDE the tile's own body -- wrapped across as many lines as it takes, shrunk
   * down toward `MIN_LABEL_FONT_PX` if it must, but never truncated. That is a change
   * from an earlier version that floated a one-line, ellipsis-truncated label outside
   * the tile on a leader line: full pole text matters more than a tidy single line, and
   * a label that stays over its own tile needs no leader and cannot collide with
   * another tile's label, since tiles never overlap. It CAN still reach a category
   * label just beyond the rim -- see `drawCategoryLabels` for why that is handled by
   * draw order rather than by geometry.
   *
   * The hub loads used to be excluded here on the theory that the hover tooltip
   * already names them -- but "Answers" (`showPoleLabels`) is a request to see every
   * answer at once, and a tile that silently opts out of that reads as broken rather
   * than as intentional, especially sitting right next to fully-labelled tiles of the
   * exact same size. Loads are the same lattice-uniform size as every other tile, so
   * nothing about labelling them is actually harder; they just happen to cluster more
   * densely near the hub, the same way any low-radius band does.
   */
  private drawTileLabels(
    input: OverlayInput,
    theme: ThemeColors,
    themeName: 'ink' | 'paper',
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
    include: (t: PlacedTile) => boolean,
  ): void {
    const { ctx } = this
    const labelled = input.tiles.filter(include)
    if (labelled.length === 0) return

    const startFontPx = Math.max(MIN_LABEL_FONT_PX, Math.round(scale * MAX_LABEL_FONT_FRAC))
    // Ink is a dark ground with light ink: a dark halo behind light text already
    // reads as cast shadow rather than glow, so it gets a small directional offset
    // and a tighter blur -- an actual drop shadow. Paper stays a soft, centred glow
    // (no offset): a light halo around dark ink has no "cast" reading to lean into,
    // and legibility there comes from the blur alone.
    const isInk = themeName === 'ink'

    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.globalAlpha = 1

    for (const t of labelled) {
      const tileSidePx = 2 * t.sigma * scale
      const maxWidthPx = tileSidePx * LABEL_FIT_FRACTION
      const maxHeightPx = tileSidePx * LABEL_FIT_FRACTION
      // A tile too small to hold even the floor font legibly: skip rather than draw
      // illegible noise. The hover tooltip still names it.
      if (maxWidthPx < MIN_LABEL_FONT_PX || maxHeightPx < MIN_LABEL_FONT_PX) continue

      const { fontPx, lines, lineHeightPx } = fitLabel(
        ctx,
        t.activePole,
        maxWidthPx,
        maxHeightPx,
        startFontPx,
      )
      ctx.font = `${fontPx}px ${FONT}`

      const cxPx = px(t.x)
      const cyPx = py(t.y)
      const blockH = lines.length * lineHeightPx
      const firstY = cyPx - blockH / 2 + lineHeightPx / 2

      /**
       * The halo/shadow pass BEHIND the text, then a crisp fill with no shadow on
       * top.
       *
       * The anchor glyph and the label are both centred on the same point, so they
       * routinely overlap -- and the glyph is drawn in the same ink colour the text
       * is. A hard-edged halo stroke alone is easy to break with a thin, busy glyph
       * behind it; blurring it clears a wider, softer patch of background colour
       * first, which stays legible under the glyph's linework without needing the
       * stroke itself to get any heavier.
       */
      ctx.shadowColor = theme.bgHex
      ctx.shadowBlur = Math.max(1, fontPx * (isInk ? LABEL_SHADOW_BLUR_MULT : LABEL_GLOW_BLUR_MULT))
      ctx.shadowOffsetX = isInk ? fontPx * LABEL_SHADOW_OFFSET_MULT : 0
      ctx.shadowOffsetY = isInk ? fontPx * LABEL_SHADOW_OFFSET_MULT : 0
      ctx.lineWidth = Math.max(1.5, fontPx * 0.22)
      ctx.strokeStyle = theme.bgHex
      for (let i = 0; i < lines.length; i++) {
        ctx.strokeText(lines[i]!, cxPx, firstY + i * lineHeightPx)
      }

      ctx.shadowBlur = 0
      ctx.shadowOffsetX = 0
      ctx.shadowOffsetY = 0
      ctx.fillStyle = theme.inkHex
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i]!, cxPx, firstY + i * lineHeightPx)
      }
    }

    ctx.restore()
  }

  /**
   * The anchor mark: a literal anchor glyph, centred on the tile.
   *
   * Replaces an earlier FEA "pinned support" triangle -- honest to the structural
   * metaphor, but it read as decoration rather than as a claim about the identity
   * itself, and it was drawn in the tile's own hue, which buried it against a
   * same-family tile. An anchor is instantly legible on sight and needs no legend, and
   * drawing it in the theme's INK rather than the tile's hue is deliberate: this mark
   * means "immutable", a property of the mark itself, not of which tile it sits on, so
   * it stays the one constant, maximum-contrast colour everywhere on the disc -- pure
   * ink on paper, pure paper-white on ink. (Requested as "black in light mode, white in
   * dark mode": theme.inkHex already resolves to exactly that on both themes.)
   *
   * Upright always, never rotated to the radial direction -- an anchor has a canonical
   * up/down the way the outward-pointing FEA triangle never needed to, and rotating it
   * per-tile would read as broken rather than as pinned.
   */
  private drawGroundSymbol(
    t: Pick<PlacedTile, 'x' | 'y' | 'sigma'>,
    theme: ThemeColors,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
    synthetic = false,
  ): void {
    const { ctx } = this
    // Sized off the tile's own half-width so the glyph sits comfortably inside the
    // square at any profile size, from a handful of huge tiles to a full library of
    // small ones.
    const s = Math.max(scale * 0.02, t.sigma * scale * 0.62)
    const x = px(t.x)
    const y = py(t.y)

    const ringR = s * 0.22
    const ringY = -s * 0.78
    const shankTop = ringY + ringR * 0.95
    const shankBottom = s * 0.45
    const crossbarY = -s * 0.32
    const crossbarHalf = s * 0.4
    const flukeR = s * 0.42

    ctx.save()
    ctx.translate(x, y)
    ctx.strokeStyle = theme.inkHex
    ctx.fillStyle = theme.inkHex
    ctx.lineCap = 'round'
    ctx.lineWidth = Math.max(1, s * 0.16)
    // Hollow and dashed for a support the app invented: it reads as "not yours".
    ctx.globalAlpha = synthetic ? 0.5 : 0.92
    if (synthetic) ctx.setLineDash([s * 0.16, s * 0.16])

    // Ring.
    ctx.beginPath()
    ctx.arc(0, ringY, ringR, 0, Math.PI * 2)
    ctx.stroke()

    // Shank.
    ctx.beginPath()
    ctx.moveTo(0, shankTop)
    ctx.lineTo(0, shankBottom)
    ctx.stroke()

    // Crossbar (the "stock").
    ctx.beginPath()
    ctx.moveTo(-crossbarHalf, crossbarY)
    ctx.lineTo(crossbarHalf, crossbarY)
    ctx.stroke()

    /**
     * Flukes: two hooks curling out from the base of the shank.
     *
     * Each is one arc whose circle PASSES THROUGH the shank-bottom point by
     * construction (its centre sits exactly `flukeR` to that point's side), so the
     * stroke starts already joined to the shank with no gap to paper over. The sweep
     * goes through the bottom of that circle first and finishes past the side,
     * pointing back up and outward -- the hook silhouette a real anchor fluke has,
     * rather than a shallow V that only touches the shank at one point.
     */
    ctx.beginPath()
    ctx.arc(-flukeR, shankBottom, flukeR, 0, Math.PI * 0.92, false)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(flukeR, shankBottom, flukeR, Math.PI, Math.PI * 0.08, true)
    ctx.stroke()

    ctx.setLineDash([])
    ctx.restore()
  }

  private drawLoadArrow(
    t: PlacedTile,
    theme: ThemeColors,
    phase: number,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
  ): void {
    const load = t.load
    if (!load) return
    const { ctx } = this
    const mag = Math.hypot(load.fx, load.fy)
    if (mag < 1e-9) return

    // Normalize direction and cap the drawn length, so one large force cannot blow out
    // the composition.
    const ux = load.fx / mag
    const uy = load.fy / mag
    const len = scale * (0.05 + 0.09 * Math.min(1, mag * 6)) * (1 + 0.06 * Math.sin(phase * 0.2))

    const x0 = px(t.x)
    const y0 = py(t.y)
    const x1 = x0 + ux * len
    const y1 = y0 - uy * len

    ctx.save()
    ctx.strokeStyle = hueCss(t, theme)
    ctx.fillStyle = hueCss(t, theme)
    ctx.globalAlpha = 0.9
    ctx.lineWidth = Math.max(1.2, scale * 0.005)
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1, y1)
    ctx.stroke()

    const head = Math.max(3, scale * 0.018)
    const ang = Math.atan2(y1 - y0, x1 - x0)
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x1 - head * Math.cos(ang - 0.4), y1 - head * Math.sin(ang - 0.4))
    ctx.lineTo(x1 - head * Math.cos(ang + 0.4), y1 - head * Math.sin(ang + 0.4))
    ctx.closePath()
    ctx.fill()

    ctx.globalAlpha = 0.6
    ctx.beginPath()
    ctx.arc(x0, y0, Math.max(1.5, scale * 0.006), 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }

  private drawHoverRing(
    t: PlacedTile,
    theme: ThemeColors,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
  ): void {
    const { ctx } = this
    ctx.save()
    ctx.strokeStyle = theme.inkHex
    ctx.globalAlpha = 0.8
    ctx.lineWidth = Math.max(1, scale * 0.004)
    // A SQUARE, tracing the tile body, because that is the shape the answer actually
    // occupies now. A circle of radius sigma both cut the corners off and bulged past
    // the edges, so it read as a highlight near the tile rather than on it.
    // Outset by a hair so the stroke sits in the gutter instead of over the artwork.
    const half = Math.max(3, t.sigma * scale) + ctx.lineWidth
    ctx.strokeRect(px(t.x) - half, py(t.y) - half, half * 2, half * 2)
    ctx.restore()
  }
}

/**
 * The tile's own hue as a CSS colour, for its overlay marks.
 *
 * Delegates to the shared `hueToCss` in useThemeColors.ts, which the interference chart
 * (plain DOM, not canvas) also uses -- one palette mix, not two copies that can drift.
 */
function hueCss(t: Pick<PlacedTile, 'hue'>, theme: ThemeColors): string {
  return hueToCss(t.hue, theme)
}
