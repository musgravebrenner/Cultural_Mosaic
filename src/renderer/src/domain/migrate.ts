/**
 * Ordered schema migration chain.
 *
 * Written on day one with a single identity step, deliberately. It is fifteen lines
 * now; retrofitting it after v1 files exist in the wild is exactly the moment when
 * people lose files.
 *
 * Each migration takes the document one version forward and may append warnings the
 * user should see. They run in order, so a v1 file passing through to v3 gets both.
 */

export const CURRENT_SCHEMA_VERSION = 2 as const

type Doc = Record<string, unknown>
type Migration = (doc: Doc, warnings: string[]) => Doc

/**
 * Pair ids that a v1 document's `answers` may reference but that no longer exist in
 * any form (retired outright: superseded by the cleaner v2 anchor set, or trimmed for
 * distinctiveness) or that exist only in a DIFFERENT shape now (graduated from a
 * spectrum-shaped `WordPair` into a genuine binary `AnchorPair` -- the answer format
 * differs, so the old lean-based answer cannot be faithfully carried forward as an
 * anchor choice).
 */
const V1_RETIRED_PAIR_IDS: readonly string[] = [
  'A-STA-01', 'A-LIF-03', 'G-CLI-04', 'A-PRO-05', 'A-REL-01', 'A-AVO-01',
]
const V1_GRADUATED_TO_ANCHOR_IDS: readonly string[] = ['A-LIF-02', 'A-STA-02', 'A-EMB-01']

/** Indexed by the version being migrated FROM. */
const MIGRATIONS: Record<number, Migration> = {
  // 0 -> 1: files written before the schema was versioned at all. Nothing to change
  // structurally; the parser's clamping handles the rest.
  0: (doc, warnings) => {
    warnings.push('This file predates schema versioning; defaults were filled in.')
    return doc
  },
  // 1 -> 2: the 30-pair library was restructured into 21 regular pairs plus a new,
  // separate set of binary/single-choice anchor questions (see domain/library.ts).
  // Six regular pairs retired outright and three more moved into the new anchor
  // mechanic under new ids. A v1 answer for any of those nine cannot be carried
  // forward -- there is no faithful way to turn a 7-notch lean into a single
  // yes/or-no choice -- so it is dropped, once, with one summary warning naming how
  // many. `anchors`/`anchorAnswers` are simply absent from a v1 document; the parser
  // defaults them to empty.
  1: (doc, warnings) => {
    const rawAnswers = Array.isArray(doc['answers']) ? doc['answers'] : []
    const retired = new Set([...V1_RETIRED_PAIR_IDS, ...V1_GRADUATED_TO_ANCHOR_IDS])
    let dropped = 0
    const kept = rawAnswers.filter((a) => {
      if (!a || typeof a !== 'object') return true
      const pairId = (a as Record<string, unknown>)['pairId']
      if (typeof pairId === 'string' && retired.has(pairId)) {
        dropped++
        return false
      }
      return true
    })
    if (dropped > 0) {
      warnings.push(
        `${dropped} answer(s) referenced a question retired or replaced in this version and `
          + 'were dropped. Revisit the new anchor questions if you want to restate them.',
      )
    }
    return { ...doc, answers: kept }
  },
}

export function migrate(raw: Doc, fromVersion: number, warnings: string[]): Doc {
  let doc = raw
  for (let v = fromVersion; v < CURRENT_SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v]
    if (!step) {
      warnings.push(`No migration from schema ${v}; loaded as-is.`)
      break
    }
    doc = step(doc, warnings)
  }
  return doc
}
