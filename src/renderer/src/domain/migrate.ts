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

export const CURRENT_SCHEMA_VERSION = 1 as const

type Doc = Record<string, unknown>
type Migration = (doc: Doc, warnings: string[]) => Doc

/** Indexed by the version being migrated FROM. */
const MIGRATIONS: Record<number, Migration> = {
  // 0 -> 1: files written before the schema was versioned at all. Nothing to change
  // structurally; the parser's clamping handles the rest.
  0: (doc, warnings) => {
    warnings.push('This file predates schema versioning; defaults were filled in.')
    return doc
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
