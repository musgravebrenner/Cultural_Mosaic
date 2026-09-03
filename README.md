# Cultural Mosaic

An Electron app that turns a cultural identity profile into generative artwork by running
real 2D topology optimization over a colour field seeded from the answers.

Left panel: antonym word-pair sliders. Right panel: the mosaic that emerges from them.

Based on Chao & Moon (2005), *"The Cultural Mosaic: A Metatheory for Understanding the
Complexity of Culture,"* Journal of Applied Psychology 90(6), 1128–1140. Both source
documents are in [`docs/`](docs/), and the design that preceded the code is in
[`docs/design/`](docs/design/).

## Running it

```bash
npm install
npm run dev        # dev server with HMR
npm run build      # build all three targets
npm start          # run the built output (this is the one that matters -- see below)
npm test           # 229 tests
npm run typecheck  # tsc -b across four projects
npm run package    # Windows NSIS installer into dist/
```

**On Windows, if a GUI launch exits immediately** with
`TypeError: Cannot read properties of undefined (reading 'isPackaged')`, the shell has
`ELECTRON_RUN_AS_NODE=1` set (some editors' integrated terminals inherit it). Prefix the
command with `unset ELECTRON_RUN_AS_NODE &&`.

### Verification hooks

Three environment variables drive the app without a human at the keyboard, which is how
the render was checked during development:

| Variable | Effect |
|---|---|
| `MOSAIC_DIAG=1` | Forward renderer console output to stdout; exit on the startup diagnostic line |
| `MOSAIC_SHOT=<path>` | Load the sample profile, wait, and write a PNG of the window |
| `MOSAIC_RUN=<n>` | Also press Run for `n` iterations before the screenshot |
| `MOSAIC_VF=<f>` | Override the volume fraction first |

```bash
unset ELECTRON_RUN_AS_NODE && MOSAIC_RUN=140 MOSAIC_SHOT=/tmp/shot.png npx electron-vite preview
```

**Test the BUILT output, not just `npm run dev`.** The dev server runs over
`http://localhost`, where Chromium's worker and CSP rules are looser than under the
packaged `file://` origin. A worker path that works in dev can still fail when packaged.

## How it works

### Input

Each word pair carries two controls, not one:

- **lean** — 7 notches between the two poles. Which pole, and how committed.
- **strength** — Dormant / Minor / Notable / Core. How much this identity matters.

They are separate because Chao & Moon's Proposition 2 treats identity *strength* as a
construct distinct from identity *content*, and one slider cannot encode both: its centre
would have to mean "I am genuinely both" (strong material) and "this isn't me" (absent
material) at the same time. Those are structural opposites.

### Placement

Colour is the paper's own analogy: **R = Demographic, G = Geographic, B = Associative**.

A pair's position comes from the weighted circular mean of the three sector centres
(60° / 180° / 300°). Because those are 120° apart, each sector *boundary* is the angular
bisector of its neighbours — so an equal two-way blend lands **exactly** on the seam
between its two parent categories:

| Mix | Angle | Reading |
|---|---|---|
| (0.5, 0.5, 0) | 120° | Yellow — Regional Heritage |
| (0, 0.5, 0.5) | 240° | Cyan — Localized Communities |
| (0.5, 0, 0.5) | 0° | Magenta — Affinity Groups |
| (⅓, ⅓, ⅓) | hub | White — Concordant Core |

Radius comes from *fixedness*: immutable traits pin on the rim as FEA anchors, fluid
chosen traits sit near the hub and apply loads. Trusses grow from the rim inward.

### Physics

Genuine SIMP/BESO topology optimization — Q4 plane-stress elements, assembled CSR,
Jacobi-preconditioned CG, Sigmund sensitivity filter, optimality-criteria update. It runs
in a Web Worker and converges in a couple of seconds at the default resolution.

Concordance becomes stiffness: where neighbouring identities agree, material is stiff and
becomes a load path; where they conflict, it is weak and erodes into void. That is
Proposition 1 rendered as structure, and it falls out of minimizing compliance rather than
being imposed.

## Layout

```
docs/            the two source PDFs, plus the design documents
src/shared/      the four-channel IPC contract
src/main/        app lifecycle, hardened window, the only fs in the app
src/preload/     contextBridge: four named functions, nothing generic
src/renderer/src/
  domain/        taxonomy, types, the 79-pair library, validation, migration
  layout/        polar placement, seed fields, boundary conditions
  solver/        worker boundary + kernel/ (the FEA and optimization)
  render/        tone mapping, field and overlay renderers, PNG export
  components/    the two-panel UI
  state/         zustand document store
```

`src/renderer/src/domain/library.ts` is the only place the model's sociological content
lives. Its header documents the six authoring rules and the skew sign convention — read
both before editing any pair.

## Known limits

Named honestly, because they are more interesting than hiding them:

1. **The model asserts a metric the paper refuses.** Every pair carries a
   developer-authored category vector and fixedness value. There is no empirical basis for
   "family is the unit of decision = 35% Demographic", and the three categories are not
   orthogonal, so the RGB basis is not really a basis.
2. **Concordance is computed on hue, but hue encodes life *domain*, not *content*.** Two
   flatly contradictory Associative items read as maximally concordant. The authored
   antagonist list patches roughly twenty pairings out of thousands. Carrying a second
   value-position vector and computing concordance in *that* space is the highest-value
   improvement available.
3. **The optimizer destroys what Proposition 3(c) describes.** Compliance minimization
   exists to eliminate structural redundancy, but the paper holds that redundant
   identities are real and are what make behaviour unpredictable. The Ghost toggle
   mitigates this by drawing the eroded material as a trace.
4. **Fixedness is modelled as a property of the trait, not the situation.** "One country
   claims me" at 0.80 is authorial biography imposed on a dual national. Hence the
   per-pair override.
5. **The mapping is smooth, which undercuts the chaos framing.** The app demonstrates
   *emergence* and *self-organization*, which is what Wolfram and Proposition 3 actually
   claim. It probably does not demonstrate chaos, and saying so with a measurement is a
   better argument than asserting otherwise.

The **Invert anchors** toggle exists for the same reason: putting birth facts on the rim
as load-bearing bedrock is a contestable sociological claim, not a natural one. Inverting
it — chosen associations pin, inherited traits load — and rendering both shows that the
artwork depends on an interpretive decision.
