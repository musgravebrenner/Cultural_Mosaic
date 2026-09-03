import type { PlacedTile, RenderConfig } from '../domain/types'
import { FieldRenderer } from './FieldRenderer'
import type { FieldFrame } from './FieldRenderer'
import { OverlayRenderer } from './OverlayRenderer'
import { THEMES } from './tone'
import { resampleField } from './resample'

/**
 * High-resolution PNG export.
 *
 * NEVER scales the display canvas. The artwork is rendered fresh at the target size
 * using the same renderers with a different scale, which is why every length, stroke
 * width and font size in OverlayRenderer is a function of `scale` rather than a
 * hardcoded pixel value.
 */

export interface ExportOptions {
  readonly size: number
  readonly includeScaffolding: boolean
  readonly tiles: readonly PlacedTile[]
  readonly synthetics: readonly { x: number; y: number; thetaDeg: number }[]
  readonly rimRadius: number
}

export async function exportPng(
  frame: FieldFrame,
  cfg: RenderConfig,
  opts: ExportOptions,
): Promise<Uint8Array> {
  const { size } = opts

  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not create an export canvas.')

  ctx.fillStyle = THEMES[cfg.theme].bgHex
  ctx.fillRect(0, 0, size, size)

  if (cfg.upscale === 'mosaic') {
    // Nearest-neighbour at an INTEGER factor is mathematically exact: perfectly
    // hard-edged tiles with no resampling artifacts at all.
    const renderer = new FieldRenderer(canvas, ctx)
    renderer.draw(frame, cfg)
    renderer.dispose()
  } else {
    /**
     * Resample the float field FIRST, tone-map second. Never the reverse.
     *
     * Tone-mapping at grid resolution and then upscaling gives a mushy image whose
     * solid/void boundary was anti-aliased at 96px and then blurred. Resampling rho and
     * each colour channel as floats to the output resolution, and only then applying
     * the smoothstep and the gamma composite, anti-aliases the structural boundary at
     * the OUTPUT resolution. It is the difference between a blown-up screenshot and a
     * print.
     */
    const hi = resampleField(frame, size)
    const renderer = new FieldRenderer(canvas, ctx)
    renderer.draw(hi, { ...cfg, upscale: 'mosaic' })
    renderer.dispose()
  }

  if (opts.includeScaffolding) {
    const overlay = document.createElement('canvas')
    overlay.width = size
    overlay.height = size
    const octx = overlay.getContext('2d')
    if (octx) {
      new OverlayRenderer(overlay, octx).draw(
        {
          tiles: opts.tiles,
          synthetics: opts.synthetics,
          rimRadius: opts.rimRadius,
          hovered: null,
          phase: 0,
        },
        cfg,
      )
      ctx.drawImage(overlay, 0, 0)
    }
  }

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png')
  })
  if (!blob) throw new Error('Could not encode the artwork as PNG.')
  return new Uint8Array(await blob.arrayBuffer())
}

export const EXPORT_SIZES = [1024, 2048, 4096] as const
