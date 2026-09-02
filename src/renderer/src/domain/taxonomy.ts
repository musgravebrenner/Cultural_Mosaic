/**
 * Chao & Moon (2005), Table 1: "Taxonomy of a Cultural Mosaic".
 * The three primary categories map to the three primary colours, which is the
 * paper's own analogy ("just as any color picture, at its core, comprises three
 * primary colors, we define an individual's cultural mosaic as comprising three
 * primary categories").
 */

export type CategoryId = 'demographic' | 'geographic' | 'associative'

/** Table 1's "Sample tiles" column, verbatim. */
export type FacetId =
  // Demographic -- "Physical characteristics and social identities inherited from
  // parents and ancestors"
  | 'age'
  | 'ethnicity'
  | 'gender'
  | 'race'
  // Geographic -- "Natural or man-made physical features of a region that can shape
  // group identities"
  | 'climate'
  | 'temperature'
  | 'coastal-inland'
  | 'urban-rural'
  | 'regional-country'
  // Associative -- "Formal and informal groups that an individual chooses to associate
  // and identify with"
  | 'family'
  | 'religion'
  | 'employer'
  | 'profession'
  | 'politics'
  | 'avocations'

export const CATEGORIES: readonly CategoryId[] = ['demographic', 'geographic', 'associative']

export const FACETS_BY_CATEGORY: Readonly<Record<CategoryId, readonly FacetId[]>> = {
  demographic: ['age', 'ethnicity', 'gender', 'race'],
  geographic: ['climate', 'temperature', 'coastal-inland', 'urban-rural', 'regional-country'],
  associative: ['family', 'religion', 'employer', 'profession', 'politics', 'avocations'],
}

export const CATEGORY_OF_FACET: Readonly<Record<FacetId, CategoryId>> = (() => {
  const out = {} as Record<FacetId, CategoryId>
  for (const c of CATEGORIES) for (const f of FACETS_BY_CATEGORY[c]) out[f] = c
  return out
})()

export const CATEGORY_LABEL: Readonly<Record<CategoryId, string>> = {
  demographic: 'Demographic',
  geographic: 'Geographic',
  associative: 'Associative',
}

export const FACET_LABEL: Readonly<Record<FacetId, string>> = {
  age: 'Age',
  ethnicity: 'Ethnicity',
  gender: 'Gender',
  race: 'Race',
  climate: 'Climate',
  temperature: 'Temperature',
  'coastal-inland': 'Coastal / Inland',
  'urban-rural': 'Urban / Rural',
  'regional-country': 'Regional / Country',
  family: 'Family',
  religion: 'Religion',
  employer: 'Employer',
  profession: 'Profession',
  politics: 'Politics',
  avocations: 'Avocations',
}

/**
 * Sector centres for the radial layout, in degrees. The three are 120 deg apart, which
 * is what makes each sector *boundary* the angular bisector of its two neighbours --
 * and therefore makes an equal two-way blend land exactly on the boundary between its
 * two parent categories. See layout/polar.ts.
 */
export const SECTOR_CENTER_DEG: Readonly<Record<CategoryId, number>> = {
  demographic: 60,
  geographic: 180,
  associative: 300,
}

/** Index into a Cat3 weight vector. 0 = Demographic/R, 1 = Geographic/G, 2 = Associative/B. */
export const CATEGORY_INDEX: Readonly<Record<CategoryId, 0 | 1 | 2>> = {
  demographic: 0,
  geographic: 1,
  associative: 2,
}

/**
 * Secondary-colour readings. Because blends land on sector boundaries, each of these
 * names the region where its two parent categories meet.
 */
export const BLEND_MEANING = {
  yellow: { mix: 'Demographic + Geographic', name: 'Regional Heritage / Roots' },
  cyan: { mix: 'Geographic + Associative', name: 'Localized Communities' },
  magenta: { mix: 'Demographic + Associative', name: 'Affinity Groups' },
  white: { mix: 'All three integrated', name: 'Concordant Core' },
} as const
