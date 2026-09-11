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
   * Not a claim about biology. 1 = unchangeable (pins as a rim anchor),
   * 0 = chosen daily (applies a load near the hub).
   *
   * UNCHANGEABLE, not "given at birth" -- and the difference is load-bearing. Chao &
   * Moon define the Associative category as the groups "an individual chooses to
   * associate and identify with", so reading this axis as natality made every
   * associative tile fluid by construction and left the entire Associative sector
   * without a single rim anchor. But choice and reversibility are independent: you can
   * choose something once and never be able to unchoose it. Raising a child, a divorce,
   * a criminal record, a second citizenship, a body changed by injury -- all chosen or
   * unchosen, none undoable by a decision this year. Those are what anchor the
   * Associative rim.
   */
  readonly immutability: number
  readonly note?: string
  /** Reviewer note on a pair kept with reservation. Shown in dev; see docs/design. */
  readonly risky?: string
}

// ---------------------------------------------------------------------------
// Layer 1b -- anchor questions. Single-choice-from-N facts, never a spectrum.
// ---------------------------------------------------------------------------

/**
 * An anchor is a hard fact, not an orientation: you either have raised a child or you
 * have not. Forcing that through `WordPair`'s poleA/poleB slider would break the
 * moment a question needs more than two options (birth decade), so it is a distinct
 * shape rather than a `WordPair` with `skew` disabled.
 */
export interface AnchorOption {
  /** Stable within the anchor: 'male', 'has', 'hasnt', '1990s'... */
  readonly id: string
  readonly label: string
  /** Resolved hue this option contributes, already L1-normalized. */
  readonly hue: Cat3
}

export interface AnchorPair {
  readonly id: string
  readonly category: CategoryId
  readonly facet: FacetId
  readonly prompt: string
  readonly options: readonly AnchorOption[]
  readonly immutability: number
  readonly note?: string
}

/**
 * Once answered, an anchor is always full conviction -- there is no partial-anchor
 * state, matching "you either have or haven't." Skipping one simply means no
 * `AnchorAnswer` exists for it, the same absent-vs-dormant distinction the app already
 * draws for regular questions.
 */
export interface AnchorAnswer {
  readonly answerId: string
  readonly anchorId: string
  readonly optionId: string
  readonly addedAt: number
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

/**
 * Strength is DERIVED from lean, not a second control. Distance from centre IS
 * conviction: the two extreme notches are Core, the two inner notches grade down, and
 * dead centre -- "equally both", the one position with no direction at all -- is
 * Dormant. This replaces an earlier design where strength was set independently and
 * centre was hard-coded to Core (biculturals as maximally strong material); the
 * simpler one-gesture reading is what the instrument actually asks a user to do.
 */
export function strengthFromLean(leanIndex: LeanIndex): StrengthLevel {
  const distance = Math.abs(leanIndex - LEAN_CENTER)
  if (distance >= 3) return 3
  if (distance === 2) return 2
  if (distance === 1) return 1
  return 0
}

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
  /** smoothstep band on rho. The primary aesthetic dial. */
  readonly solidLo: number
  readonly solidHi: number
  readonly theme: 'paper' | 'ink'
  readonly showScaffolding: boolean
  /**
   * Name the pinned anchors on the artwork.
   *
   * A SEPARATE flag from showScaffolding rather than riding on it. Scaffolding is the
   * measuring apparatus -- sector arcs, immutability rings, axis legend -- and the
   * obvious reason to turn it off is to get a clean image. Anchor labels are content:
   * they say which of your identities is holding the structure up. Tying them together
   * would make "read the labels" and "get a clean picture" mutually exclusive, and
   * labels-on with scaffolding-off is the combination people actually want.
   */
  readonly showAnchorLabels: boolean
  /**
   * Name every non-hub tile's chosen pole on the artwork, not just the pinned
   * anchors' -- a SEPARATE flag from `showAnchorLabels` for the same reason that one
   * is separate from `showScaffolding`: this is about making an already-answered
   * choice legible (e.g. so two people's printed mosaics can be compared by eye),
   * not about naming which identities hold the structure up.
   */
  readonly showPoleLabels: boolean
  /** 0 = off. Gradient-magnitude edge accent; gives the truss an inked quality. */
  readonly edgeAccent: number
}

// ---------------------------------------------------------------------------
// The saveable document
// ---------------------------------------------------------------------------

export interface MosaicProfile {
  readonly schemaVersion: 2
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
  /** Snapshot of every referenced anchor, same rationale as `pairs`. */
  anchors: AnchorPair[]
  anchorAnswers: AnchorAnswer[]
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
  /** Lattice cell this tile claimed. Exact, so hit-testing needs no float search. */
  readonly tileCol: number
  readonly tileRow: number
  /**
   * HALF THE TILE BODY, in normalized units. Named sigma for history -- it was the
   * Gaussian deposit width before each question became one discrete square tile.
   * boundary.ts sizes pin regions and passive-solid patches from it.
   */
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
