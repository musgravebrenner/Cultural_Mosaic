import type {
  AnchorAnswer,
  AnchorOption,
  AnchorPair,
  Cat3,
  GridSize,
  LayoutConfig,
  LeanIndex,
  MosaicProfile,
  RenderConfig,
  SolverSettings,
  TileAnswer,
  WordPair,
} from './types'
import { strengthFromLean } from './types'
import { CATEGORY_OF_FACET } from './taxonomy'
import type { CategoryId, FacetId } from './taxonomy'
import { DEFAULT_LAYOUT } from '../layout/polar'
import { DEFAULT_RENDER, DEFAULT_SOLVER } from '../state/store'
import { migrate, CURRENT_SCHEMA_VERSION } from './migrate'

/**
 * Liberal on read, strict on write.
 *
 * A user should never lose an artwork because one number drifted out of range, so
 * out-of-range values are CLAMPED and reported as warnings rather than rejected. Every
 * problem is collected and returned together, instead of failing on the first one.
 *
 * The two exceptions where refusing is right:
 *  - a file that is not a mosaic profile at all -- checked FIRST, so an unrelated JSON
 *    gets a real message instead of a TypeError from deep inside the parse;
 *  - a file from a NEWER schema version, because silently dropping fields you do not
 *    understand loses the user's data.
 */

export type ParseResult =
  | { ok: true; profile: MosaicProfile; warnings: string[] }
  | { ok: false; errors: string[] }

const KIND = 'cultural-mosaic-profile'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback
}

export function parseProfile(raw: unknown): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!isRecord(raw)) return { ok: false, errors: ['That file does not contain a JSON object.'] }

  // Checked first, so an unrelated JSON file gets a real message.
  if (raw['kind'] !== KIND) {
    return {
      ok: false,
      errors: [`That does not look like a Cultural Mosaic profile (kind: ${String(raw['kind'])}).`],
    }
  }

  const version = num(raw['schemaVersion'], 0)
  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `This file was saved by a newer version of Cultural Mosaic (schema ${version}, this app understands ${CURRENT_SCHEMA_VERSION}).`,
      ],
    }
  }
  const doc = migrate(raw, version, warnings)

  // --- pairs ---------------------------------------------------------------
  const pairs: WordPair[] = []
  const rawPairs = Array.isArray(doc['pairs']) ? doc['pairs'] : []
  if (rawPairs.length === 0) warnings.push('The file contained no word pairs.')
  for (const [i, p] of rawPairs.entries()) {
    const parsed = parsePair(p, i, warnings)
    if (parsed) pairs.push(parsed)
  }
  const pairIds = new Set(pairs.map((p) => p.id))

  // --- answers -------------------------------------------------------------
  const answers: TileAnswer[] = []
  const rawAnswers = Array.isArray(doc['answers']) ? doc['answers'] : []
  const seenAnswerFor = new Set<string>()
  for (const [i, a] of rawAnswers.entries()) {
    if (!isRecord(a)) {
      warnings.push(`Answer ${i} was not an object and was skipped.`)
      continue
    }
    const pairId = str(a['pairId'], '')
    if (!pairIds.has(pairId)) {
      warnings.push(`Answer ${i} referenced an unknown pair "${pairId}" and was skipped.`)
      continue
    }
    // One answer per pair, matching the editor.
    if (seenAnswerFor.has(pairId)) {
      warnings.push(`Duplicate answer for "${pairId}" was dropped.`)
      continue
    }
    seenAnswerFor.add(pairId)

    const leanIndex = clamp(Math.round(num(a['leanIndex'], 3)), 0, 6) as LeanIndex
    // Strength is DERIVED from lean, never trusted from the file -- a file from an
    // older version (or one hand-edited) could carry a strength that no longer
    // matches its lean, and the invariant that the two never drift apart has to hold
    // regardless of a document's vintage.
    const base: TileAnswer = {
      answerId: str(a['answerId'], `restored-${i}`),
      pairId,
      leanIndex,
      strength: strengthFromLean(leanIndex),
      addedAt: num(a['addedAt'], i),
    }
    const override = a['immutabilityOverride']
    answers.push(
      typeof override === 'number' && Number.isFinite(override)
        ? { ...base, immutabilityOverride: clamp(override, 0, 1) }
        : base,
    )
  }

  // --- anchors ---------------------------------------------------------------
  const anchors: AnchorPair[] = []
  const rawAnchors = Array.isArray(doc['anchors']) ? doc['anchors'] : []
  for (const [i, a] of rawAnchors.entries()) {
    const parsed = parseAnchor(a, i, warnings)
    if (parsed) anchors.push(parsed)
  }
  const anchorIds = new Set(anchors.map((a) => a.id))
  const anchorOptionIds = new Map(anchors.map((a) => [a.id, new Set(a.options.map((o) => o.id))]))

  // --- anchor answers ----------------------------------------------------------
  const anchorAnswers: AnchorAnswer[] = []
  const rawAnchorAnswers = Array.isArray(doc['anchorAnswers']) ? doc['anchorAnswers'] : []
  const seenAnchorAnswerFor = new Set<string>()
  for (const [i, a] of rawAnchorAnswers.entries()) {
    if (!isRecord(a)) {
      warnings.push(`Anchor answer ${i} was not an object and was skipped.`)
      continue
    }
    const anchorId = str(a['anchorId'], '')
    if (!anchorIds.has(anchorId)) {
      warnings.push(`Anchor answer ${i} referenced an unknown anchor "${anchorId}" and was skipped.`)
      continue
    }
    if (seenAnchorAnswerFor.has(anchorId)) {
      warnings.push(`Duplicate anchor answer for "${anchorId}" was dropped.`)
      continue
    }
    const optionId = str(a['optionId'], '')
    if (!anchorOptionIds.get(anchorId)!.has(optionId)) {
      warnings.push(`Anchor answer ${i} chose an unknown option "${optionId}" and was skipped.`)
      continue
    }
    seenAnchorAnswerFor.add(anchorId)
    anchorAnswers.push({
      answerId: str(a['answerId'], `restored-anchor-${i}`),
      anchorId,
      optionId,
      addedAt: num(a['addedAt'], i),
    })
  }

  if (errors.length > 0) return { ok: false, errors }

  const profile: MosaicProfile = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    kind: KIND,
    id: str(doc['id'], `mosaic.${Date.now().toString(36)}`),
    title: str(doc['title'], 'Untitled mosaic'),
    createdAt: str(doc['createdAt'], new Date().toISOString()),
    updatedAt: str(doc['updatedAt'], new Date().toISOString()),
    appVersion: str(doc['appVersion'], '0.0.0'),
    pairs,
    answers,
    anchors,
    anchorAnswers,
    layout: parseLayout(doc['layout'], warnings),
    solver: parseSolver(doc['solver'], warnings),
    render: parseRender(doc['render']),
  }
  return { ok: true, profile, warnings }
}

function parseAnchor(p: unknown, i: number, warnings: string[]): AnchorPair | null {
  if (!isRecord(p)) {
    warnings.push(`Anchor ${i} was not an object and was skipped.`)
    return null
  }
  const id = str(p['id'], '')
  const prompt = str(p['prompt'], '').trim()
  const facetRaw = str(p['facet'], '')
  const facet: FacetId | null = facetRaw in CATEGORY_OF_FACET ? (facetRaw as FacetId) : null
  if (id === '' || prompt === '' || facet === null) {
    warnings.push(`Anchor ${i} was missing an id, a prompt, or a valid facet and was skipped.`)
    return null
  }
  const catRaw = str(p['category'], '')
  const category: CategoryId =
    catRaw === 'demographic' || catRaw === 'geographic' || catRaw === 'associative'
      ? catRaw
      : CATEGORY_OF_FACET[facet]

  const rawOptions = Array.isArray(p['options']) ? p['options'] : []
  const options: AnchorOption[] = []
  const seenOptionIds = new Set<string>()
  for (const o of rawOptions) {
    if (!isRecord(o)) continue
    const optId = str(o['id'], '')
    const label = str(o['label'], '').trim()
    if (optId === '' || label === '' || seenOptionIds.has(optId)) continue
    seenOptionIds.add(optId)
    options.push({ id: optId, label, hue: parseCat3(o['hue'], [1 / 3, 1 / 3, 1 / 3]) })
  }
  if (options.length < 2) {
    warnings.push(`Anchor ${i} ("${id}") had fewer than two options and was skipped.`)
    return null
  }

  const base: AnchorPair = {
    id,
    category,
    facet,
    prompt,
    options,
    immutability: clamp(num(p['immutability'], 0.5), 0, 1),
  }
  const note = p['note']
  return typeof note === 'string' ? { ...base, note } : base
}

function parsePair(p: unknown, i: number, warnings: string[]): WordPair | null {
  if (!isRecord(p)) {
    warnings.push(`Pair ${i} was not an object and was skipped.`)
    return null
  }
  const id = str(p['id'], '')
  const poleA = str(p['poleA'], '').trim()
  const poleB = str(p['poleB'], '').trim()
  if (id === '' || poleA === '' || poleB === '') {
    warnings.push(`Pair ${i} was missing an id or a pole and was skipped.`)
    return null
  }

  const facetRaw = str(p['facet'], 'custom')
  const facet: FacetId | 'custom' =
    facetRaw !== 'custom' && facetRaw in CATEGORY_OF_FACET ? (facetRaw as FacetId) : 'custom'

  const catRaw = str(p['category'], '')
  const category: CategoryId =
    catRaw === 'demographic' || catRaw === 'geographic' || catRaw === 'associative'
      ? catRaw
      : facet !== 'custom'
        ? CATEGORY_OF_FACET[facet]
        : 'associative'

  const mix = parseCat3(p['mix'], [1 / 3, 1 / 3, 1 / 3])
  const base: WordPair = {
    id,
    source: p['source'] === 'library' ? 'library' : 'custom',
    category,
    facet,
    poleA,
    poleB,
    mix,
    immutability: clamp(num(p['immutability'], 0.5), 0, 1),
  }
  const skew = p['skew']
  const withSkew = Array.isArray(skew) ? { ...base, skew: parseCat3(skew, [0, 0, 0], false) } : base
  const note = p['note']
  return typeof note === 'string' ? { ...withSkew, note } : withSkew
}

function parseCat3(v: unknown, fallback: Cat3, normalize = true): Cat3 {
  if (!Array.isArray(v) || v.length < 3) return fallback
  const a = num(v[0], 0)
  const b = num(v[1], 0)
  const c = num(v[2], 0)
  if (!normalize) return [a, b, c]
  const r = Math.max(0, a)
  const g = Math.max(0, b)
  const bl = Math.max(0, c)
  const s = r + g + bl
  return s > 1e-9 ? [r / s, g / s, bl / s] : fallback
}

function parseLayout(v: unknown, warnings: string[]): LayoutConfig {
  const o = isRecord(v) ? v : {}
  const g = Math.round(num(o['gridSize'], DEFAULT_LAYOUT.gridSize))
  const gridSize: GridSize = g === 64 || g === 96 || g === 128 ? g : DEFAULT_LAYOUT.gridSize
  if (g !== gridSize) warnings.push(`Unsupported resolution ${g}; using ${gridSize}.`)
  return {
    gridSize,
    rimRadius: clamp(num(o['rimRadius'], DEFAULT_LAYOUT.rimRadius), 0.5, 0.99),
    minRadius: clamp(num(o['minRadius'], DEFAULT_LAYOUT.minRadius), 0.01, 0.5),
    radialExponent: clamp(num(o['radialExponent'], DEFAULT_LAYOUT.radialExponent), 0.5, 3),
    purityFloor: clamp(num(o['purityFloor'], DEFAULT_LAYOUT.purityFloor), 0, 1),
    sigmaBase: clamp(num(o['sigmaBase'], DEFAULT_LAYOUT.sigmaBase), 0.01, 0.3),
    invertAnchors: o['invertAnchors'] === true,
  }
}

function parseSolver(v: unknown, warnings: string[]): SolverSettings {
  const o = isRecord(v) ? v : {}
  const vfRaw = o['volumeFraction']
  const volumeFraction: number | 'derived' =
    vfRaw === 'derived' || vfRaw === undefined
      ? 'derived'
      : clamp(num(vfRaw, 0.35), 0.15, 0.6)
  if (typeof vfRaw === 'number' && (vfRaw < 0.15 || vfRaw > 0.6)) {
    warnings.push(`Volume fraction ${vfRaw} was out of range and has been clamped.`)
  }
  return {
    mode: o['mode'] === 'beso' ? 'beso' : 'simp',
    volumeFraction,
    penalty: clamp(num(o['penalty'], DEFAULT_SOLVER.penalty), 1, 6),
    filterRadius: clamp(num(o['filterRadius'], DEFAULT_SOLVER.filterRadius), 1, 6),
    iterations: clamp(Math.round(num(o['iterations'], DEFAULT_SOLVER.iterations)), 1, 1000),
    moveLimit: clamp(num(o['moveLimit'], DEFAULT_SOLVER.moveLimit), 0.01, 0.5),
    erosionRate: clamp(num(o['erosionRate'], DEFAULT_SOLVER.erosionRate), 0.001, 0.2),
    seed: Math.round(num(o['seed'], DEFAULT_SOLVER.seed)),
  }
}

function parseRender(v: unknown): RenderConfig {
  const o = isRecord(v) ? v : {}
  const lo = clamp(num(o['solidLo'], DEFAULT_RENDER.solidLo), 0, 1)
  const hi = clamp(num(o['solidHi'], DEFAULT_RENDER.solidHi), 0, 1)
  return {
    // Guarantee lo < hi, or smoothstep degenerates into a hard threshold.
    solidLo: Math.min(lo, hi - 0.01),
    solidHi: Math.max(hi, lo + 0.01),
    theme: o['theme'] === 'paper' ? 'paper' : 'ink',
    showScaffolding: o['showScaffolding'] !== false,
    // `=== true`, so a profile saved before this flag existed keeps the appearance it
    // was saved with instead of gaining labels it never had.
    showAnchorLabels: o['showAnchorLabels'] === true,
    showPoleLabels: o['showPoleLabels'] === true,
    edgeAccent: clamp(num(o['edgeAccent'], DEFAULT_RENDER.edgeAccent), 0, 1),
    // `upscale` and `showGhost` used to live here too. Both features are gone -- a
    // profile saved with either key just has it silently ignored now, same as any
    // other unknown field.
  }
}

/** Strict on write: pretty-printed so the file is readable and diffable. */
export function serializeProfile(p: MosaicProfile): string {
  return JSON.stringify(p, null, 2)
}
