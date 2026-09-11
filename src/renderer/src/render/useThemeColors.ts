import { useStore } from '../state/store'
import { THEMES } from './tone'
import type { ThemeColors } from './tone'
import type { CategoryId } from '../domain/taxonomy'
import type { Cat3 } from '../domain/types'

/**
 * The active theme's colours, for chrome that has to agree with the artwork.
 *
 * Every component that draws a category swatch used to carry its own hardcoded copy of
 * the three hexes. That is fine while there is one palette and actively wrong once there
 * are two: the splash legend and the library's mix bars would keep showing the ink inks
 * while the mosaic rendered the paper ones, so the legend would simply lie about what
 * the colours mean.
 *
 * Theme changes are human-rate, so the extra store subscription costs nothing. Only
 * leaves and full-screen views use this -- never an ancestor of MosaicCanvas.
 */
export function useThemeColors(): ThemeColors {
  return THEMES[useStore((s) => s.render.theme)]
}

/** Category -> CSS colour for the active theme, in taxonomy order. */
export function categoryCss(theme: ThemeColors): Record<CategoryId, string> {
  return {
    demographic: theme.catCss[0],
    geographic: theme.catCss[1],
    associative: theme.catCss[2],
  }
}

/**
 * A tile's own blended hue as a CSS colour -- the same swatch the artwork itself would
 * show for that tile, so a legend or a chart entry never shows a colour the mosaic
 * doesn't actually use.
 *
 * Shared between the canvas overlay (OverlayRenderer's ground symbols and leaders) and
 * plain DOM UI (the interference chart's swatches), which is why this lives here rather
 * than as a canvas-only private helper: it used to be duplicated, and the duplicate was
 * one edit away from drifting from the real palette.
 */
export function hueToCss(hue: Cat3, theme: ThemeColors): string {
  const [hr, hg, hb] = hue
  const c = theme.catCss.map((hex) => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  })
  const mix = (i: number): number =>
    Math.round(hr * c[0]![i]! + hg * c[1]![i]! + hb * c[2]![i]!)
  return `rgb(${mix(0)}, ${mix(1)}, ${mix(2)})`
}
