import type { PlacedTile, RenderConfig } from '../domain/types'
import { FieldRenderer } from './FieldRenderer'
import type { FieldFrame } from './FieldRenderer'
import { OverlayRenderer } from './OverlayRenderer'
import { THEMES } from './tone'

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
  /**
   * Draw the overlay layer at all -- scaffolding, ground symbols, anchor labels.
   *
   * Named for the LAYER rather than for one of the things on it. As
   * `includeScaffolding` it was passed `render.showScaffolding`, so turning scaffolding
   * off to get a clean export silently dropped the anchor labels too -- which is exactly
   * the configuration someone exporting a labelled picture would choose.
   */
  readonly includeOverlay: boolean
  readonly tiles: readonly PlacedTile[]
  readonly synthetics: readonly { x: number; y: number; thetaDeg: number; sigma: number }[]
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

  // Nearest-neighbour at an INTEGER factor is mathematically exact: perfectly
  // hard-edged tiles with no resampling artifacts at all -- the same treatment the
  // live canvas always uses now that the soft-edged alternative is gone.
  const renderer = new FieldRenderer(canvas, ctx)
  renderer.draw(frame, cfg)
  renderer.dispose()

  if (opts.includeOverlay) {
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
