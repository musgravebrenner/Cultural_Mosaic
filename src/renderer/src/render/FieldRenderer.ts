import type { RenderConfig } from '../domain/types'
import { THEMES, convictionToSaturation, hueToLinear, linearToSrgb8, smoothstep } from './tone'
import type { ThemeColors } from './tone'

/**
 * Density + hue -> pixels.
 *
 * Raw Canvas 2D, one ImageData written directly and blitted with a single putImageData.
 * The decisive argument against p5 is not its weight but that the only viable technique
 * at ~10k cells is exactly the one that makes p5 irrelevant: p5's value is its drawing
 * API, and `fill(); rect()` per cell is ~1.7M canvas state operations per second at
 * 60fps -- landing around 15-25fps while stealing CPU the solver needs. Going through
 * p5's loadPixels()/pixels[] instead is byte-index arithmetic into a typed array, which
 * is identical code with or without p5.
 */

export interface FieldFrame {
  readonly n: number
  /** n*n densities in [0,1]. */
  readonly density: Float32Array | Float64Array
  /** n*n*3 hue on the simplex. */
  readonly hue: Float32Array
  /** n*n conviction. */
  readonly kappa: Float32Array
  /** n*n; 0 outside the disc. */
  readonly mask: Uint8Array
  /** Optional: the seed density, drawn as a faint trace of what eroded away. */
  readonly ghost?: Float32Array
}

export class FieldRenderer {
  private field: HTMLCanvasElement | OffscreenCanvas
  private fieldCtx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  private img: ImageData | null = null
  private n = 0
  private rgb: [number, number, number] = [0, 0, 0]

  constructor(
    private display: HTMLCanvasElement,
    private displayCtx: CanvasRenderingContext2D,
  ) {
    // Offscreen buffer at grid resolution; the display canvas upscales from it.
    this.field =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(1, 1)
        : document.createElement('canvas')
    const ctx = this.field.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('2d context unavailable for the field buffer')
    this.fieldCtx = ctx as CanvasRenderingContext2D
  }

  private ensure(n: number): void {
    if (this.n === n && this.img) return
    this.n = n
    this.field.width = n
    this.field.height = n
    this.img = this.fieldCtx.createImageData(n, n)
  }

  /**
   * Compose one frame. Everything is blended in linear light; see tone.ts.
   */
  draw(frame: FieldFrame, cfg: RenderConfig): void {
    const { n, density, hue, kappa, mask, ghost } = frame
    this.ensure(n)
    const img = this.img!
    const px = img.data
    const theme = THEMES[cfg.theme]
    const [bgR, bgG, bgB] = theme.bgLinear
    const rgb = this.rgb
    const useGhost = cfg.showGhost && ghost !== undefined

    /**
     * ImageData row 0 is the TOP of the image, but the grid's ey increases with +y
     * (UP), so the destination row must be flipped.
     *
     * Without this the field renders upside down while the vector overlay -- which
     * flips correctly -- does not, so Demographic deposits appear in the Associative
     * sector and vice versa while the pinned ground symbols stay put. The mosaic still
     * looks entirely plausible, which is exactly what makes this class of bug
     * dangerous: it was only caught by reading a screenshot against the sector labels.
     */
    for (let ey = 0; ey < n; ey++) {
      const destRow = (n - 1 - ey) * n
      for (let ex = 0; ex < n; ex++) {
        const i = ey * n + ex
        let r = bgR
        let g = bgG
        let b = bgB

        if (mask[i]) {
          const a = smoothstep(cfg.solidLo, cfg.solidHi, density[i]!)

          // The ghost layer -- Proposition 3(c). Compliance minimization exists to
          // eliminate structural redundancy, but the paper holds that structurally
          // redundant identities are real and are what make behaviour unpredictable.
          // The optimizer is therefore, by construction, most hostile to exactly the
          // part of the theory that is hardest to visualize. Drawing the eroded
          // material as a faint trace shows both the optimized structure (concordant,
          // load-bearing) and the ghost of what was removed (independent,
          // unpredictable) in a single image.
          let ga = 0
          if (useGhost) {
            const seeded = smoothstep(cfg.solidLo, cfg.solidHi, ghost![i]!)
            ga = Math.max(0, seeded - a) * theme.ghostAlpha
          }

          /**
           * Ghost UNDER, live material OVER, same hue: two source-over composites of
           * one colour collapse to a single composite at this effective coverage.
           *
           * The previous `sat = a / total` form was algebraically the IDENTITY --
           * sat * min(1, total) equals a exactly whenever total <= 1 -- so the ghost
           * toggle drew nothing at all on either theme, and in the total > 1 branch it
           * made the surviving material paler, which is backwards.
           */
          const aEff = a + ga * (1 - a)
          if (aEff > 0) {
            // Conviction -> saturation, faded toward the BACKGROUND rather than toward
            // black, so a weakly-held identity is a faint tint of its own colour on
            // both themes instead of a dark smudge on the light one.
            hueToLinear(
              hue[3 * i]!,
              hue[3 * i + 1]!,
              hue[3 * i + 2]!,
              convictionToSaturation(kappa[i]!),
              theme,
              rgb,
            )
            r = bgR + aEff * (rgb[0]! - bgR)
            g = bgG + aEff * (rgb[1]! - bgG)
            b = bgB + aEff * (rgb[2]! - bgB)
          }
        }

        const o = (destRow + ex) << 2
        px[o] = linearToSrgb8(r)
        px[o + 1] = linearToSrgb8(g)
        px[o + 2] = linearToSrgb8(b)
        px[o + 3] = 255
      }
    }

    if (cfg.edgeAccent > 0) this.applyEdgeAccent(frame, cfg, theme, px)

    this.fieldCtx.putImageData(img, 0, 0)
    this.blit(cfg)
  }

  /**
   * Cheap gradient magnitude of rho, darkening the solid/void boundary slightly. Gives
   * the truss an inked, drawn quality for one extra pass.
   *
   * GATED ON COVERAGE, which is the whole subtlety. Ungated, the multiply darkens the
   * void exactly as hard as it darkens the material -- and because L* is a cube-root
   * curve that is nearly invisible on near-black but takes 30 L* out of a cream pixel.
   * So on paper the accent's centre of mass moved off the structure and became a grey
   * halo standing in the empty space around it: the artifact was inverted in LOCATION,
   * not merely too strong, which no magnitude scale could fix. Gating on coverage makes
   * it a line on the inner edge of the material on both themes.
   *
   * It is also a latent fix for the ink theme, where the structure previously carried a
   * faint rim two L* darker than its own background.
   *
   * The multiply deliberately stays in sRGB byte space. Moving it to linear light would
   * be more principled, but a 0.65 gamma-space factor is a 0.34 linear one, so the ink
   * accent would weaken about 2.5x for no benefit once the halo is gone.
   */
  private applyEdgeAccent(
    frame: FieldFrame,
    cfg: RenderConfig,
    theme: ThemeColors,
    px: Uint8ClampedArray,
  ): void {
    const { n, density, mask } = frame
    const k = cfg.edgeAccent * theme.edgeScale
    for (let ey = 1; ey < n - 1; ey++) {
      for (let ex = 1; ex < n - 1; ex++) {
        const i = ey * n + ex
        if (!mask[i]) continue
        const gx = Math.abs(density[i + 1]! - density[i - 1]!)
        const gy = Math.abs(density[i + n]! - density[i - n]!)
        const mag = Math.min(1, (gx + gy) * 1.5)
        if (mag < 0.02) continue
        const cover = smoothstep(cfg.solidLo, cfg.solidHi, density[i]!)
        if (cover <= 0) continue
        const f = Math.max(0, 1 - k * mag * cover)
        // Same row flip as the compose pass; reading grid space, writing pixel space.
        const o = ((n - 1 - ey) * n + ex) << 2
        px[o] = px[o]! * f
        px[o + 1] = px[o + 1]! * f
        px[o + 2] = px[o + 2]! * f
      }
    }
  }

  /**
   * Blit the grid-resolution buffer to the display canvas.
   *
   * `imageSmoothingEnabled = false` at an integer scale factor is mathematically exact
   * nearest-neighbour: perfectly hard-edged tiles, honouring the mosaic metaphor and the
   * app's name. Smoothing on gives the organic truss reading instead. Two aesthetics for
   * one boolean.
   */
  private blit(cfg: RenderConfig): void {
    const ctx = this.displayCtx
    const w = this.display.width
    const h = this.display.height
    ctx.imageSmoothingEnabled = cfg.upscale === 'smooth'
    if (cfg.upscale === 'smooth') ctx.imageSmoothingQuality = 'high'
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(this.field as CanvasImageSource, 0, 0, w, h)
  }

  dispose(): void {
    this.img = null
  }
}

export interface SnappedSize {
  /** Device pixels per mosaic cell -- always an integer. */
  readonly cellPx: number
  /** Canvas backing-store size in device pixels, exactly cellPx * n. */
  readonly drawPx: number
  /** CSS size; fractional is fine. */
  readonly cssPx: number
}

/**
 * Snap the drawn size down to an integer cell size.
 *
 * Windows commonly runs at 125% or 150% scaling, giving devicePixelRatio 1.25 or 1.5.
 * If the drawn size is not an exact integer multiple of n, each mosaic cell straddles a
 * fractional number of device pixels and you get shimmer and uneven cell widths -- which
 * looks like a bug in an app whose entire aesthetic is crisp tiles. After snapping,
 * every cell is exactly cellPx x cellPx device pixels and there is no resampling at all.
 *
 * This is also why pan/zoom is out: arbitrary zoom makes cells fractional again.
 */
export function snapToCells(cssW: number, cssH: number, n: number, dpr: number): SnappedSize {
  const avail = Math.floor(Math.min(cssW, cssH) * dpr)
  const cellPx = Math.max(1, Math.floor(avail / n))
  const drawPx = cellPx * n
  return { cellPx, drawPx, cssPx: drawPx / dpr }
}
