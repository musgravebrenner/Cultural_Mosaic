import type { RenderConfig } from '../domain/types'
import { THEMES, hueToLinear, linearToSrgb8, smoothstep } from './tone'

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
          let a = smoothstep(cfg.solidLo, cfg.solidHi, density[i]!)

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
            ga = Math.max(0, seeded - a) * 0.22
          }

          if (a > 0 || ga > 0) {
            hueToLinear(hue[3 * i]!, hue[3 * i + 1]!, hue[3 * i + 2]!, kappa[i]!, rgb)
            // Desaturate toward the void: thin regions fade toward the background tone
            // rather than toward grey. Grey reads as missing data; paper reads as
            // negative space.
            const total = a + ga
            const sat = a / Math.max(total, 1e-6)
            const cr = rgb[0] * sat + bgR * (1 - sat)
            const cg = rgb[1] * sat + bgG * (1 - sat)
            const cb = rgb[2] * sat + bgB * (1 - sat)
            a = Math.min(1, total)
            r = cr * a + bgR * (1 - a)
            g = cg * a + bgG * (1 - a)
            b = cb * a + bgB * (1 - a)
          }
        }

        const o = (destRow + ex) << 2
        px[o] = linearToSrgb8(r)
        px[o + 1] = linearToSrgb8(g)
        px[o + 2] = linearToSrgb8(b)
        px[o + 3] = 255
      }
    }

    if (cfg.edgeAccent > 0) this.applyEdgeAccent(frame, cfg, px)

    this.fieldCtx.putImageData(img, 0, 0)
    this.blit(cfg)
  }

  /**
   * Cheap gradient magnitude of rho, darkening the solid/void boundary slightly. Gives
   * the truss an inked, drawn quality for one extra pass.
   */
  private applyEdgeAccent(frame: FieldFrame, cfg: RenderConfig, px: Uint8ClampedArray): void {
    const { n, density, mask } = frame
    const k = cfg.edgeAccent
    for (let ey = 1; ey < n - 1; ey++) {
      for (let ex = 1; ex < n - 1; ex++) {
        const i = ey * n + ex
        if (!mask[i]) continue
        const gx = Math.abs(density[i + 1]! - density[i - 1]!)
        const gy = Math.abs(density[i + n]! - density[i - n]!)
        const mag = Math.min(1, (gx + gy) * 1.5)
        if (mag < 0.02) continue
        const f = 1 - k * mag
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
