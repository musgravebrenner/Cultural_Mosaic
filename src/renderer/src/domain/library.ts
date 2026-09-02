import type { WordPair, Antagonism } from './types'

/**
 * The seeded word-pair library: 79 bipolar orientation spectrums grouped under
 * Chao & Moon (2005) Table 1's fifteen sample tiles.
 *
 * THIS IS THE ONLY PLACE THE MODEL'S SOCIOLOGICAL CONTENT LIVES. Everything else in
 * the app is mechanism.
 *
 * ---------------------------------------------------------------------------
 * Authoring rules, in priority order. These are the defensible part; state them in
 * any writeup.
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
 *    against. This is fidelity to the source, not merely politeness.
 *
 * 2. Both poles must be a dignified, inhabitable identity. No pole may read as the
 *    absence or deficit of the other: `Faith orders my life <-> Reason orders my life`,
 *    never `Religious <-> Not religious`. Test: would a person at this pole describe
 *    themselves this way with pride?
 *
 * 3. Immutable facts enter as CENTRALITY, not content. The physics needs pinned rim
 *    nodes for birth facts, so rather than asking "what is your birth sex", the pair
 *    asks how much that fact organizes the self-concept -- identity centrality, a real
 *    construct, and genuinely bipolar. That is how you get an immutability-1.0 anchor
 *    without asserting that a demographic fact implies a value.
 *
 * 4. `immutability` is a claim about SOCIAL fixity, not biology. Defined in the UI as:
 *    how much could you change this by a decision this year? Race scores high not
 *    because it is biological but because a person cannot decide out of how they are
 *    read. Say this in the UI copy; it is a one-sentence inoculation against the
 *    obvious objection.
 *
 * 5. Politics and religion stay at the level of value orientations, never institutions
 *    or parties. Otherwise the artwork becomes a partisan statement and the FEA is put
 *    in the position of computing that two faiths are structurally discordant.
 *
 * 6. No pole is ever a slur, a stereotype, or a deficit, and no pair requires the user
 *    to rank groups against each other.
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
  // DEMOGRAPHIC (21) -- "Physical characteristics and social identities inherited
  // from parents and ancestors"
  // =========================================================================

  // --- Age (6) -----------------------------------------------------------
  // The paper's basis: "sociocultural and sociohistorical perspectives can shape
  // different values as an individual ages" (p. 1130).
  { id: 'D-AGE-01', source: 'library', category: 'demographic', facet: 'age',
    poleA: "Shaped by my generation's era", poleB: 'Out of step with my generation',
    mix: [1.00, 0, 0], immutability: 0.95,
    note: 'Birth cohort as a formative fact -- the sociohistorical perspective.' },
  { id: 'D-AGE-02', source: 'library', category: 'demographic', facet: 'age',
    poleA: "Elders' judgment guides me", poleB: 'Each generation decides anew',
    mix: [0.70, 0, 0.30], skew: [-0.20, 0, 0.20], immutability: 0.55 },
  { id: 'D-AGE-03', source: 'library', category: 'demographic', facet: 'age',
    poleA: 'Still becoming', poleB: 'Settled into who I am',
    mix: [0.85, 0, 0.15], immutability: 0.30 },
  { id: 'D-AGE-04', source: 'library', category: 'demographic', facet: 'age',
    poleA: 'I look to the past for direction', poleB: 'I look to the future for direction',
    mix: [0.80, 0, 0.20], immutability: 0.40 },
  { id: 'D-AGE-05', source: 'library', category: 'demographic', facet: 'age',
    poleA: 'Age earns standing', poleB: 'Merit earns standing',
    mix: [0.60, 0, 0.40], skew: [-0.25, 0, 0.25], immutability: 0.50 },
  { id: 'D-AGE-06', source: 'library', category: 'demographic', facet: 'age',
    poleA: 'Comfortable with how I was raised', poleB: 'Deliberately raised myself differently',
    mix: [0.75, 0, 0.25], immutability: 0.60 },

  // --- Ethnicity (5) -----------------------------------------------------
  { id: 'D-ETH-01', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Ancestral heritage is central to me', poleB: 'Heritage is background, not identity',
    mix: [1.00, 0, 0], immutability: 0.85,
    note: 'Identity centrality, not heritage content.' },
  { id: 'D-ETH-02', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'My heritage language is my voice', poleB: 'One shared common language is enough',
    mix: [0.70, 0, 0.30], skew: [-0.15, 0, 0.15], immutability: 0.55 },
  { id: 'D-ETH-03', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Keep ancestral customs distinct', poleB: 'Blend customs into one shared life',
    mix: [0.60, 0, 0.40], skew: [-0.25, 0, 0.25], immutability: 0.45,
    note: "Roccas & Brewer's dominant-vs-hybrid axis, stated as a first-person preference." },
  { id: 'D-ETH-04', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Named for my lineage', poleB: 'Named for myself',
    mix: [0.85, 0, 0.15], immutability: 0.70 },
  { id: 'D-ETH-05', source: 'library', category: 'demographic', facet: 'ethnicity',
    poleA: 'Food and holidays carry my heritage', poleB: 'Food and holidays are just pleasure',
    mix: [0.55, 0.15, 0.30], immutability: 0.40 },

  // --- Gender (5) --------------------------------------------------------
  // The paper's basis is Maltz & Borker's gender-as-culture hypothesis (p. 1130), which
  // is about learned interactional style, not sex. Every pair here is style or
  // expectation, and every pole is available to anyone.
  { id: 'D-GEN-01', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Gendered expectations shaped my path', poleB: 'Gender has been incidental to my path',
    mix: [1.00, 0, 0], immutability: 0.90 },
  { id: 'D-GEN-02', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Provide and protect', poleB: 'Nurture and sustain',
    mix: [0.70, 0, 0.30], immutability: 0.45,
    risky: 'Could read as a male/female stereotype pair. Kept because it carries the value '
      + 'content the paper cites and assigns neither pole to a sex. REQUIRES the tile header '
      + '"Gendered expectations -- not gender itself" and the note that both poles are open '
      + 'to everyone. Without that copy, cut it.' },
  { id: 'D-GEN-03', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Roles in my home follow tradition', poleB: 'Roles in my home are negotiated',
    mix: [0.50, 0, 0.50], skew: [-0.20, 0, 0.20], immutability: 0.35 },
  { id: 'D-GEN-04', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Directness is respect', poleB: 'Indirectness is respect',
    mix: [0.60, 0, 0.40], immutability: 0.50 },
  { id: 'D-GEN-05', source: 'library', category: 'demographic', facet: 'gender',
    poleA: 'Same-gender spaces feel like home', poleB: 'Mixed spaces feel like home',
    mix: [0.55, 0, 0.45], immutability: 0.35 },

  // --- Race (5) ----------------------------------------------------------
  // Framed entirely as experience of, and orientation toward, race as a social
  // identity. Grounded in the paper's own citations: Markus & Kitayama's
  // independent/interdependent self and Gaines et al. on collectivism (p. 1130).
  { id: 'D-RAC-01', source: 'library', category: 'demographic', facet: 'race',
    poleA: 'My race shapes how the world reads me', poleB: 'My race rarely shapes my day',
    mix: [1.00, 0, 0], immutability: 0.80 },
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
  { id: 'D-RAC-04', source: 'library', category: 'demographic', facet: 'race',
    poleA: "I carry my community's reputation", poleB: 'I represent only myself',
    mix: [0.60, 0, 0.40], skew: [0.20, 0, -0.20], immutability: 0.55 },
  { id: 'D-RAC-05', source: 'library', category: 'demographic', facet: 'race',
    poleA: 'Trust starts with shared background', poleB: 'Trust starts with shared conduct',
    mix: [0.60, 0, 0.40], immutability: 0.50 },

  // =========================================================================
  // GEOGRAPHIC (24) -- "Natural or man-made physical features of a region that can
  // shape group identities"
  // =========================================================================

  // --- Climate (4) -------------------------------------------------------
  // The paper cites Hofstede on latitude/climate/values and Diamond on resource ecology.
  { id: 'G-CLI-01', source: 'library', category: 'geographic', facet: 'climate',
    poleA: 'Four hard seasons made me', poleB: 'One steady season made me',
    mix: [0.15, 0.85, 0], immutability: 0.75 },
  { id: 'G-CLI-02', source: 'library', category: 'geographic', facet: 'climate',
    poleA: 'Weather dictates my plans', poleB: 'I plan regardless of weather',
    mix: [0, 0.90, 0.10], immutability: 0.40 },
  { id: 'G-CLI-03', source: 'library', category: 'geographic', facet: 'climate',
    poleA: 'Long dark winters are normal', poleB: 'Long bright days are normal',
    mix: [0.10, 0.90, 0], immutability: 0.80 },
  { id: 'G-CLI-04', source: 'library', category: 'geographic', facet: 'climate',
    poleA: 'Scarcity taught me to store', poleB: 'Abundance taught me to share',
    mix: [0.10, 0.70, 0.20], immutability: 0.60 },

  // --- Temperature (3) ---------------------------------------------------
  { id: 'G-TMP-01', source: 'library', category: 'geographic', facet: 'temperature',
    poleA: 'I am built for cold', poleB: 'I am built for heat',
    mix: [0.20, 0.80, 0], immutability: 0.70 },
  { id: 'G-TMP-02', source: 'library', category: 'geographic', facet: 'temperature',
    poleA: 'Heat slows the day; rest is right', poleB: 'Cold structures the day; schedule is right',
    mix: [0, 0.80, 0.20], immutability: 0.45 },
  { id: 'G-TMP-03', source: 'library', category: 'geographic', facet: 'temperature',
    poleA: 'Life happens outdoors', poleB: 'Life happens indoors',
    mix: [0, 0.85, 0.15], immutability: 0.40 },

  // --- Coastal / inland (4) ----------------------------------------------
  { id: 'G-CST-01', source: 'library', category: 'geographic', facet: 'coastal-inland',
    poleA: 'Water is my horizon', poleB: 'Land is my horizon',
    mix: [0.10, 0.90, 0], immutability: 0.85 },
  { id: 'G-CST-02', source: 'library', category: 'geographic', facet: 'coastal-inland',
    poleA: 'Ports bring the world to me', poleB: 'The interior keeps its own counsel',
    mix: [0, 0.75, 0.25], immutability: 0.55 },
  { id: 'G-CST-03', source: 'library', category: 'geographic', facet: 'coastal-inland',
    poleA: 'Livelihood came from the water', poleB: 'Livelihood came from the ground',
    mix: [0.10, 0.60, 0.30], immutability: 0.65 },
  { id: 'G-CST-04', source: 'library', category: 'geographic', facet: 'coastal-inland',
    poleA: 'Travel means crossing water', poleB: 'Travel means crossing distance',
    mix: [0, 0.90, 0.10], immutability: 0.45 },

  // --- Urban / rural (6) -------------------------------------------------
  // The paper's Erez & Earley kibbutz finding and Berry's conformity/independence contrast.
  { id: 'G-URB-01', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Raised where neighbors are close', poleB: 'Raised where neighbors are far',
    mix: [0.10, 0.90, 0], immutability: 0.85 },
  { id: 'G-URB-02', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Density is energy', poleB: 'Space is peace',
    mix: [0, 0.90, 0.10], immutability: 0.45 },
  { id: 'G-URB-03', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Call a professional', poleB: 'Fix it myself',
    mix: [0, 0.60, 0.40], immutability: 0.40 },
  { id: 'G-URB-04', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Anonymity is freedom', poleB: 'Being known is safety',
    mix: [0.10, 0.50, 0.40], immutability: 0.40 },
  { id: 'G-URB-05', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Institutions are near and trusted', poleB: 'Institutions are far and doubted',
    mix: [0, 0.50, 0.50], immutability: 0.45,
    note: 'The canonical cyan exemplar: (0, 0.5, 0.5) lands at theta = 240 deg, exactly the '
      + 'Geographic/Associative boundary -- "Localized Communities: groups and institutions '
      + 'defined by physical place".' },
  { id: 'G-URB-06', source: 'library', category: 'geographic', facet: 'urban-rural',
    poleA: 'Walking distance is enough', poleB: 'Driving distance is normal',
    mix: [0, 0.95, 0.05], immutability: 0.35 },

  // --- Regional / country (7) --------------------------------------------
  { id: 'G-REG-01', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: "Where I was born is where I'm from", poleB: "Where I chose is where I'm from",
    mix: [0.30, 0.70, 0], skew: [0, -0.15, 0.15], immutability: 1.00,
    note: 'The birthplace anchor, and a genuine bipolar spectrum (rootedness vs '
      + 'self-determination of place) rather than a data-entry field.' },
  { id: 'G-REG-02', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'One country claims me', poleB: 'More than one country claims me',
    mix: [0.35, 0.65, 0], immutability: 0.80 },
  { id: 'G-REG-03', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'My region differs from my country', poleB: 'My region is my country in miniature',
    mix: [0.15, 0.85, 0], immutability: 0.70 },
  { id: 'G-REG-04', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'Borders are meaningful', poleB: 'Borders are administrative',
    mix: [0, 0.60, 0.40], immutability: 0.50 },
  { id: 'G-REG-05', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'I have stayed', poleB: 'I have moved often',
    mix: [0.10, 0.80, 0.10], immutability: 0.65 },
  { id: 'G-REG-06', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'Homeland is a place I can return to', poleB: 'Homeland is a memory',
    mix: [0.25, 0.70, 0.05], immutability: 0.75,
    note: 'Deliberately phrased so displacement and diaspora are represented with dignity '
      + 'rather than as a deficit.' },
  { id: 'G-REG-07', source: 'library', category: 'geographic', facet: 'regional-country',
    poleA: 'Local dialect is my voice', poleB: 'Standard speech is my voice',
    mix: [0.20, 0.75, 0.05], immutability: 0.55 },

  // =========================================================================
  // ASSOCIATIVE (34) -- "Formal and informal groups that an individual chooses to
  // associate and identify with"
  // =========================================================================

  // --- Family (6) --------------------------------------------------------
  // The paper's Chen (2001) filial-piety and family-business material.
  { id: 'A-FAM-01', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Family is the unit of decision', poleB: 'The individual is the unit of decision',
    mix: [0.35, 0, 0.65], skew: [0.15, 0, -0.15], immutability: 0.55 },
  { id: 'A-FAM-02', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Obligation to kin comes first', poleB: 'Obligation to self comes first',
    mix: [0.30, 0, 0.70], immutability: 0.55 },
  { id: 'A-FAM-03', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Family is who I was born to', poleB: 'Family is who I chose',
    mix: [0.45, 0, 0.55], skew: [-0.30, 0, 0.30], immutability: 0.50,
    note: 'The largest skew in the library. At pole A the hue is (0.75, 0, 0.25) -- near-red, '
      + 'inherited kin; at pole B (0.15, 0, 0.85) -- near-blue, chosen kin. Two people who '
      + 'answer only this pair, oppositely, get nodes ~100 deg apart with different hues. '
      + 'This is the mechanism by which slider position produces STRUCTURALLY different art, '
      + 'not merely recoloured art.' },
  { id: 'A-FAM-04', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Generations under one roof', poleB: 'Each household on its own',
    mix: [0.25, 0.15, 0.60], immutability: 0.45 },
  { id: 'A-FAM-05', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Keep the peace', poleB: 'Say the truth',
    mix: [0.20, 0, 0.80], immutability: 0.35 },
  { id: 'A-FAM-06', source: 'library', category: 'associative', facet: 'family',
    poleA: 'Traditions must be kept exactly', poleB: 'Traditions should be adapted',
    mix: [0.30, 0, 0.70], immutability: 0.40 },

  // --- Religion (6) ------------------------------------------------------
  // Value orientations only. Named faiths are deliberately absent (rule 5).
  { id: 'A-REL-01', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'Faith orders my life', poleB: 'Reason orders my life',
    mix: [0.15, 0, 0.85], immutability: 0.60 },
  { id: 'A-REL-02', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'Practice with a community', poleB: 'Practice alone',
    mix: [0, 0.15, 0.85], immutability: 0.45 },
  { id: 'A-REL-03', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'I inherited my tradition', poleB: 'I found my own tradition',
    mix: [0.40, 0, 0.60], skew: [-0.30, 0, 0.30], immutability: 0.55 },
  { id: 'A-REL-04', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'Ritual and calendar shape my year', poleB: 'Work and season shape my year',
    mix: [0.10, 0.25, 0.65], immutability: 0.45 },
  { id: 'A-REL-05', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'Meaning is given', poleB: 'Meaning is made',
    mix: [0.15, 0, 0.85], immutability: 0.50 },
  { id: 'A-REL-06', source: 'library', category: 'associative', facet: 'religion',
    poleA: 'Moral rules are fixed', poleB: 'Moral rules are contextual',
    mix: [0.20, 0, 0.80], immutability: 0.50 },

  // --- Employer (5) ------------------------------------------------------
  { id: 'A-EMP-01', source: 'library', category: 'associative', facet: 'employer',
    poleA: 'My workplace is a community', poleB: 'My workplace is a contract',
    mix: [0, 0.10, 0.90], immutability: 0.35 },
  { id: 'A-EMP-02', source: 'library', category: 'associative', facet: 'employer',
    poleA: 'Loyalty to one organization', poleB: 'Loyalty to my own trajectory',
    mix: [0.10, 0, 0.90], immutability: 0.35 },
  { id: 'A-EMP-03', source: 'library', category: 'associative', facet: 'employer',
    poleA: "The team's credit", poleB: 'My own credit',
    mix: [0.25, 0, 0.75], immutability: 0.30 },
  { id: 'A-EMP-04', source: 'library', category: 'associative', facet: 'employer',
    poleA: 'Hierarchy clarifies', poleB: 'Flat structures free',
    mix: [0.15, 0, 0.85], immutability: 0.35 },
  { id: 'A-EMP-05', source: 'library', category: 'associative', facet: 'employer',
    poleA: 'Work is where I live', poleB: 'Work funds where I live',
    mix: [0, 0.20, 0.80], immutability: 0.30 },

  // --- Profession (6) ----------------------------------------------------
  { id: 'A-PRO-01', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'My craft is who I am', poleB: 'My craft is what I do',
    mix: [0.10, 0, 0.90], immutability: 0.50 },
  { id: 'A-PRO-02', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'Trained by school', poleB: 'Trained by doing',
    mix: [0.15, 0.10, 0.75], immutability: 0.60 },
  { id: 'A-PRO-03', source: 'library', category: 'associative', facet: 'profession',
    poleA: "My field's standards govern me", poleB: 'My own judgment governs me',
    mix: [0.05, 0, 0.95], immutability: 0.50 },
  { id: 'A-PRO-04', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'Work with people', poleB: 'Work with things',
    mix: [0.20, 0.10, 0.70], immutability: 0.45 },
  { id: 'A-PRO-05', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'Field inherited from family', poleB: 'Field chosen against the grain',
    mix: [0.40, 0, 0.60], skew: [-0.30, 0, 0.30], immutability: 0.55 },
  { id: 'A-PRO-06', source: 'library', category: 'associative', facet: 'profession',
    poleA: 'Specialist depth', poleB: 'Generalist breadth',
    mix: [0.10, 0, 0.90], immutability: 0.45 },

  // --- Politics (5) ------------------------------------------------------
  // Value orientations only. Named parties are deliberately absent (rule 5).
  { id: 'A-POL-01', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Order preserves freedom', poleB: 'Change secures freedom',
    mix: [0.20, 0, 0.80], immutability: 0.40 },
  { id: 'A-POL-02', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Responsibility is individual', poleB: 'Responsibility is shared',
    mix: [0.30, 0, 0.70], immutability: 0.40 },
  { id: 'A-POL-03', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Decide close to home', poleB: 'Decide at the largest scale',
    mix: [0, 0.40, 0.60], skew: [0, -0.20, 0.20], immutability: 0.40 },
  { id: 'A-POL-04', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Speak up publicly', poleB: 'Work quietly',
    mix: [0.10, 0, 0.90], immutability: 0.30 },
  { id: 'A-POL-05', source: 'library', category: 'associative', facet: 'politics',
    poleA: 'Tradition is evidence', poleB: 'Evidence overrides tradition',
    mix: [0.30, 0, 0.70], skew: [-0.20, 0, 0.20], immutability: 0.45 },

  // --- Avocations (6) ----------------------------------------------------
  // Deliberately the lowest immutability band. These are the load points.
  { id: 'A-AVO-01', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Recreation outdoors', poleB: 'Recreation indoors',
    mix: [0, 0.50, 0.50], immutability: 0.25 },
  { id: 'A-AVO-02', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Make things', poleB: 'Take things in',
    mix: [0.05, 0, 0.95], immutability: 0.20 },
  { id: 'A-AVO-03', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Compete', poleB: 'Contemplate',
    mix: [0.15, 0, 0.85], immutability: 0.20 },
  { id: 'A-AVO-04', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Join a club', poleB: 'Go alone',
    mix: [0, 0.10, 0.90], immutability: 0.15 },
  { id: 'A-AVO-05', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Hands and body', poleB: 'Screens and mind',
    mix: [0.10, 0.10, 0.80], immutability: 0.15 },
  { id: 'A-AVO-06', source: 'library', category: 'associative', facet: 'avocations',
    poleA: 'Subsistence from the land', poleB: 'Provision from the store',
    mix: [0.05, 0.55, 0.40], immutability: 0.35 },
] satisfies readonly WordPair[])

/**
 * Authored antagonisms: long-range value conflicts that purely-local, hue-based
 * concordance cannot see, because hue encodes life DOMAIN and not content.
 *
 * These are realized as equal-and-opposite applied FORCES pulling the two identities
 * apart, never as a stiffness change. That keeps K symmetric positive-definite and the
 * problem a standard linear-elastic compliance minimization -- only `f` changes. It is
 * also the better semantic reading: Chao & Moon describe cross-tile conflict as
 * competing demands on behavior (p. 1134, the role-conflict discussion), not as soft
 * material. The structure must then build material to resist being torn apart, yielding
 * either a visible tensile strut (conflict structurally resolved) or a fracture
 * (unresolved). Both outcomes are faithful and immediately legible in the artwork.
 *
 * `aPole` / `bPole` select which pole is in tension: -1 = poleA, +1 = poleB.
 * This list is a patch covering a couple of dozen pairings out of thousands possible;
 * see the honest-critique section of docs/design/00-implementation-plan.md.
 */
export const ANTAGONISMS: readonly Antagonism[] = Object.freeze([
  { a: 'A-REL-01', aPole: -1, b: 'A-POL-05', bPole: 1, weight: 0.50,
    why: 'Faith as the ordering principle vs evidence overriding tradition.' },
  { a: 'A-FAM-01', aPole: -1, b: 'D-RAC-02', bPole: 1, weight: 0.70,
    why: 'Family as the decision unit vs the self as its own independent unit.' },
  { a: 'A-EMP-02', aPole: -1, b: 'A-PRO-01', bPole: -1, weight: 0.30,
    why: 'Loyalty to one organization vs craft-identity that transcends any employer.' },
  { a: 'D-ETH-03', aPole: -1, b: 'D-RAC-03', bPole: 1, weight: 0.60,
    why: 'Keeping ancestral customs distinct vs downplaying difference.' },
  { a: 'A-REL-06', aPole: -1, b: 'A-FAM-05', bPole: 1, weight: 0.25,
    why: 'Fixed moral rules vs keeping peace in the family by not saying everything.' },
  { a: 'A-FAM-02', aPole: -1, b: 'A-EMP-05', bPole: -1, weight: 0.45,
    why: 'Obligation to kin first vs work as the place one actually lives.' },
  { a: 'A-POL-02', aPole: -1, b: 'A-FAM-04', bPole: -1, weight: 0.35,
    why: 'Individual responsibility vs multigenerational mutual provision.' },
  { a: 'D-ETH-02', aPole: -1, b: 'G-REG-07', bPole: 1, weight: 0.30,
    why: 'Heritage language as voice vs standard speech as voice.' },
  { a: 'A-REL-05', aPole: -1, b: 'A-PRO-03', bPole: 1, weight: 0.25,
    why: 'Meaning as given vs private judgment as the final authority.' },
  { a: 'D-AGE-02', aPole: -1, b: 'A-POL-05', bPole: 1, weight: 0.40,
    why: "Elders' judgment as guide vs evidence overriding inherited authority." },
  { a: 'G-REG-01', aPole: -1, b: 'A-FAM-03', bPole: 1, weight: 0.35,
    why: 'Rootedness of birth vs family as chosen -- inherited vs elected belonging.' },
  { a: 'A-EMP-04', aPole: -1, b: 'A-POL-01', bPole: 1, weight: 0.20,
    why: 'Hierarchy as clarifying vs change as the guarantor of freedom.' },
  { a: 'D-RAC-05', aPole: -1, b: 'G-URB-04', bPole: -1, weight: 0.30,
    why: 'Trust from shared background vs anonymity as freedom.' },
  { a: 'A-AVO-06', aPole: -1, b: 'G-URB-03', bPole: -1, weight: 0.25,
    why: 'Subsistence self-provision vs calling a professional.' },
  { a: 'D-GEN-03', aPole: -1, b: 'A-POL-02', bPole: 1, weight: 0.30,
    why: 'Traditional household roles vs responsibility as collectively shared.' },
  { a: 'A-REL-02', aPole: -1, b: 'A-AVO-04', bPole: 1, weight: 0.20,
    why: 'Communal practice vs a general preference for going alone.' },
  { a: 'D-ETH-01', aPole: -1, b: 'D-ETH-03', bPole: 1, weight: 0.40,
    why: 'Heritage as central vs blending customs into one shared life.' },
  { a: 'G-REG-05', aPole: -1, b: 'G-REG-02', bPole: 1, weight: 0.25,
    why: 'Having stayed vs more than one country laying claim.' },
] satisfies readonly Antagonism[])

/** Fast lookup. Built once; the library never changes at runtime. */
export const LIBRARY_BY_ID: ReadonlyMap<string, WordPair> = new Map(
  LIBRARY.map((p) => [p.id, p]),
)
