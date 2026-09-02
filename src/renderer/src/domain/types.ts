import type { CategoryId, FacetId } from './taxonomy'

/**
 * Weights over (Demographic, Geographic, Associative) == (R, G, B).
 * Library values are authored L1-normalized; `normalizeMix` enforces it at load.
 */
export type Cat3 = readonly [r: number, g: number, b: number]

// ---------------------------------------------------------------------------
// Layer 1 -- library definition. Shipped data, frozen, ~79 of them.
// ---------------------------------------------------------------------------

export interface WordPair {
  /**
   * Stable and meaningful: 'D-AGE-01', 'custom.<uuid>'. Never an array index --
   * inserting a library pair must not reshuffle anyone's existing artwork.
   */
  readonly id: string
  readonly source: 'library' | 'custom'
  /** Primary category, for UI grouping only. The `mix` is what drives placement. */
  readonly category: CategoryId
  readonly facet: FacetId | 'custom'
  /** Pole at lean = -1. */
  readonly poleA: string
  /** Pole at lean = +1. */
  readonly poleB: string
  /** w0: the hue at slider centre. */
  readonly mix: Cat3
  /**
   * Polar skew. Effective hue is L1norm(max(0, mix + lean * skew)), so a pair whose two
   * poles genuinely differ in category character *moves* through the placement formula.
   * Omitted means zero. This is the principled channel by which slider position changes
   * geometry and not merely colour.
   */
  readonly skew?: Cat3
  /**
   * Social fixity in [0,1]: how much could you change this by a decision this year?
   * Not a claim about biology. 1 = given at birth (pins as a rim anchor),
   * 0 = chosen daily (applies a load near the hub).
   */
  readonly immutability: number
  readonly note?: string
  /** Reviewer note on a pair kept with reservation. Shown in dev; see docs/design. */
  readonly risky?: string
}

// ---------------------------------------------------------------------------
// Layer 2 -- the user's answer. This is the document.
// ---------------------------------------------------------------------------

/** 7 notches. Centre is reachable by click, which is what makes "equally both" real. */
export const LEAN_NOTCHES: readonly number[] = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1]
export type LeanIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6
export const LEAN_CENTER: LeanIndex = 3

/**
 * Chao & Moon Prop 2: activation depends on identity STRENGTH, which is a distinct
 * construct from identity content. One slider cannot encode both, because slider-centre
 * would have to mean "genuinely both" (strong material) and "not me" (absent material)
 * at once -- structural opposites.
 */
export type StrengthLevel = 0 | 1 | 2 | 3
export const STRENGTH_VALUES: readonly number[] = [0, 0.33, 0.66, 1.0]
export const STRENGTH_LABELS: readonly string[] = ['Dormant', 'Minor', 'Notable', 'Core']

export interface TileAnswer {
  readonly answerId: string
  readonly pairId: string
  /** CONTENT / direction: which pole, and how committed. */
  readonly leanIndex: LeanIndex
  /** MAGNITUDE / activation. Orthogonal to lean. Dormant contributes nothing. */
  readonly strength: StrengthLevel
  /**
   * User override of the pair's authored immutability. Exposed because baking fixity
   * into the library imposes the author's biography on every user -- and since
   * immutability sets the radius, that would decide who gets to be structural bedrock.
   */
  readonly immutabilityOverride?: number
  /** ms epoch. Stable ordering, and deterministic angular slotting within the user's set. */
  readonly addedAt: number
}

// ---------------------------------------------------------------------------
// Configs
// ---------------------------------------------------------------------------

export type GridSize = 64 | 96 | 128

export interface LayoutConfig {
  readonly gridSize: GridSize
  /** R_max as a fraction of the half-extent. */
  readonly rimRadius: number
  /** Radial floor so fluid tiles do not collapse onto a coincident hub point. */
  readonly minRadius: number
  /** Radial nonlinearity exponent; > 1 keeps the rim exclusive to genuinely fixed traits. */
  readonly radialExponent: number
  /** Low-purity (near-white) items are pulled toward the hub by this floor. */
  readonly purityFloor: number
  /** Deposit footprint base, as a fraction of R_max. MUST keep sigmaMin >= filterRadius. */
  readonly sigmaBase: number
  /** Inverts the layout: chosen associations pin, inherited traits load. */
  readonly invertAnchors: boolean
}

export interface SolverSettings {
  readonly mode: 'simp' | 'beso'
  /** Derived from total identity strength unless overridden with a number. */
  readonly volumeFraction: number | 'derived'
  readonly penalty: number
  readonly filterRadius: number
  readonly iterations: number
  readonly moveLimit: number
  readonly erosionRate: number
  readonly seed: number
}

export interface RenderConfig {
  readonly upscale: 'mosaic' | 'smooth'
  /** smoothstep band on rho. The primary aesthetic dial. */
  readonly solidLo: number
  readonly solidHi: number
  readonly theme: 'paper' | 'ink'
  readonly showScaffolding: boolean
  /** 0 = off. Gradient-magnitude edge accent; gives the truss an inked quality. */
  readonly edgeAccent: number
  /** Render eroded material as a faint trace -- Prop 3(c), the independent tiles. */
  readonly showGhost: boolean
}

// ---------------------------------------------------------------------------
// The saveable document
// ---------------------------------------------------------------------------

export interface MosaicProfile {
  readonly schemaVersion: 1
  readonly kind: 'cultural-mosaic-profile'
  readonly id: string
  title: string
  createdAt: string
  updatedAt: string
  appVersion: string
  /**
   * Snapshot of EVERY referenced pair, library ones included. Referencing library pairs
   * by id alone would mean that tuning a preset in a later version silently changes
   * every previously-saved artwork.
   */
  pairs: WordPair[]
  answers: TileAnswer[]
  layout: LayoutConfig
  solver: SolverSettings
  render: RenderConfig
}

// ---------------------------------------------------------------------------
// Layer 3 -- derived. Pure f(WordPair, TileAnswer, LayoutConfig). Never persisted.
// ---------------------------------------------------------------------------

export type TileRole = 'anchor' | 'mass' | 'load'

export interface PlacedTile {
  readonly answerId: string
  readonly pairId: string
  readonly label: string
  /** Whichever pole the lean favours; "equally both" at centre. */
  readonly activePole: string
  /** Effective hue after applying skew. L1-normalized. */
  readonly hue: Cat3
  /**
   * WITHIN one tile: how single-category it is. 1 = pure, 0.5 = two-way blend,
   * 0 = balanced three-way (the white "Concordant Core").
   *
   * Distinct from concordance, which is BETWEEN neighbours (Prop 1) and drives the
   * stiffness field. Never let one stand in for the other -- the physics becomes
   * incoherent if you do.
   */
  readonly purity: number
  readonly lean: number
  /** |lean|. 0 = balanced, 1 = committed. Drives deposit concentration, not amplitude. */
  readonly polarity: number
  readonly salience: number
  readonly immutability: number
  readonly thetaDeg: number
  /** Normalized [0,1]. */
  readonly radius: number
  /** Normalized, centred, y-up. */
  readonly x: number
  readonly y: number
  /** Deposit footprint in normalized units. */
  readonly sigma: number
  /** Peak deposit amplitude. Comes from salience, NOT |lean|. */
  readonly amplitude: number
  readonly role: TileRole
  readonly load?: { readonly fx: number; readonly fy: number }
}

/** An authored antagonism between two specific poles of two specific pairs. */
export interface Antagonism {
  readonly a: string
  /** Which pole of `a` is in tension: -1 for poleA, +1 for poleB. */
  readonly aPole: -1 | 1
  readonly b: string
  readonly bPole: -1 | 1
  readonly weight: number
  readonly why: string
}
