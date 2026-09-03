import type { PlacedTile, RenderConfig } from '../domain/types'
import { CATEGORY_LABEL, SECTOR_CENTER_DEG } from '../domain/taxonomy'
import { THEMES } from './tone'
import type { ThemeColors } from './tone'

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

export interface OverlayInput {
  readonly tiles: readonly PlacedTile[]
  readonly rimRadius: number
  /** answerId currently hovered, or null. */
  /** Neutral supports the app invented; drawn hollow so they read as not-yours. */
  readonly synthetics: readonly { x: number; y: number; thetaDeg: number }[]
  readonly hovered: string | null
  /** Iteration count, for the load-arrow pulse. 0 when idle. */
  readonly phase: number
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
      this.drawGroundSymbol(
        {
          thetaDeg: s.thetaDeg,
          x: s.x,
          y: s.y,
          salience: 0.35,
          hue: [1 / 3, 1 / 3, 1 / 3] as const,
        },
        theme,
        scale,
        px,
        py,
        true,
      )
    }
    for (const t of input.tiles) {
      if (t.role === 'load' && t.load) this.drawLoadArrow(t, theme, input.phase, scale, px, py)
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
    const cats = ['demographic', 'geographic', 'associative'] as const
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

    // Category labels, set along the sector centres.
    ctx.globalAlpha = theme.guide.label
    ctx.font = `${Math.max(9, Math.round(scale * 0.048))}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let k = 0; k < 3; k++) {
      const deg = SECTOR_CENTER_DEG[cats[k]!]
      const a = (deg * Math.PI) / 180
      // Just outside the rim, so labels never sit on top of the deposits -- but still
      // inside the [-1,1] box, since anything beyond r = 1 is clipped by the canvas.
      const rr = Math.min(0.97, R + 0.075)
      const lx = rr * Math.cos(a)
      const ly = rr * Math.sin(a)
      // A centred label at 180 deg would extend past x = -1 and be clipped mid-word,
      // so anchor each label on the side that keeps it inside the box.
      ctx.textAlign = lx < -0.5 ? 'left' : lx > 0.5 ? 'right' : 'center'
      ctx.fillStyle = theme.catCss[k]!
      ctx.globalAlpha = 0.75
      ctx.fillText(CATEGORY_LABEL[cats[k]!].toUpperCase(), px(lx), py(ly))
    }
    ctx.textAlign = 'left'

    // The radial axis legend.
    ctx.globalAlpha = theme.guide.legend
    ctx.fillStyle = theme.dimHex
    ctx.font = `${Math.max(8, Math.round(scale * 0.036))}px "Segoe UI", system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText('chosen daily', px(0.03), py(0.04))
    ctx.fillText('given at birth', px(0.03), py(R - 0.05))
    ctx.globalAlpha = 1
  }

  /**
   * The structural-engineering ground symbol: a triangle with hatch strokes, pointing
   * outward. Honest to the FEA metaphor and instantly legible as "pinned".
   */
  private drawGroundSymbol(
    t: Pick<PlacedTile, 'thetaDeg' | 'x' | 'y' | 'salience' | 'hue'>,
    theme: ThemeColors,
    scale: number,
    px: (x: number) => number,
    py: (y: number) => number,
    synthetic = false,
  ): void {
    const { ctx } = this
    const a = (t.thetaDeg * Math.PI) / 180
    const s = scale * (0.026 + 0.016 * t.salience)
    const x = px(t.x)
    const y = py(t.y)

    ctx.save()
    ctx.translate(x, y)
    // Canvas y is down, so the outward radial direction is (cos a, -sin a).
    ctx.rotate(-a)
    ctx.fillStyle = hueCss(t, theme)
    ctx.strokeStyle = hueCss(t, theme)
    ctx.lineWidth = Math.max(1, scale * 0.0035)

    ctx.beginPath()
    ctx.moveTo(s, 0)
    ctx.lineTo(-s * 0.35, -s * 0.8)
    ctx.lineTo(-s * 0.35, s * 0.8)
    ctx.closePath()
    if (synthetic) {
      // Hollow and dashed: this support is the app's, not the user's.
      ctx.globalAlpha = 0.55
      ctx.setLineDash([scale * 0.008, scale * 0.008])
      ctx.stroke()
      ctx.setLineDash([])
    } else {
      ctx.fill()
    }

    // Hatching behind the base.
    ctx.globalAlpha = 0.75
    for (let k = -2; k <= 2; k++) {
      const yy = (k / 2) * s * 0.8
      ctx.beginPath()
      ctx.moveTo(-s * 0.35, yy)
      ctx.lineTo(-s * 0.85, yy + s * 0.28)
      ctx.stroke()
    }
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
    ctx.beginPath()
    ctx.arc(px(t.x), py(t.y), Math.max(4, t.sigma * scale), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

/**
 * The tile's own hue as a CSS colour, for its overlay marks.
 *
 * Mixes from the ACTIVE theme's inks. It previously carried a private copy of the ink
 * palette, so on paper every ground symbol and load arrow would have been drawn in a
 * colour the mosaic itself never renders.
 */
function hueCss(t: Pick<PlacedTile, 'hue'>, theme: ThemeColors): string {
  const [hr, hg, hb] = t.hue
  const c = theme.catCss.map((hex) => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  })
  const mix = (i: number): number =>
    Math.round(hr * c[0]![i]! + hg * c[1]![i]! + hb * c[2]![i]!)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}
