import type { AnchorPair, WordPair, Antagonism } from './types'

/**
 * The seeded content library: 21 bipolar orientation spectrums (`LIBRARY`, 7 per
 * category) plus 11 single-choice anchor facts (`ANCHORS`), grouped under Chao & Moon
 * (2005) Table 1's fifteen sample tiles plus three added facets (see
 * IRREVERSIBLE_FACETS in taxonomy.ts).
 *
 * THIS IS THE ONLY PLACE THE MODEL'S SOCIOLOGICAL CONTENT LIVES. Everything else in
 * the app is mechanism.
 *
 * TWO QUESTION TYPES, deliberately kept separate rather than one mechanic wearing two
 * hats:
 *
 *   - `LIBRARY` -- an ORIENTATION spectrum. Every pair is bipolar, answered on a
 *     7-notch lean, and both poles must be a dignified, inhabitable identity (see
 *     Authoring rules below). No pair asks what you are, only how you lean.
 *
 *   - `ANCHORS` -- a FACT. Single-choice from a small, closed set of options (most are
 *     two: "has" / "has not"), answered once and fully, optional to skip. These are
 *     allowed to be the literal, factual thing ("assigned sex at birth", "has broken a
 *     bone") that rule 1 below forbids `LIBRARY` pairs from being, because they are not
 *     read as an orientation at all -- a fact is not an essentialist claim about what a
 *     value means, it is just a fact, and the whole point of an anchor is to pin the
 *     rim with something that cannot be argued into a spectrum. Every anchor still
 *     obeys rule 2 (both options dignified) and rule 6 (no slur, no ranking).
 *
 * This is a restructuring of an earlier 30-pair library (itself distilled from an
 * 86-pair draft) down to 21 regular pairs, with the pairs that were doing anchor duty
 * under a spectrum disguise (the `life-events`/`standing`/`embodied` extension facets,
 * plus a couple of near-anchor regular pairs) rewritten as genuine anchors instead.
 * Every survivor of the 21 either (a) is a facet's cleanest pure- or near-pure-category
 * reading, (b) carries a `skew` and therefore demonstrates that slider position moves
 * the geometry, not just the colour, or (c) is a named exemplar referenced elsewhere in
 * the codebase -- the magenta blend (D-RAC-02), the cyan blend (G-URB-05), the
 * birthplace anchor (G-REG-01), the largest-skew mechanism demo (A-FAM-03). Every id
 * here is also load-bearing: it is either referenced by an antagonism, appears in the
 * app's own `SAMPLE` profile (state/store.ts), or is asserted on by name in a test.
 *
 * ---------------------------------------------------------------------------
 * Authoring rules for LIBRARY, in priority order. These are the defensible part;
 * state them in any writeup.
 * ---------------------------------------------------------------------------
 *
 * 1. Every pair is a bipolar ORIENTATION spectrum, never a category membership. No
 *    pair asks what you are. `Male <-> Female`, `Young <-> Old`, `Christian <-> Muslim`,
 *    `Republican <-> Democrat` are all cut. The justification is internal to the paper:
 *    its central methodological complaint is that "reliance on any single measure as a
 *    proxy for level of heterogeneity will provide unstable results" (p. 1129), and
 *    "rather than choosing a particular tile such as ethnicity or gender, we posit that
 *    individuals draw on combinations or patterns of tiles" (p. 1129). A pair that maps
 *    a demographic category to a value is precisely the essentialism the paper argues
 *    against. This is fidelity to the source, not merely politeness. (`ANCHORS` is the
 *    deliberate, documented exception -- see above.)
 *
 * 2. Both poles/options must be a dignified, inhabitable identity. No pole may read as
 *    the absence or deficit of the other: `Faith orders my life <-> Reason orders my
 *    life`, never `Religious <-> Not religious`. Test: would a person at this pole
 *    describe themselves this way with pride?
 *
 * 3. Immutable facts enter as CENTRALITY, not content, within `LIBRARY`. The physics
 *    needs pinned rim nodes for birth facts, so rather than asking "what is your birth
 *    sex", a `LIBRARY` pair asks how much that fact organizes the self-concept --
 *    identity centrality, a real construct, and genuinely bipolar. `ANCHORS` is where
 *    the raw fact itself is asked instead, once a genuine fact-type question exists to
 *    ask it with.
 *
 * 4. `immutability` is a claim about SOCIAL fixity, not biology. Defined in the UI as:
 *    how much could you change this by a decision this year? Race scores high not
 *    because it is biological but because a person cannot decide out of how they are
 *    read. Say this in the UI copy; it is a one-sentence inoculation against the
 *    obvious objection.
 *
 * 5. Politics and religion stay at the level of value orientations, never institutions
 *    or parties, within `LIBRARY`. Otherwise the artwork becomes a partisan statement
 *    and the FEA is put in the position of computing that two faiths are structurally
 *    discordant. (`ANCH-A-04`, "joined a formal religious tradition," asks membership
 *    as a fact rather than an orientation, which is exactly what `ANCHORS` exists for --
 *    it still never names a tradition.)
 *
 * 6. No pole/option is ever a slur, a stereotype, or a deficit, and no pair requires
 *    the user to rank groups against each other.
 *
 * Deliberately absent: ability/disability, socioeconomic class, and immigration status.
 * All three are genuinely cultural and Chao & Moon's framework would admit them (they
 * mention socioeconomic status), but each needs more careful treatment than a two-word
 * antonym pair can give, and a mis-framed pair here is the most likely thing to go
 * badly wrong. This omission is a scope decision, and is worth naming as one.
 *
 * `mix` is the hue at slider centre, L1-normalized as (Demographic, Geographic,
 * Associative). `immutability` is the authored default; users can override it per pair.
 *
 * ---------------------------------------------------------------------------
 * SKEW SIGN CONVENTION -- read this before editing any `skew`.
 * ---------------------------------------------------------------------------
 *
 * Effective hue is  L1norm(max(0, mix + lean * skew)),  with lean = -1 at pole A and
 * +1 at pole B. So:
 *
 *     poleA hue = mix - skew        poleB hue = mix + skew
 *
 * `skew` is therefore THE SHIFT TOWARD POLE B, not the shift at pole A.
 *
 * Consequence, and the thing to check when authoring: if pole A is the more
 * inherited/given reading, then `skew[0]` (the Demographic component) must be
 * NEGATIVE. Getting this backwards is not a cosmetic error -- it places "Family is who
 * I was born to" in the Associative sector and "Family is who I chose" in the
 * Demographic sector, inverting the geometry that the whole layout is meant to express,
 * while still producing plausible-looking art. Every skew below has been audited
 * against its pole wording, and `polar.test.ts` asserts the intended direction pair by
 * pair so a future edit cannot silently flip one.
 */

// prettier-ignore
export const LIBRARY: readonly WordPair[] = Object.freeze([

  // =========================================================================
  // DEMOGRAPHIC (7) -- "Physical characteristics and social identities inherited
  // from parents and ancestors"
  // =========================================================================

  // --- Age (2) -------------------------------------------------------------
  // The paper's basis: "sociocultural and sociohistorical perspectives can shape
  // different values as an individual ages" (p. 1130).
  { id: 'D-AGE-01', source: 'library', category: 'demographic', facet: 'age',
    poleA: "Shaped by my generation's era", poleB: 'Out of step with my generation',
    mix: [1.00, 0, 0], immutability: 0.95,
    note: 'Birth cohort as a formative fact -- the sociohistorical perspective. '
      + 'Complements ANCH-D-02, the raw birth-decade fact.' },
  { id: 'D-AGE-05', source: 'library', category: 'demographic', facet: 'age',
    poleA: 'Age earns standing', poleB: 'Merit earns standing',
    mix: [0.60, 0, 0.40], skew: [-0.25, 0, 0.25], immutability: 0.50 },

  // --- Ethnicity (2) ---------------------------------------------------------
  { id: 'D-ETH-01', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Ancestral heritage is central to me', poleB: 'Heritage is background, not identity',
    mix: [1.00, 0, 0], immutability: 0.85,
    note: 'Identity centrality, not heritage content.' },
  { id: 'D-ETH-03', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Keep ancestral customs distinct', poleB: 'Blend customs into one shared life',
    mix: [0.60, 0, 0.40], skew: [-0.25, 0, 0.25], immutability: 0.45,
    note: "Roccas & Brewer's dominant-vs-hybrid axis, stated as a first-person preference." },

  // --- Gender (1) --------------------------------------------------------
  // The paper's basis is Maltz & Borker's gender-as-culture hypothesis (p. 1130), which
  // is about learned interactional style, not sex. Every pole here is available to
  // anyone.
  { id: 'D-GEN-01', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Gendered expectations shaped my path', poleB: 'Gender has been incidental to my path',
    mix: [1.00, 0, 0], immutability: 0.90,
    note: 'Expectations, not the fact itself -- ANCH-D-01 asks the raw assigned-sex fact.' },

  // --- Race (2) ----------------------------------------------------------
  // Framed entirely as experience of, and orientation toward, race as a social
  // identity. Grounded in the paper's own citations: Markus & Kitayama's
  // independent/interdependent self and Gaines et al. on collectivism (p. 1130).
  { id: 'D-RAC-02', source: 'library', category: 'demographic', facet: 'race',
    poleA: 'I am my relationships (interdependent)', poleB: 'I am my own unit (independent)',
    mix: [0.50, 0, 0.50], skew: [0.20, 0, -0.20], immutability: 0.55,
    note: "The paper's individualism/collectivism axis. Sits at exactly (0.5, 0, 0.5), so it "
      + 'lands at theta = 0 deg -- the Demographic/Associative boundary. Perfect magenta, '
      + '"Affinity Groups". This is the canonical blended pair; use it as the worked example.' },
  { id: 'D-RAC-03', source: 'library', category: 'demographic', facet: 'race',
    poleA: 'Difference should be named', poleB: 'Difference should be downplayed',
    mix: [0.70, 0, 0.30], immutability: 0.50,
    risky: 'Could look like asking users to endorse or reject anti-racism. Kept because '
      + 'colour-conscious vs colour-evasive orientation is a well-established construct, both '
      + 'poles are held sincerely in good faith, and neither is phrased as hostility. Also one '
      + 'of the most informative pairs in the model.' },

  // =========================================================================
  // GEOGRAPHIC (7) -- "Natural or man-made physical features of a region that can
  // shape group identities"
  // =========================================================================

  // --- Climate (1) -------------------------------------------------------
  // The paper cites Hofstede on latitude/climate/values and Diamond on resource ecology.
  { id: 'G-CLI-01', source: 'library', category: 'geographic', facet: 'climate',
    poleA: 'Four hard seasons made me', poleB: 'One steady season made me',
    mix: [0.15, 0.85, 0], immutability: 0.75 },

  // --- Temperature (1) ---------------------------------------------------
  { id: 'G-TMP-01', source: 'library', category: 'geographic', facet: 'temperature',
    poleA: 'I am built for cold', poleB: 'I am built for heat',
    mix: [0.20, 0.80, 0], immutability: 0.70 },

  // --- Coastal / inland (1) ------------------------------------------------
  { id: 'G-CST-01', source: 'library', category: 'geographic', facet: 'coastal-inland',
    poleA: 'Water is my horizon', poleB: 'Land is my horizon',
    mix: [0.10, 0.90, 0], immutability: 0.85 },

  // --- Urban / rural (2) -------------------------------------------------
  // The paper's Erez & Earley kibbutz finding and Berry's conformity/independence contrast.
  { id: 'G-URB-01', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Raised where neighbors are close', poleB: 'Raised where neighbors are far',
    mix: [0.10, 0.90, 0], immutability: 0.85 },
  { id: 'G-URB-05', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Institutions are near and trusted', poleB: 'Institutions are far and doubted',
    mix: [0, 0.50, 0.50], immutability: 0.45,
    note: 'The canonical cyan exemplar: (0, 0.5, 0.5) lands at theta = 240 deg, exactly the '
      + 'Geographic/Associative boundary -- "Localized Communities: groups and institutions '
      + 'defined by physical place".' },

  // --- Regional / country (2) ----------------------------------------------
  { id: 'G-REG-01', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: "Where I was born is where I'm from", poleB: "Where I chose is where I'm from",
    mix: [0.30, 0.70, 0], skew: [0, -0.15, 0.15], immutability: 1.00,
    note: 'The birthplace anchor, and a genuine bipolar spectrum (rootedness vs '
      + 'self-determination of place) rather than a data-entry field. Complements '
      + 'ANCH-G-01, the raw left-home-country fact.' },
  { id: 'G-REG-06', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'Homeland is a place I can return to', poleB: 'Homeland is a memory',
    mix: [0.25, 0.70, 0.05], immutability: 0.75,
    note: 'Deliberately phrased so displacement and diaspora are represented with dignity '
      + 'rather than as a deficit.' },

  // =========================================================================
  // ASSOCIATIVE (7) -- "Formal and informal groups that an individual chooses to
  // associate and identify with"
  // =========================================================================

  // --- Family (2) --------------------------------------------------------
  // The paper's Chen (2001) filial-piety and family-business material.
  { id: 'A-FAM-01', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Family is the unit of decision', poleB: 'The individual is the unit of decision',
    mix: [0.35, 0, 0.65], skew: [0.15, 0, -0.15], immutability: 0.55 },
  { id: 'A-FAM-03', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Family is who I was born to', poleB: 'Family is who I chose',
    mix: [0.45, 0, 0.55], skew: [-0.30, 0, 0.30], immutability: 0.50,
    note: 'The largest skew in the library. At pole A the hue is (0.75, 0, 0.25) -- near-red, '
      + 'inherited kin; at pole B (0.15, 0, 0.85) -- near-blue, chosen kin. Two people who '
      + 'answer only this pair, oppositely, get nodes ~100 deg apart with different hues. '
      + 'This is the mechanism by which slider position produces STRUCTURALLY different art, '
      + 'not merely recoloured art.' },

  // --- Employer (1) --------------------------------------------------------
  { id: 'A-EMP-02', source: 'library', category: 'associative', facet: 'employer',
    poleA: 'Loyalty to one organization', poleB: 'Loyalty to my own trajectory',
    mix: [0.10, 0, 0.90], immutability: 0.35,
    note: 'Skew-less by design -- the reference pair for "no skew moves the hue" tests. '
      + 'Complements ANCH-A-05, the raw ever-employed fact.' },

  // --- Profession (1) ------------------------------------------------------
  { id: 'A-PRO-01', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'My craft is who I am', poleB: 'My craft is what I do',
    mix: [0.10, 0, 0.90], immutability: 0.50 },

  // --- Politics (1) --------------------------------------------------------
  // Value orientations only. Named parties are deliberately absent (rule 5).
  { id: 'A-POL-03', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Decide close to home', poleB: 'Decide at the largest scale',
    mix: [0, 0.40, 0.60], skew: [0, -0.20, 0.20], immutability: 0.40 },

  // --- Avocations (2) ------------------------------------------------------
  // Deliberately the lowest immutability band. These are the load points.
  { id: 'A-AVO-02', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Make things', poleB: 'Take things in',
    mix: [0.05, 0, 0.95], immutability: 0.20 },
  { id: 'A-AVO-04', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Join a club', poleB: 'Go alone',
    mix: [0, 0.10, 0.90], immutability: 0.15 },
] satisfies readonly WordPair[])

/**
 * Authored antagonisms: long-range value conflicts that purely-local, hue-based
 * concordance cannot express, because the two poles in tension can land anywhere on
 * the disc. See boundary.ts for how these become a self-equilibrated tensile load, and
 * layout/fields.ts for how the same engagement also weakens both tiles' own stiffness
 * (destructive interference) once BOTH poles are actually leaned into.
 */
export const ANTAGONISMS: readonly Antagonism[] = Object.freeze([
  { a: 'A-FAM-01', aPole: -1, b: 'D-RAC-02', bPole: 1, weight: 0.70,
    why: 'Family as the decision unit vs the self as its own independent unit.' },
  { a: 'A-EMP-02', aPole: -1, b: 'A-PRO-01', bPole: -1, weight: 0.30,
    why: 'Loyalty to one organization vs craft-identity that transcends any employer.' },
  { a: 'D-ETH-03', aPole: -1, b: 'D-RAC-03', bPole: 1, weight: 0.60,
    why: 'Keeping ancestral customs distinct vs downplaying difference.' },
  { a: 'G-REG-01', aPole: -1, b: 'A-FAM-03', bPole: 1, weight: 0.35,
    why: 'Rootedness of birth vs family as chosen -- inherited vs elected belonging.' },
  { a: 'D-ETH-01', aPole: -1, b: 'D-ETH-03', bPole: 1, weight: 0.40,
    why: 'Heritage as central vs blending customs into one shared life.' },
  { a: 'A-FAM-01', aPole: -1, b: 'A-POL-03', bPole: 1, weight: 0.30,
    why: 'Family as the final decision-making unit vs authority centralized at the largest scale.' },
] satisfies readonly Antagonism[])

/** Fast lookup. Built once; the library never changes at runtime. */
export const LIBRARY_BY_ID: ReadonlyMap<string, WordPair> = new Map(
  LIBRARY.map((p) => [p.id, p]),
)

// ---------------------------------------------------------------------------
// ANCHORS -- single-choice facts. See the module doc comment above for what
// distinguishes these from LIBRARY, and docs/Anchor Question Pairs.txt for the
// user's original draft this was authored from.
//
// Category/facet placement follows the APP's existing taxonomy, not the draft's own
// grouping, where the two differ: a fact anchors whichever category it actually
// pins for this model (e.g. raising a child and holding a second citizenship are
// chosen-but-permanent, so they anchor Associative here, matching A-FAM-03 and
// A-STA-02's reasoning before them) rather than the category it would occupy in an
// inherited-vs-chosen sense generically. Associative ends up with more anchors (5)
// than Demographic or Geographic (3 each) -- the same reason IRREVERSIBLE_FACETS
// exists in taxonomy.ts: only permanent facts can anchor a category defined by
// ongoing choice, so it structurally needs more of them.
// ---------------------------------------------------------------------------

// prettier-ignore
export const ANCHORS: readonly AnchorPair[] = Object.freeze([

  // --- Demographic (3) -----------------------------------------------------
  { id: 'ANCH-D-01', category: 'demographic', facet: 'gender',
    prompt: 'Assigned sex at birth',
    options: [
      { id: 'male', label: 'Male', hue: [1, 0, 0] },
      { id: 'female', label: 'Female', hue: [1, 0, 0] },
    ],
    immutability: 0.95,
    note: 'The raw fact. D-GEN-01 asks about gendered EXPECTATIONS instead -- a distinct, '
      + 'bipolar orientation question, not a replacement for this one.' },
  { id: 'ANCH-D-02', category: 'demographic', facet: 'age',
    prompt: 'Decade you were born',
    options: [
      { id: '1950s', label: '1950s', hue: [1, 0, 0] },
      { id: '1960s', label: '1960s', hue: [1, 0, 0] },
      { id: '1970s', label: '1970s', hue: [1, 0, 0] },
      { id: '1980s', label: '1980s', hue: [1, 0, 0] },
      { id: '1990s', label: '1990s', hue: [1, 0, 0] },
      { id: '2000s', label: '2000s', hue: [1, 0, 0] },
      { id: '2010s', label: '2010s', hue: [1, 0, 0] },
    ],
    immutability: 1.00,
    note: 'Genuinely multi-way rather than forced into a binary, since a decade is one of '
      + 'several, not one of two. If profiles are ever compared across people, this is the '
      + 'one place a coarser "same cohort / different cohort" binary would be a faithful '
      + 'simplification rather than a distortion.' },
  { id: 'ANCH-D-03', category: 'demographic', facet: 'ethnicity',
    prompt: 'Heritage background',
    options: [
      { id: 'multiple', label: 'Multiple heritages', hue: [0.60, 0, 0.40] },
      { id: 'single', label: 'One heritage', hue: [0.85, 0, 0.15] },
    ],
    immutability: 0.60,
    note: 'Heritage plurality as a fact (how many backgrounds), not which ones -- the same '
      + 'restraint D-ETH-01/D-ETH-03 already use, applied to a yes/no question instead of a '
      + 'centrality one.' },

  // --- Geographic (3) --------------------------------------------------------
  { id: 'ANCH-G-01', category: 'geographic', facet: 'regional-country',
    prompt: 'Has left their home country',
    options: [
      { id: 'left', label: 'Has left their home country', hue: [0.20, 0.65, 0.15] },
      { id: 'never-left', label: 'Has never left their home country', hue: [0.30, 0.70, 0] },
    ],
    immutability: 0.90,
    note: 'The raw fact alongside G-REG-01\'s rootedness-vs-self-determination orientation.' },
  { id: 'ANCH-G-02', category: 'geographic', facet: 'urban-rural',
    prompt: 'Has bought a home',
    options: [
      { id: 'bought', label: 'Has bought a home', hue: [0.05, 0.75, 0.20] },
      { id: 'never-bought', label: 'Has never bought a home', hue: [0.10, 0.90, 0] },
    ],
    immutability: 0.55 },
  { id: 'ANCH-G-03', category: 'geographic', facet: 'urban-rural',
    prompt: 'Has lived both urban and rural',
    options: [
      { id: 'both', label: 'Has lived both urban and rural', hue: [0.05, 0.85, 0.10] },
      { id: 'one', label: 'Has always lived one or the other', hue: [0.10, 0.90, 0] },
    ],
    immutability: 0.45 },

  // --- Associative (5) -------------------------------------------------------
  //
  // Beyond Chao & Moon's Table 1; see IRREVERSIBLE_FACETS in taxonomy.ts for the
  // argument. These replace what used to be spectrum-shaped pairs standing in for
  // facts (A-LIF-02, A-STA-02, A-EMB-01) with the fact itself, now that a genuine
  // fact-type question exists to ask it with.
  { id: 'ANCH-A-01', category: 'associative', facet: 'life-events',
    prompt: 'Has raised a child',
    options: [
      { id: 'raised', label: 'Has raised a child', hue: [0, 0, 1] },
      { id: 'not-raised', label: 'No child has depended on them', hue: [0, 0, 1] },
    ],
    immutability: 0.85,
    note: 'The Associative sector\'s cleanest rim anchor: pure hue, nothing pulls it inward. '
      + 'Replaces A-LIF-02.' },
  { id: 'ANCH-A-02', category: 'associative', facet: 'standing',
    prompt: 'Citizen of another country',
    options: [
      { id: 'other-citizen', label: 'Is a citizen of another country', hue: [0, 0.30, 0.70] },
      { id: 'one-citizen', label: 'Is only a citizen of one country', hue: [0, 0.60, 0.40] },
    ],
    immutability: 0.90,
    note: 'Chosen, permanent, and genuinely both associative and geographic -- a citizenship '
      + 'is a formal affiliation and a place at once. Replaces A-STA-02, keeping its hue split '
      + 'between the two options.' },
  { id: 'ANCH-A-03', category: 'associative', facet: 'embodied',
    prompt: 'Has broken a bone',
    options: [
      { id: 'broken', label: 'Has broken a bone', hue: [0.20, 0, 0.80] },
      { id: 'never-broken', label: 'Has never broken a bone', hue: [0.20, 0, 0.80] },
    ],
    immutability: 0.55,
    note: 'Replaces A-EMB-01. The earlier spectrum framing ("body changed what I can do") was '
      + 'a generalization away from the literal fact, made because a healed break does not '
      + 'usually change how someone lives -- true for an orientation question, but beside the '
      + 'point for an anchor, which only needs the fact to be permanent, not ongoing.' },
  { id: 'ANCH-A-04', category: 'associative', facet: 'religion',
    prompt: 'Joined a formal religious tradition',
    options: [
      { id: 'joined', label: 'Has joined a formal religious tradition', hue: [0.10, 0, 0.90] },
      { id: 'not-joined', label: 'Has not joined a formal religious tradition', hue: [0.10, 0, 0.90] },
    ],
    immutability: 0.70,
    note: 'Membership as a fact. Names no tradition, matching rule 5.' },
  { id: 'ANCH-A-05', category: 'associative', facet: 'employer',
    prompt: 'Been formally employed',
    options: [
      { id: 'employed', label: 'Has been formally employed', hue: [0.05, 0, 0.95] },
      { id: 'never-employed', label: 'Has not been formally employed', hue: [0.05, 0, 0.95] },
    ],
    immutability: 0.55 },
] satisfies readonly AnchorPair[])

/** Fast lookup. Built once; the anchor set never changes at runtime. */
export const ANCHOR_BY_ID: ReadonlyMap<string, AnchorPair> = new Map(
  ANCHORS.map((a) => [a.id, a]),
)
