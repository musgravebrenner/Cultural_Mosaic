import { useStore } from '../state/store'
import { THEMES } from './tone'
import type { ThemeColors } from './tone'
import type { CategoryId } from '../domain/taxonomy'

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
