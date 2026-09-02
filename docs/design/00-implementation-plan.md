# Cultural Mosaic — Electron App Implementation Plan

## Context

**What this is.** A class project. You want an Electron app that turns a person's cultural identity
profile into generative artwork by running real 2D topology optimization (SIMP/BESO) over a colored
grid seeded from their answers. Two panels: word-pair sliders on the left, the emergent mosaic on the right.

**Where it comes from.** Two source documents in the project root:
- `chao_moon.pdf` — Chao & Moon (2005), *"The Cultural Mosaic: A Metatheory for Understanding the
  Complexity of Culture,"* J. Applied Psychology 90(6), 1128–1140. Supplies the three-primary-color
  taxonomy (Table 1), concordance/discordance (Prop 1), identity strength & activation (Prop 2),
  localized structures (Prop 3), and the Roccas & Brewer dominant / hybrid / merged-independent structures.
- `Cultural Mosaic.pdf` — your Gemini conversation establishing R=Demographic, G=Geographic,
  B=Associative; secondary-color meanings; the radial rim-and-hub layout; and the Electron/TS architecture sketch.

**Confirmed decisions (settled, not open):**
1. Seeded word-pair library grouped under Table 1's tiles, **plus** user-authored custom pairs.
2. **Real** FEA + SIMP/BESO — Q4 plane-stress elements, assembled CSR, Jacobi-PCG, sensitivity
   filter, OC update. Not a spring surrogate. Runs in a Web Worker.
3. **Radial/polar** layout: θ = category, r = immutability. Immutable traits pin as rim anchors;
   fluid chosen traits apply loads near the hub.
4. **Explicit Run** with animated iterations; sliders update the seed field instantly.

**Intended outcome.** An installable Windows app where you build a profile, press Run, and watch a
truss-like colored mosaic emerge — with the *shape* (not just the color) differing between people,
and a classifier naming which Roccas & Brewer structure your profile produced.

---

## Resolved design conflicts

Three parallel designs were produced (numerics, app architecture, culture→physics mapping). They
disagreed in nine places. These are the rulings — **implement these, not the alternatives**:

| # | Conflict | Ruling | Why |
|---|---|---|---|
| 1 | Grid resolution: 96 vs 120 vs 200 | **N=96 default; presets 64 / 96 / 128** | Only the numerics design costed it. `nnz≈18·ndof`≈255k → ~1.2ms/CSR-matvec × 25–80 CG iters ≈ 45–100ms/iteration. 2× headroom. 96=2⁵·3 halves twice for optional multigrid. |
| 2 | Amplitude from `\|position\|` vs from a separate strength control | **Separate strength control. `amplitude = strength`, NOT `\|position\|`** | The numerics design assumed one slider and derived `amp=\|a\|`. That makes every balanced/bicultural identity structurally weightless — the inverse of what the paper claims. See "Two controls" below. |
| 3 | Who computes the seed field: worker vs renderer | **Renderer** (`src/renderer/src/layout/`) | Must be a pure unit-testable function; instant slider preview with no round-trip; the rAF dirty-flag pattern depends on it. ~3ms either way. Worker receives the finished `SeedField` on `init`. |
| 4 | SharedArrayBuffer vs transferable ArrayBuffers | **Transferables + 3-deep buffer ping-pong** | 37KB/iteration = 0.74 MB/s. Negligible. SAB needs a custom protocol + COOP/COEP headers and risks the packaging story for zero measurable gain. Note as optional later work only. |
| 5 | θ placement: discrete slots vs weighted circular mean | **Weighted circular mean** | Slots cannot represent blended pairs at all. The circular mean makes equal two-way blends land *exactly* on the sector boundary between their parents (see below) — the single most elegant property in the model. |
| 6 | Concordance measure: Bhattacharyya+gate vs spherical coherence | **Spherical coherence, with a conviction gate bolted on** | Coherence reuses the filter's `H` neighborhood in one pass and provably keeps `K` SPD. But bare coherence rates a *weak* aligned region as perfectly concordant, which inverts the paper (p. 1135: unlinked ⇒ discordant). Gate fixes it. Formula below. |
| 7 | ρ⁰: 0.25 connectivity floor vs gamma remap preserving the zero set | **0.25 floor wins** | Hard well-posedness requirement (defense layer 4 of 4): guarantees the disc is one connected component containing every pin and load at k=0, so user answers *cannot* create a disconnected start. The aesthetic objection concerns only the initial guess, which erodes immediately. |
| 8 | Anchor count: pin all immutable pairs vs cap at 8 | **Cap at 8**, greedy farthest-point selection ≥25° apart | Over-constraining collapses the optimum into short local stubs — no long spans, no "cultural highways," boring art. Keep the arc-not-node pin treatment and the 3-pin fallback. |
| 9 | Load direction: project onto own sector vs attract to hue-similar anchors | **Attract to hue-similar anchors** + tangential term for discordant ones | Produces trusses *between specific identities* — the whole point. Projecting onto your own sector center points at whatever happens to be there. Keep "radially outward" as the degenerate fallback. |

---

## Model specification

### Taxonomy and color
R = Demographic, G = Geographic, B = Associative. Table 1's 15 sample tiles are the literal
second-level grouping in the UI (Age/Ethnicity/Gender/Race — Climate/Temperature/Coastal-Inland/
Urban-Rural/Regional-Country — Family/Religion/Employer/Profession/Politics/Avocations).
Secondary colors carry the meanings from your Gemini doc: Yellow=Regional Heritage,
Cyan=Localized Communities, Magenta=Affinity Groups, White=Concordant Core.

### Two controls per pair, not one

**This is the one place the plan departs visibly from "slider value mechanic," and it is load-bearing.**

A single bipolar slider makes center ambiguous between two states that must be *physically opposite*:

| State | Meaning | Required physics |
|---|---|---|
| Balanced-and-strong | "I am genuinely both — bicultural" | strong, present material |
| Indifferent | "this isn't part of me" | absent material |

No single number encodes both. Chao & Moon separate them explicitly — Prop 2 (p. 1133):
*"Activation... is influenced by the strength of the pattern as well as situational contexts,"*
preceded by *"Strong identity patterns are more likely to be tapped than weak patterns."*
Collapsing them would make every bicultural identity weightless, contradicting the paper's own
claim (p. 1131) that biculturals have psychological *advantages*.

So: **`position` ∈ 7 notches [−1 … +1] with snap-to-center** (content/direction) and
**`strength` as a 4-step segmented control** — Dormant / Minor / Notable / Core → `{0, 0.33, 0.66, 1.0}`
(magnitude/activation). Four labeled buttons is one click, so the second control does not double
interaction cost the way a second continuous slider would. Dormant is a real kept state (stays in the
document, renders ghosted, contributes nothing). Unanswered pairs are simply absent from `answers`.

Notched position also makes the whole profile a small integer vector (~60 bytes → a shareable
base64 code) and makes "one notch" a well-defined perturbation for the sensitivity demo.

### Placement math

```
Sector centers:  μ_R = 60°,  μ_G = 180°,  μ_B = 300°
Effective hue:   w = L1norm(max(0, w⁰ + position·δ))        δ = authored polar skew
Circular mean:   z  = (0.5·w_r − w_g + 0.5·w_b,  (√3/2)·(w_r − w_b))     ← no trig needed
                 θ_mean = atan2(Im z, Re z)
Purity:          ψ = |z| = sqrt(1 − 3·(w_r·w_g + w_g·w_b + w_b·w_r))
Radius:          r = R_max · (0.10 + 0.90·m^1.35) · (0.55 + 0.45·ψ)
Jitter:          Δθ = clamp((J·(2·H(id)−1) + J_l·position) / max(r, r_min), −20°, +20°)
                 J = 0.05·R_max,  J_l = 0.045·R_max      ← jitter in ARC LENGTH, not angle
```

Because the three centers are 120° apart, each sector boundary is the angular bisector of its two
neighbors — so **equal two-way blends land exactly on the boundary between their parent categories**:
(0.5,0.5,0)→120° (Yellow, D↔G), (0,0.5,0.5)→240° (Cyan, G↔B), (0.5,0,0.5)→0° (Magenta, B↔D).
Your doc's own example, "Individualist vs Collectivist affects R and B," lands on the R/B seam with
zero special-casing. Assert all three in tests; put the table in your writeup.

**The `atan2(0,0)` trap.** An equal three-way mix gives `z=(0,0)` and JS returns `0` — not `NaN` — so
a perfectly integrated identity is silently placed at 0° and *nothing looks broken*. Handle it:
when `ψ < 0.05`, take θ from a stable hash of the pair id and let the `ψ` factor pull `r` inward
(it lands near the hub, renders near-white, and can bond to all three sectors). This turns a silent
lie into the designed "Concordant Core" behavior — and buys a fourth distinct morphology for free.

Crowding: after closed-form placement, run **20 iterations of deterministic relaxation** pushing
pairs closer than `2.5h` apart, projecting each back onto its own circle so `r` is preserved exactly.
Iterate in **sorted-id order** — `Map`/object iteration order will bite you here.

**No RNG anywhere in placement or deposit.** Use FNV-1a of the pair id, never `Math.random`, never
array index (inserting a library pair must not reshuffle everyone's art). The paper is on this side:
*"chaos describes behavior that appears random but actually is produced by **deterministic**,
nonlinear dynamical systems"* (p. 1132). Sensitive dependence belongs in the optimizer, not the input.

### Deposit

```
σ = max(1.5h, σ₀·(1 + 0.8·(1−|position|))·(1 + 0.4·(1−m)))       σ₀ = 0.055·R_max
kernel k(d) = [exp(−d²/2σ²) − e^−4.5] / (1 − e^−4.5)   for d ≤ 3σ, else 0     ← peak-normalized
amplitude A = strength                                  ← NOT |position|; see conflict #2

Color   (weighted average):  V = Σ A·k·w ;  κ = ‖V‖₁ ;  hue = V/max(κ,ε)
Density (soft OR, log space): ρ_raw = 1 − Π(1 − A·k)
Then:                         ρ̂ = 0.25 + 0.75·ρ_raw           ← connectivity floor
                              bisect scalar t so mean(clamp(t·ρ̂)) == V_target
```

Color **averages**, density **unions** — deliberately different. If color summed-and-clamped, three
overlapping pure-blue deposits would tone-map toward whitish and the app would report "Concordant
Core" (all three dimensions align) in a region that is maximally *pure single-category*. White must
be earned by co-presence of all three, never manufactured by stacking one. Density unions because
presence is a union: if *any* identity occupies a cell there is material there, and soft-OR stays
strictly increasing so SIMP sensitivity information survives (summing-then-clipping creates flat
`ρ=1` plateaus where `∂ρ/∂A = 0` — the gradient dies exactly in the regions you care about most).

Peak-normalized (not integral-normalized) amplitude so a balanced answer reads at full conviction
and only its *extent* differs. Balance and commitment are both strong; they have different morphology.

**`σ_min` must be ≥ `rmin`.** Otherwise the sensitivity filter erases the seed structure before the
optimizer acts on it and every profile produces the same art. With `σ₀=0.055·R_max`=2.59 and
`rmin=2.2` this holds — assert it at init. (The original numbers, 0.05·R_max=2.35 vs rmin=2.4, were
marginally *violated*; that is why both moved.)

### Concordance → stiffness

```
M_e = Σ_i H_ei·V_i          (3-vector)      Z_e = Σ_i H_ei·‖V_i‖      (scalar)
s_e = (Z_e > 1e-9) ? ‖M_e‖/Z_e : 0                    ∈ [0,1]   spherical coherence
g_e = Z_e / (Z_e + Z_half)                            Z_half = 0.35   conviction gate
s_eff = g_e·s_e + (1 − g_e)·0.6                       ← weak/unlinked ⇒ NEUTRAL, not concordant
w_e  = 0.15 + 0.85·s_eff²
```

Reuses the filter's `H` neighborhood — one neighbor structure, three consumers (sensitivity filter,
BESO averaging, coherence). `s_e=1` exactly when all colors in the neighborhood are parallel;
0.707 for an equal two-way mix; 0.577 for equal three-way.

The gate is not decoration. Bare coherence rates two near-empty aligned cells as *perfectly*
concordant, which inverts the paper: *"Identity structures that are not strongly related within an
individual are not linked together... these identities are discordant"* (p. 1135), and
*"**Compatible and strong** value sets can converge"*. Three regimes result: strong+harmonious → stiff
load path; strong+conflicting → weak, erodes to void; weak/unlinked → neutral, dies by redundancy
rather than conflict.

**`w_e` is computed once at seed time and held FIXED for the whole optimization. It never updates
with ρ.** This is the single most important numerical decision in the project. The color field is a
static spatially-varying base modulus (like a composite layup); `ρ` is the only design variable. If
`w` depended on `ρ` you would have a nonconvex feedback loop with no convergence guarantee,
inter-iteration oscillation, and mesh-dependent artifacts that density filtering *will not fix*
because the instability is in the material model, not the discretization. With `w` fixed it is a
textbook variable-modulus SIMP problem: `K = Σ w_e·E(ρ_e)·KE` is a positive combination of PSD
element matrices plus the `Emin` floor, hence symmetric positive-definite unconditionally.

**Expect one counterintuitive behavior and do not "fix" it.** Where a load has an alternative path,
the optimizer routes *around* low-`w` regions and discordant seams erode into voids — the desired
art. But where a fluid identity is surrounded *entirely* by contradiction, the series-spring
sensitivity `∂C/∂ρ ~ −F²p/(ρ^{p+1}w)` grows *larger* as `w` shrinks, so the optimizer **thickens**
the discordant material into a visible buttress. That is the physics being honest, and it is the best
thing the model gives you for free: an identity supportable only through contradiction requires a
thick, effortful support. Put that sentence in the app's explanatory copy.

### Loads and anchors

```
m ≥ 0.75          → ANCHOR candidate (pinned)          target 3–8, ≥25° apart, arc not node
0.45 < m < 0.75   → STRUCTURAL MASS (color+density only, no BC)      ~44 of 79 pairs
m ≤ 0.45          → LOAD candidate                                    target 4–20

Anchor arc half-width = 2 + 4·strength elements; adjacent elements → SOLID_PASSIVE
Load direction:  ω_ij = BC(hue_i, hue_j)²·strength_j       BC = Bhattacharyya coefficient
                 F_i = F₀·strength_i · Σ_j ω_ij·û_ij / (Σ_j ω_ij + ε)      ← attraction
                 F_i += F₀·strength_i·0.35 · Σ_j (1−ω̃_ij)·strength_j·t̂_ij  ← tangential/discordant
Normalize Σ‖F‖ = 1.  F₀ = 1 (compliance minimization is scale-invariant in F).
```

The middle band matters: without it you have pins on the rim, forces at the hub, and nothing
meaningful between — pure compliance geometry with no cultural content.

Attraction (not repulsion) for concordance: a fluid identity *pulls toward* what roots it, so the
optimizer must build material along that line and a truss materializes between the hobby and the
heritage motivating it. The discordant term is **tangential rather than repulsive** for two reasons:
radial and tangential are orthogonal so the terms cannot silently cancel (a repulsive term would
partly cancel attraction at middling relatedness, producing near-zero loads with no way to notice —
a whole class of invisible bug), and shear produces diagonal bracing and twisted forms, which reads
far better than "a strut pointing the wrong way."

**Long-range conflict as an applied force, not a stiffness change.** For an authored antagonist list
of ~15–25 `(itemA@pole, itemB@pole, weight)` triples, add equal-and-opposite forces pulling the two
apart along their connecting line. `K` is untouched and stays SPD; you only add to `f`. The structure
must then build material to resist being torn — producing either a visible tensile strut (conflict
structurally resolved) or a fracture (unresolved). Both are faithful and immediately legible.
Semantically right too: the paper describes cross-tile conflict as competing *demands on behavior*
(p. 1134), not as soft material. Cap total conflict load at 25% of total load magnitude.

**Degenerate-profile guards — all mandatory, all will fire in practice:**

| Case | Guard |
|---|---|
| 0 answered | 3 synthetic anchors at 60/180/300°, zero color, one hub load, `Vfrac=0.20`, cap 30 iterations, label "unanswered" |
| 1–2 answered | synthesize up to 3 anchors; ×1.5 on σ₀ so sparse deposits connect; low-confidence banner |
| **All `m ≥ 0.75`** | everything is an anchor ⇒ `f=0` ⇒ `u=0` ⇒ zero compliance, undefined sensitivities, **optimizer silently does nothing**. Force lowest-`m` 40% to loads |
| All `m ≤ 0.45` | no anchors ⇒ singular `K`. Promote highest-`m`, top up to 3 |
| All in one tile | anchors in a narrow arc ⇒ structure can rotate about the cluster (near-singular). If angular extent < 40°, add synthetics until ≥ 90° |
| Loads in a void | classic SIMP failure: optimizer deletes material under the load, compliance explodes. **3×3 `SOLID_PASSIVE` patch at every load and pin, excluded from design variables.** Non-optional |
| Any profile | assert before assembly: ≥3 anchors, ≥1 load, angular extent ≥40°, anchors non-collinear |

---

## Solver specification

### Mesh
Column-major, `iy` downward, matching top88's `edofMat` so the closed-form `KE` drops in without
permutation. `nodeId(ix,iy) = ix·nnodey + iy`; `elemId(ex,ey) = ex·nely + ey`;
`edof = [2n_bl, 2n_bl+1, 2n_br, 2n_br+1, 2n_tr, 2n_tr+1, 2n_tl, 2n_tl+1]` (CCW from bottom-left in
physical y-up coords — **must** be this order to match `KE`).

Elements are squares, so Q4 plane-stress `KE` is **exactly independent of `h`** (`B~1/h`, area `~h²`).
`h = 1` is not an approximation. Do not introduce an `h` scale factor — it is a classic silent bug.

`Rmax = min(nelx,nely)/2 − 1` (=47 at N=96). Three element states in a `Uint8Array`:
`VOID_PASSIVE` (outside disc — **not assembled at all**, so `K`'s support is exactly the disc),
`FREE` (design variable), `SOLID_PASSIVE` (load/pin patches, fixed at 1.0, counted in the volume
budget). Keep full-length `nelem` arrays; loop over precomputed `designList`/`freeList` `Int32Array`s.

### Element stiffness
Build from the top88 `A11/A12/B11/B12` blocks — **do not hardcode decimals**:
`A = (A11 + ν·B11)/(24(1−ν²))`, `B = (A12 + ν·B12)/(24(1−ν²))`, `KE = [[A,B],[Bᵀ,A]]`.
At ν=0.3 the scale factor is 1/21.84 and `KE[0][0] = 45/91 = 0.4945054945054945`.
Golden values, symmetry, zero row sums, the rigid-rotation null vector, `trace = 8·45/91`, and
`rank=5` are all asserted in the highest-value test in the suite. If any fails, the DOF order is wrong.

```
E(e)      = w_e·(Emin + ρ_e^p·(E0 − Emin))          E0=1, Emin=1e-6, ρ_min=1e-3, p=3
dE/dρ(e)  = w_e·p·ρ_e^(p−1)·(E0 − Emin)
```

`Emin=1e-6` not top88's `1e-9`: raised three decades because the user-driven seed makes thin hinges
and near-islands likely, and `Emin` floors `cond(K)` for any such feature the connectivity pass
misses. Still visually indistinguishable from void.

**No continuation on `p`** — the seed field *is* a purpose-built non-uniform initial guess that
already breaks symmetry along culturally meaningful directions; continuation would fight it and
roughly double the iteration count. **Exception:** on Export, run 20 extra iterations ramping
`p: 3→4.5` and `move: 0.2→0.05` to drive remaining gray to black/white without changing topology.
Ship this; it visibly improves the artifact.

### Assembled CSR, not matrix-free
Break-even is at `n_cg ≈ 2`; we run 25–80. CSR wins ~1.9× on the dominant term and hands you the
exact diagonal for free. The mesh never changes, so build the pattern, the element→CSR scatter map
(`Int32Array(nDesign·64)`, 1.8MB), and `diagPos` **once** at init. Per iteration: `values.fill(0)`
then 64 scattered accumulations per element. Store the full matrix, both triangles — 2MB, not worth
symmetric-matvec write-conflict complexity.

### Jacobi-PCG with explicit DOF masking
The invariant that makes this correct: **every vector in the Krylov space is exactly zero at
constrained DOFs.** Enforce `f[c]=0`, `u[c]=0`, `r[c]=0` after forming the residual, and `q[c]=0`
after every matvec. Those last two are the only places masking is required. **Do not** zero rows and
columns of `values` — it invalidates the precomputed scatter map and is unnecessary.

`tolRel = 1e-4` during animation (compliance is quadratic in `u`, so this is far below the density
changes being made — inexact solves at this level are established practice), `1e-7` on the final
iteration and export. `maxIter = 600` animation / 4000 export; on non-convergence **proceed anyway**
and surface `cgResidual` plus a warning badge. Never hang.

Warm start from the previous `u`: **1.5–2.0× realistically, not 10×** (cold needs a 1e4 reduction,
warm ~3e2; ratio of logs = 1.6). Two correctness rules: zero `u0` at every newly-constrained DOF when
the supported-DOF mask changes, and keep two `u` buffers. Don't try linear extrapolation — it hurts
across topology changes. Adaptive tolerance `tolRel_k = clamp(0.02·changeLinf_{k−1}, 1e-6, 1e-3)`
buys another 1.3–1.6× for free.

### Disconnected material — the main failure mode, four defenses
1. **`Emin=1e-6` floor** — guarantees `K` is SPD for any ρ, so CG never divides by a non-positive
   `pᵀKp`. Mathematical safety net only: an island connected solely through `Emin` material has a
   near-rigid-body mode at eigenvalue `~Emin`, so `κ ~ E0/Emin·N²` and Jacobi-PCG would need
   *thousands* of iterations. **Jacobi does not fix this.**
2. **Connected-component pass every iteration** (union-find over `designList`, <0.5ms) — this is the
   actual fix. Solid set with hysteresis (enters at ρ>0.12, leaves at ρ<0.08, else holds — prevents
   period-2 chatter). A component is anchored if it contains an element with a corner node in
   `pinnedNodes`. `fixedMask = pinnedDofs OR NOT supportedDof`. With unsupported DOFs constrained,
   `cond(K)` is governed by geometry alone (`~N²`), independent of density contrast — this is what
   keeps CG at 25–80 instead of thousands.
3. **Load-point handling** — a load DOF in the unsupported set gets zeroed for the solve and reported:
   *"this identity has no cultural highway to the rim."* A legitimate analytic output, not an error.
4. **Never hand the optimizer a disconnected start** — the 0.25 `ρ⁰` floor plus `SOLID_PASSIVE`
   patches at every pin and load.

Plus reporting: expose `islands: n` per frame (non-anchored components > 8 elements). Small islands
are normal mid-run; a persistent large one after iteration 40 means the seed genuinely partitioned
the domain, and the UI should say so.

### Sensitivity, filter, update
```
ce_e      = u_eᵀ·KE·u_e                    (packed 36-term upper triangle; 36×6940 ≈ 0.8ms)
c         = Σ E(e)·ce_e   ( == fᵀu — assert to 1e-9 in dev; catches DOF-order and assembly bugs)
dc/dρ_e   = −w_e·p·ρ_e^(p−1)·(E0−Emin)·ce_e
```

**Sensitivity filter (Sigmund), not density filter.** Three reasons: it is what top88 pairs with OC
and is the most robust known combination for this class; it needs no chain rule so SIMP and BESO
share it *identically* (a density filter needs `dρ_phys/dρ` propagation BESO's discrete update can't
use); and it's cheaper. Cost: mildly non-monotonic compliance history and no Heaviside projection —
the export hardening pass covers the crispness need.

```
H_ei  = max(0, rmin − dist(centroid_e, centroid_i))                rmin = 2.2 (expose 1.5–4.0)
dcF_e = (Σ_i H_ei·ρ_i·dc_i) / (Hs_e·max(1e-3, ρ_e))
```
Precompute `H` once as CSR over the design list (`nnzH ≈ 6940·19 ≈ 132k`, ~1.6MB, ~10ms build,
~0.4ms apply). Test: `H_ei==H_ie`, rows sum to 1, a constant sensitivity field maps to itself exactly.

OC update: `η=0.5`, `move=0.2`, Lagrange bisection with a **warm bracket** from the previous
multiplier (`λ/4, 4λ`) plus expansion if it doesn't straddle — cuts bisections from ~58 to ~15.
Clamp `Be` at 0 before the power: the sensitivity filter is a heuristic and *can* produce a positive
`dcF_e`, which would otherwise be a `NaN`. Skip `SOLID_PASSIVE` entirely. Stop at
`changeLinf < 0.01` for 3 consecutive iterations, or `maxIter` 120 (animation) / 250 (export).

**BESO** shares the FEA core completely unchanged — soft-kill (Huang & Xie), ρ restricted to
`{1e-3, 1}`, fed through the same `E(ρ)`. Only the update differs. Sensitivity number
`α_e = 0.5·w_e·ρ_e^(p−1)·ce_e`; **plain** weighted-average filter (not the ρ-weighted form);
**history averaging `ᾱ^k = 0.5(α_F^k + ᾱ^{k−1})` is mandatory** — without it BESO oscillates forever.
Volume schedule `ER=0.02` supporting **both** directions (the seed volume is user-determined and may
start below target). Two-threshold add/remove with `AR_max=0.05` to stop flooding. Huang-Xie
convergence test, `M=5`, `τ=0.001`, `maxIter=150`. Artistically: SIMP gives smooth cartilage-like
gradients, BESO gives hard black-and-white members. Default SIMP.

### Volume fraction — derived, with a visible override
```
S     = (Σ_i strength_i) / nAnswered
Vfrac = clamp(0.22 + 0.30·S, 0.20, 0.55)
```
Volume fraction is the single most visually dominant parameter. As a free slider it *swamps* every
other signal and the artwork stops being a portrait. Bound to total identification strength it reads
as "strong decisive identities → dense load-bearing mosaic; tentative answers → thin filigree." The
clamp is a feasibility requirement, not decoration: below ~0.18 a disc carrying 10–20 point loads
cannot form a connected truss at `rmin=2.2`; above ~0.60 nothing erodes. Show **both** numbers in the
Advanced panel ("derived 0.34 / manual") — class projects are graded on the mapping being legible.

---

## Application architecture

### Scaffold
```bash
git init
npm create @quick-start/electron@latest . -- --template react-ts    # "Ignore files and continue"
```
**electron-vite + electron-builder, not Electron Forge.** electron-vite compiles preload to CJS/IIFE
by default — an ESM preload silently fails under `sandbox:true`, giving you
`window.mosaic === undefined` with no error, which is the single most common Electron+ESM failure.
It also gives three explicit build targets in one config (worker options live in the `renderer`
section and behave like ordinary Vite there), and electron-builder's NSIS installer prompts for
install location, where Forge's default Squirrel.Windows installs to `%LOCALAPPDATA%` silently and
looks broken to a grader.

Drop from the template: **`electron-updater`** (no update server; largest dep) and
**`@electron-toolkit/preload`** (exposes a broad `ipcRenderer` surface, defeating the narrow bridge —
and its `require` usage is the only reason the template sets `sandbox:false`). Add **`zustand`**.
Keep `@electron-toolkit/utils`. Argued against and deliberately absent: p5.js, three.js/PixiJS, zod,
nanoid, immer, Tailwind, d3, any charting library.

**Worker bundling — the sharp edge.** Use `import SolverWorker from './solver.worker?worker'`
(Form 1), *not* `new Worker(new URL(...))`. Form 2 requires the `new URL` expression written
literally inline (Vite static-analyzes it), so it cannot live behind a facade. Form 1 gets types free
from `vite/client`, imports normally, and offers a one-token escape hatch: `?worker&inline`
base64-inlines the worker as a blob URL, eliminating all path resolution under `file://`.

In `electron.vite.config.ts`, under **`renderer`** (electron-vite silently ignores it at top level):
`worker: { format: 'es', plugins: () => [] }` — **`plugins` must be a function** in Vite 5+; passing
an array is a config error people lose an hour to. Keep `solver.worker.ts` under
`src/renderer/src/solver/` or electron-vite compiles it for Node.

**`SolverSession.ts` must be the only file in the app that mentions `Worker`.**

Four tsconfigs, not one: renderer needs `lib:["DOM"]`, the worker needs `lib:["WebWorker"]`, and both
in one project produces conflicting global declarations (`self`, `MessageEvent`, `postMessage` all
declared twice) with error messages that read like nonsense. `tsconfig.worker.json` also sets
`noUncheckedIndexedAccess: false` — it's valuable everywhere else but makes `float64Array[i]` type as
`number | undefined`, which in an FEA inner loop means `!` on every access. Scope the relaxation to
the one directory where it's a liability. Root `tsconfig.json` is a solution file (`files: []` +
references) so `tsc -b` checks everything.

Security: `contextIsolation:true`, `nodeIntegration:false`, **`sandbox:true`** (template ships
false), `setWindowOpenHandler(() => ({action:'deny'}))`, a `will-navigate` denial, and a CSP meta tag
with `worker-src 'self' blob:` (keeps the inline fallback available).

**IPC: exactly four channels, all `invoke`/`handle`, zero `ipcRenderer.on`.** The whole justification
for the architecture: the solver lives in a renderer worker, so **no solver data crosses IPC at
all** — only file dialogs do. Four *named* bridge functions, never a generic
`invoke(channel, ...args)` (which re-exposes every handler main will ever register). `fs` appears in
exactly one file; main receives a *string* to write or returns a *string* it read, and never receives
a path from the renderer — so there is no path-traversal surface at all.

### The four-layer separation
Your doc's `CulturalNode` mashes together four things with completely different lifetimes:

| Layer | What | Count | Changes | Owner |
|---|---|---|---|---|
| `WordPair` | shipped library data | ~79 | frozen | module const |
| `TileAnswer` | the document | 10–40 | user edits | zustand + JSON |
| `PlacedTile` | pure f(1,2,layout) | 10–40 | recomputed | memoized selector |
| `SeedField` / frames | grid typed arrays | 9,216 cells | 20–60 Hz | worker + a plain ref |

Follow `CulturalNode` and you get `CulturalNode[]` with 9,216 entries the solver mutates every
iteration, with React unable to tell what changed — so you either diff 9,216 objects per frame or
re-render 60×/sec. With the layers split, the solver only ever touches flat typed arrays and React
only ever holds ~40 small objects that change at human speed. **That split is what makes the rest
tractable.**

Keep **`purity`** (within one tile: how single-category, low ⇒ the white Concordant Core) and
**`concordance`** (between neighbors: Prop 1, drives the stiffness field) strictly separate. They come
from different parts of the theory and letting one stand in for the other makes the physics
incoherent. Name them differently in code.

**Snapshot every referenced `WordPair` into the saved file**, library ones included. Referencing by
id means tuning a preset in v1.1 silently changes every previously-saved artwork. Costs a few KB and
makes the file self-contained and reproducible — the entire point of saving an artwork.

### Zustand + the zero-re-render pattern
Zustand, and the deciding feature is the one people rarely cite: **its vanilla API works outside
React.** `useStore.getState()` from inside the rAF loop, `useStore.subscribe(sel, cb)` from
`SolverSession`. Your renderer and solver client are not components and must not be. (Context
re-renders every consumer on every slider tick; you'd fix it by splitting contexts and hand-placing
`memo`, i.e. reimplementing zustand worse. Redux Toolkit is ceremony for ~6 pieces of state.)

Store the **document** in zustand. Store **solver frames nowhere near it.** Two dirty flags and one
rAF loop — that's the whole trick, used twice:

- `SolverSession.onmessage` on the frame path writes two fields (`latestFrame`, `fieldDirty = true`)
  and returns. **Never `setState`.** It also transfers the *previous* frame's buffers back to the
  worker as a `recycle` message — the ping-pong that makes steady-state allocation zero (otherwise
  9,216 `Float32Array`s at 20Hz is ~0.74MB/s of garbage and a GC pause every few seconds, visible as
  jank). Progress for the UI is throttled to 10Hz through a separate listener set.
- `MosaicCanvas` mounts once with `useEffect(..., [])` and never re-renders during a run. Its rAF
  loop checks `fieldDirty` / `seedDirty` / `overlayDirty` and paints. A store subscription on
  `answers` sets `seedDirty = true` and returns — **never rebuild synchronously in the input
  handler**, that's what makes slider drags feel gluey. One rebuild per frame regardless of input
  rate: 40 stamps × ~225 cells ≈ 9,000 writes into a pre-allocated array, tens of microseconds.

Two traps: **`RunStatus` must be a leaf**, a sibling of `MosaicCanvas` and never an ancestor —
it re-renders 10×/sec and from above would re-render the canvas 10×/sec, producing hitching that
looks like a solver bug for hours. And **StrictMode double-mounts effects in dev**, so create
`SolverSession` as a module singleton or you get two workers interleaving into one `latestFrame`,
which looks exactly like a solver bug and isn't.

### Rendering
**Raw Canvas 2D.** The decisive argument isn't p5's weight (1MB in a 200MB Electron app is nothing)
— it's that at 9,216–14,400 cells the only viable technique is one `Uint8ClampedArray` written
directly and blitted with a single `putImageData`, and p5 *can* do that via `loadPixels()`/`pixels[]`
— at which point you are writing byte-index arithmetic into a typed array, which is **identical code
with or without p5**. p5's entire value is its drawing API, and the drawing API (`fill`+`rect` per
cell: ~1.7M canvas state ops/sec at 60fps, landing you at 15–25fps while stealing CPU from the
solver) is precisely what you cannot afford. WebGL is wrong for the mirror reason — 2 composited ops
per frame is already 50× under budget.

Three canvases: an offscreen N×N field buffer, an on-screen display canvas, an on-screen overlay
(`pointer-events: none`, mouse handlers on the container). Two layers because the field redraws at
60fps while the overlay changes only on edit/hover, and because they want *opposite* context settings
(`imageSmoothingEnabled` false vs true) which are per-context. Cache the static overlay (sector
guides, rim ring, radius rings, labels) to a third offscreen canvas.

Making it read as artwork, in descending payoff:
1. **Composite in linear light.** The biggest single "why does it look cheap" fix — alpha-blending
   sRGB directly makes every fading edge muddy and dark. Two LUTs (256-entry sRGB→linear Float32,
   4096-entry linear→sRGB8 Uint8), built once.
2. **`smoothstep(0.25, 0.60, ρ)`**, not a hard threshold (aliases, discards SIMP's gradient) and not
   raw `alpha = ρ` (grey mush — early SIMP is almost entirely intermediate density). Expose
   `solidLo`/`solidHi`; they're the primary aesthetic dial.
3. **Desaturate toward the void** so thin regions fade to the paper tone, not to grey. Grey reads as
   missing data; paper reads as negative space.
4. Optional edge accent from a cheap ρ gradient magnitude — an inked, drawn quality for ~15 lines.
5. **Background is warm paper `#F4F1EA` or deep ink `#101014`**, never pure white or black.

**Windows fractional DPI.** At 125%/150% scaling, if the drawn size isn't an exact integer multiple
of N, each cell straddles a fractional number of device pixels and you get shimmer and uneven widths
— which looks like a bug in an app whose whole aesthetic is crisp tiles. Snap down to an integer
cell size and center: `cellPx = floor(availPx / N)`, `drawPx = cellPx · N`. This is also why
**pan/zoom is out** — arbitrary zoom makes cells fractional again and degrades the core aesthetic.
Everything users want from zoom comes cheaper: a resolution selector (the real "zoom in" — more
structural detail, not a bigger view), a collapse-left-panel toggle, and high-res PNG export.

**Hover provenance:** while building the seed field, fill an `Int16Array(N·N)` with the index of the
dominant contributing answer per cell (−1 for empty). Hover resolves coords → cell → answer → pair in
O(1), no spatial search. Render the tooltip as DOM but **only `setState` when the hovered `answerId`
changes** — position via `style.transform` from the rAF loop. Handful of renders per second instead
of 120.

**Optional, high value: a von Mises stress overlay.** You already have `u` and `D`; `σ_vm` per
element is ~30 flops from the centroid strains. Rendering stress as luminance on the surviving
members reads directly as "these are the cultural highways actually carrying load" — the most legible
visualization of the whole metaphor.

### Left panel
Two tabs, `Library` and `My Profile (n)` — not both in one scroll. Library tab: search box (not
optional at 79 pairs), two-level grouping mirroring Table 1 *literally* (this teaches the taxonomy
while browsing, which is real value when the grader is looking for engagement with the source), each
row showing a 3-segment R/G/B mix bar and an immutability pip. One answer per `pairId`, enforced.

Answer card: poles labeled at both ends permanently, a **word readout** ("strongly Urban" / "leaning
Urban" / "equally both") with the number secondary — the whole app is about words. Center tick with
snap. Strength as the 4-step segmented control. **Fixedness behind a disclosure**, pre-filled from
the library preset but user-overridable (see critique 4 below — this converts the radial axis from
an authored assertion into a self-report).

Custom-pair form: pole A/B (1–24 chars, must differ case-insensitively), a **barycentric ternary
picker** for the mix (the correct control for a 3-way normalized mix — three independent sliders let
you specify meaningless states and hide the constraint; ~40 lines of SVG), immutability slider with
labeled anchors, optional facet + note, and a **live preview chip** showing the resulting color and a
dot on a miniature polar diagram so the user sees where it will land before committing.

Run controls in a persistent **left-panel footer** (keeps the right panel a clean art frame — you
*will* screenshot it) with the Solver group collapsed by default.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Open] [Save] [Export PNG…]      │ ☑ Scaffolding  Theme [Paper|Ink]  [⤢]    │
├──────────────────────────────────┬───────────────────────────────────────────┤
│ ( Library )  ( My Profile · 14 ) │           ·  ·  ·  ·  ·  ·                │
│ ┌──────────────────────────────┐ │       ·     ◤ DEMOGRAPHIC ◥      ·        │
│ │ 🔍 search 79 pairs…          │ │    ▲   ▓▓▓▒▒        ▒▒▓▓▓▓        ▲       │
│ └──────────────────────────────┘ │   ╱  ░▒▓▓▓▓▓▒▒▒▓▓▓▓▒░   ▒▓▓       ╲      │
│ ▼ ● DEMOGRAPHIC                  │  ·     ░▒▓▓▓▓▓▓▓▓▒░      ▒▓▓       ·     │
│    ▸ Age (6)  ▸ Ethnicity (5)    │  ▲  ░▒▓▓▓▓▒░  ░▒▒▒▒░  ░▒▓▓▓▓▒      ·     │
│    ▾ Gender (5)                  │  ╲    ▓▓▓▒░      ↓F     ░▒▓▓▓▓▓    ▲     │
│      ┌──────────────────────────┐│   ·     ░▒▓▓▓▒▒▒▓▓▓▓▓▓▒▒▒▓▓▓▒░    ╱     │
│      │ ● Geographic · Urban-Rural││    ·       ░▒▒▓▓▓▓▓▓▓▓▓▓▒░       ·      │
│      │ Urban ◀━━━━●━━━━▶ Rural   ││     ◣ ASSOCIATIVE    GEOGRAPHIC ◢       │
│      │      leaning Rural (+0.33)││                                          │
│      │ Matters  ○─◉─○─○          ││   ┌─────────────────────────┐            │
│      │  Dormant Minor NOTABLE Core││  │ Urban ↔ Rural           │            │
│      │ ⌄ Fixedness ◀━●━━━▶ 0.25  ││   │ leaning Rural · Notable │            │
│      └──────────────────────────┘│    │ Geographic · r 0.41     │            │
│ ▶ ● GEOGRAPHIC (24)              │    └─────────────────────────┘            │
│ ▶ ● ASSOCIATIVE (34)             │                                           │
│ ┌── + New custom pair ─────────┐ │  ▲ = pinned rim anchor (ground symbol)    │
├──────────────────────────────────┤  ↓F = load vector                         │
│ [▶ Run] [⏸] [↺]  47/120 vol .31 │  · = sector guide (scaffolding on)        │
│ ⌄ Solver  SIMP|BESO  vol ━●━ .35│  Structure: HYBRID (Demographic↔Assoc.)   │
└──────────────────────────────────┴───────────────────────────────────────────┘
  ← 380px fixed                          → flex, square-cropped, centered
```

### Persistence and export
`.mosaic.json`, pretty-printed (10–30KB — readability is worth real points), shape = `MosaicProfile`
including the `pairs` snapshot and the full solver config with its seed, so reopening and pressing
Run reproduces the *same* artwork. **That reproducibility promise is why solver determinism is a
hard contract: no bare `Math.random()` anywhere.**

`parseProfile(raw: unknown)` — **liberal on read, strict on write.** Check `kind` first (lets you
reject an unrelated JSON with a real message instead of a `TypeError`). Newer `schemaVersion`:
**refuse** ("saved by a newer version") — silently dropping fields you don't understand loses user
data. Older: run an ordered migration chain. Otherwise **clamp and warn, never reject** — collect all
problems and report together. A user should never lose an artwork because one number drifted.
**Write `migrate.ts` on day one** with a single identity migration; it's 15 lines now and
retrofitting it after v1 files exist is exactly when people lose files.

PNG export: **never scale the display canvas** — render fresh at target size with the same code and
a different `scale`, which is why every length, stroke width, and font size must be a function of
`scale` from the start. Mosaic mode: nearest-neighbour at an **integer** factor is mathematically
exact. Smooth mode — **the one insight that matters most here: Catmull-Rom resample ρ and each color
channel as floats to the output resolution, then tone-map per output pixel.** Tone-mapping at 120²
and then upscaling gives you a mushy image whose solid/void boundary was anti-aliased at 120px and
then blurred. Resample-then-tone-map is the difference between a blown-up screenshot and a print.
Also offer "save the profile JSON alongside the image" — an exported artwork that can't be traced
back to its answers is a dead end, and that's the two-line fix.

**SVG export: no.** Marching squares at an iso-level gives a single-color contour, and the mosaic's
whole identity is the multi-colored field; preserving color needs either a full planar-map polygon
problem or 14,400 `<rect>`s (a bitmap in XML). An 8192px PNG prints 27" at 300dpi. Revisit only if a
*truss line-art render mode* earns its way in aesthetically — then contours exist and SVG is nearly
free. Don't build a contour extractor for an export format.

---

## Files to create

```
docs/                                    ← move both PDFs here; copy the 3 design docs to docs/design/
electron.vite.config.ts                  three targets; renderer.worker options — HIGHEST-RISK FILE
electron-builder.yml                     Windows NSIS
tsconfig.{json,base,node,web,worker}.json
src/shared/ipc-contract.ts               4 channel names + request/response types
src/main/{index,ipc,dialogs}.ts          hardened window; 4 handlers; the ONLY fs in the app
src/preload/{index.ts,index.d.ts}        contextBridge: 4 named fns
src/renderer/index.html                  CSP meta tag
src/renderer/src/
  main.tsx  App.tsx  styles/{theme.css,*.module.css}
  domain/
    taxonomy.ts        CategoryId/FacetId, SECTOR_CENTER_DEG, category→RGB
    types.ts           WordPair, TileAnswer, PlacedTile, MosaicProfile, *Config — zero imports
    library.ts         the 79 pairs + the authored antagonist list — the ONLY place culture content lives
    library.test.ts    ids unique, mixes non-zero, immutability in range, facets valid, poles distinct
    validate.ts        parseProfile: clamp + collect
    migrate.ts         ordered migration chain — write on day one
  layout/
    polar.ts           Answer[] → PlacedTile[]: circular-mean θ, radial map, arc-length jitter, relaxation. PURE, hash-based, no Math.random
    polar.test.ts      golden table + the three boundary cases + the ψ→0 tiebreak
    fields.ts          PlacedTile[] → SeedField: deposit, V/κ/hue, soft-OR ρ, w_e coherence. Mutates in place, zero alloc
    boundary.ts        anchor/load classification, greedy angular spread, force vectors, conflict loads, ALL degenerate guards
    classify.ts        Roccas & Brewer morphology classifier
  solver/
    protocol.ts        SolverRequest/Response, MeshSpec, SeedField — no DOM, no WebWorker
    SolverSession.ts   THE boundary: only file mentioning Worker; latestFrame + dirty + buffer recycle
    solver.worker.ts   message pump, buffer pool, error fencing
    kernel/
      mesh.ts elementStiffness.ts material.ts assembly.ts spmv.ts cg.ts
      connectivity.ts filter.ts sensitivity.ts ocUpdate.ts beso.ts optimizer.ts
      multigrid.ts     ← Phase 2 only, if N=128 misses budget
  state/{store.ts,selectors.ts}
  render/{tone,FieldRenderer,OverlayRenderer,resample,export-png,stressOverlay}.ts
  components/          MosaicCanvas LeftPanel LibraryBrowser AnswerCard PolePairSlider
                       StrengthSelector CustomPairForm TernaryMixPicker RunControls
                       RunStatus(LEAF) Toolbar Tooltip StructureReadout
  hooks/{useAnimationFrame,useCanvasSize}.ts
```

The three design documents currently live at
`C:\Users\BMUSGR~1\AppData\Local\Temp\claude\...\scratchpad\{solver,app,mapping}.md` (session temp).
**Copy them to `docs/design/` in Step 0** — `mapping.md` contains the fully drafted 79-pair library
with IDs, weight vectors, and immutability values, which is most of `library.ts` already written.

---

## Build order

Each step ends in something runnable and checkable.

**0. Scaffold and harden.** Move PDFs to `docs/`, copy design docs to `docs/design/`, `git init`,
scaffold, delete `electron-updater` + `@electron-toolkit/preload`, split the four tsconfigs, CSP meta
tag, `sandbox: true`. → *Empty window titled Cultural Mosaic, HMR working; `tsc -b` clean; zero CSP
violations; preload logs `process.contextIsolated === true`.*

**1. Prove the worker path before writing any app code.** Throwaway worker that doubles a
`Float32Array` and transfers it back, through `?worker` inside `SolverSession.ts`.
→ *Verify `sentArray.byteLength === 0` after posting — proof of zero-copy transfer, not a silent
structured-clone copy.* **Run this against `npm run build && npm start`, not just `npm run dev`** —
dev serves over `http://localhost` and will pass even when the packaged `file://` build fails. This
is the highest-risk item in the project and costs 30 minutes to retire on day one. If it fails:
`?worker` → `?worker&inline`, one line, one file.

**2. Domain model + the 79-pair library.** No UI. → *vitest: unique ids, non-zero mixes,
immutability ∈ [0,1], valid facets, poles trimmed and distinct. Catches the data-entry typos that
otherwise surface as one mysteriously misplaced tile in week three.*

**3. Polar placement, golden-file tested.** → *Explicit expected-value table for a 12-answer fixture
(not an opaque snapshot, so diffs are readable). Assert the three boundary cases exactly; `m=1 →
r=rimRadius`; the ψ→0 case hits the documented tiebreak rather than 0°; identical input →
byte-identical output; minimum angular separation over a 20-same-category fixture.*

**4. Seed field + FieldRenderer + canvas. No solver.** → *Right panel shows the colored seed mosaic
from a fixture. Verify determinism, mass linear in strength, every non-empty cell has valid
provenance. Screenshot at both 100% and 150% Windows scaling — cells must be identical widths.*

**5. Left panel: library browser, answer cards, zustand.** → *Browse, search, add, drag; seed mosaic
updates with no perceptible lag. Add a dev-only render counter to `MosaicCanvas` that warns if it
renders more than once per profile-structure change, then drag a slider through its full range — the
warning must not fire. Cheap permanent regression test on the most important architectural property
in the app.*

**6. SolverSession + frame pump against a FAKE kernel** (blur-and-threshold ρ each step, same
protocol). → *Run → animated erosion at 60fps, counter ticking, Pause/Reset working. Log allocations
per frame: must go flat after two frames, proving the ping-pong. **This proves the entire streaming
architecture before the real numerics land, so any later bug is unambiguously in the kernel.***

**7. The real FEA kernel, behind the identical protocol.** Order within the step:
`elementStiffness` → patch test → `assembly` + `spmv` + `cg` → MBB iteration-1 compliance →
`sensitivity` + `filter` → `ocUpdate` → converged MBB → `connectivity` + island test → `beso`.
→ *Real truss structures from your actual profile.*

**8. Overlay, provenance tooltips, scaffolding toggle, structure classifier readout.**

**9. Custom pairs, ternary picker, validation.** → *Author "Individualist ↔ Collectivist" at 50/50
R/B and watch it land exactly on the R/B seam — your source doc's own example, working.*

**10. Persistence.** → *Save, quit, relaunch, open → same mosaic; Run reproduces the same artwork.
Round-trip deep-equality test; a golden `.mosaic.json` committed to the repo that must keep loading
forever; assert a v2-labeled file is refused rather than silently degraded.*

**11. PNG export + hardening pass.** → *A 4096px PNG that looks materially better than the screen
version. Assert a 1× export is pixel-identical to the display render — a real regression test on the
whole tone-mapping path.*

**12. Package.** `electron-builder --win nsis` → install, launch from Start Menu, full run, export.

---

## Verification

**Numerics — ordered by how much real breakage they catch:**

1. **`elementStiffness`** (highest-value test in the suite): all 64 entries against the golden table
   to 1e-15; exact symmetry; every row sums to 0; `‖KE·[0.5,−0.5,0.5,0.5,−0.5,0.5,−0.5,−0.5]‖∞ < 1e-14`
   (rigid rotation in the null space); `trace = 8·45/91`; `rank = 5`.
2. **Patch test** — catches plane-stress vs plane-strain, wrong ν, and wrong DOF ordering, all of
   which produce *plausible-looking wrong answers*. Apply `u_x = εx, u_y = −νεy` with ε=1e-3 to one
   unit element: `|uᵀKE·u − 1e-6| < 1e-18`. Repeat on a 4×4 patch, interior residuals < 1e-12.
3. **MBB iteration-1 compliance vs top88** — the best regression test available. `nelx=60, nely=20`,
   uniform `x=0.5`, `p=3`, `Emin=1e-9`, `w≡1`, single solve. Path-independent, so it's a *hard*
   number, and it validates assembly + DOF order + BCs + CG accuracy simultaneously. **Get the value
   from an actual Octave/MATLAB run of top88 and lock it in.**
4. **Converged MBB** — assert **loosely** (`190 < c < 225`) plus a topology snapshot. Record your own
   converged value on the first green run and lock *that*. Do not hardcode a tight literal from
   anyone's memory, mine included.
5. **Solid cantilever vs Euler-Bernoulli**, within 10% (Q4 shear-locks in bending). A DOF-order or BC
   bug shows here as a factor of 2 or a sign flip, not as 3%.
6. **CG vs dense** on a 4×4 mesh: `‖u_pcg − u_dense‖∞ < 1e-10`, `u[c] === 0` exactly at every fixed DOF.
7. **Island regression test** — the one protecting the connectivity pass. Synthetic disconnected blob:
   assert it's detected, its DOFs are in `fixedMask`, and **CG converges within 2× the island-free
   iteration count.** Without the pass this needs thousands of iterations — the production failure
   mode, made visible in CI.
8. Filter symmetry, rows sum to 1, constant field maps to itself. OC: volume to 1e-6, move limit
   respected, `SOLID_PASSIVE` untouched, bracket-expansion branch exercised. Mesh index round-trips.
   Seed determinism (byte-identical), `s_e=1` for monochrome, `s_e≈0.577` for equal three-way,
   `w_e ∈ [0.15,1]`, all-neutral answers still yield ≥3 pins and `‖F‖>0`. BESO volume schedule
   exact, additions ≤ `AR_max·nDesign`.

**End-to-end, by hand:** build a profile of ~15 pairs → seed mosaic appears live while dragging →
Run → watch erosion → structure classifier names a Roccas & Brewer morphology → export 4096px PNG →
save → relaunch → open → press Run → **byte-identical final density.** Then build a deliberately
*dominant* profile (one category >55% of salience) and a deliberately *hybrid* one (many two-category
blends, strong lean) and confirm they produce **structurally** different art — a one-sector fan/wing
vs a braided arch across a sector boundary. If they only differ in color, the placement `δ` skews
aren't doing their job; that's the check that the whole model works.

**Instrumentation to ship from day one** (these are how you debug the art, not just the code):
`cgIters`, `cgResidual`, `islands`, `unsupportedLoads`, `compliance`, `volume`, `changeLinf` per
frame, plus a dev panel exposing `w_min`, `rmin`, `σ₀`, `solidLo/Hi`.

---

## Risks, ranked

1. **Module worker under packaged `file://`.** Highest-probability blocker. Retired on day one by
   Step 1 testing the *built* output; contained by `SolverSession.ts` being the only file naming
   `Worker`. Fallback `?worker&inline`.
2. **CG iteration count.** The 25–80 estimate assumes the connectivity pass works. If you measure
   300+, it's almost always a hole in the supported-DOF mask (a one-node hinge, or a component
   reachable only diagonally). Diagnose from `cgIters` + `islands` + newly-constrained-DOF count.
   Escalate: verify the mask → `Emin` to 1e-4 → `rmin` to 3.0 → N=64 → build multigrid.
3. **`σ_min` vs `rmin` interaction.** If `σ < rmin` the filter erases the seed before the optimizer
   acts and **every person's mosaic looks the same** — the whole app silently flattens. Assert
   `σ_min ≥ rmin` at init. This was marginally violated in the original constants.
4. **`w_min = 0.15` is a guess.** Too high, discordance is invisible; too low, series-bottleneck
   thickening dominates and every mosaic grows fat central buttresses. Expect to tune in [0.1, 0.35]
   against real output. Dev-panel slider from day one.
5. **StrictMode double-mount → two workers.** Doubled frame rate, interleaved garbage. Looks exactly
   like a solver bug; isn't.
6. **`RunStatus` above `MosaicCanvas`.** Silently reintroduces 10Hz whole-tree re-renders after all
   the work to avoid them. Caught by the Step 5 render counter.
7. **`atan2(0,0) === 0`.** A silent *semantic* bug, not a crash — the worst kind. Asserted in Step 3.
8. **Angular crowding.** ~65 of 79 pairs are single-category, so 20 Associative answers all pile near
   300°. Jitter in arc length, slot by answer index within the user's set (never library position),
   and run the relaxation pass. Asserted in Step 3.
9. **Mask-change chatter.** If `islands`/`cgIters` oscillates period-2, widen hysteresis from
   0.08/0.12 to 0.06/0.15.
10. **Windows fractional DPI**, `DOM`+`WebWorker` in one tsconfig, and the space in the project path
    (first suspect for any inexplicable electron-builder error). All addressed above.

---

## For the writeup — the honest limits

Worth building in, because naming them is what separates a good class project from a demo:

1. **The model asserts a metric the paper explicitly refuses.** Chao & Moon's central methodological
   complaint is that "reliance on any single measure as a proxy... will provide unstable results"
   (p. 1129) — yet every pair here carries a developer-authored 3-vector and scalar immutability.
   There's no empirical basis for "family is the unit of decision = 35% Demographic." And the three
   categories aren't orthogonal (ethnicity/race overlap; regional identity is both geographic and
   associative), so the RGB basis isn't a basis. *Partially fixable:* let users edit any pair's
   weights, converting a hidden assertion into a visible choice. Note that the paper *chose* the
   three-primary analogy knowing the categories interpenetrate — you inherit a known simplification.
2. **Concordance is computed on hue, but hue encodes *domain*, not *content*. The deepest flaw.**
   "Moral rules are fixed" and its own opposite pole are both ≈ pure Associative, so two flatly
   contradictory items read as *maximally concordant*. The authored antagonist list is a patch
   covering ~20 pairings out of thousands. *Fixable in code, and the highest-value v2:* carry a
   second per-item vector on 4–6 Schwartz-style value axes and compute concordance in *that* space,
   keeping RGB purely for color and placement.
3. **The optimizer systematically destroys the phenomenon Prop 3(c) names.** Compliance minimization
   exists to eliminate structural redundancy; Prop 3(c) says structurally redundant identities are
   real and are what make behavior unpredictable. *Inherent to the metaphor, but well mitigated —
   and this is the best visual idea available:* render the eroded material as a faint **ghost layer**,
   so you show both the optimized structure (concordant, load-bearing) and the trace of what was
   removed (independent, unpredictable) in one image. Cheap, and it makes the image say something
   the optimizer alone cannot.
4. **Immutability is modeled as a property of the trait; it's actually a property of a situation.**
   "One country claims me" at m=0.80 is authorial biography imposed on a refugee or a dual national —
   and since `m` sets the radius, it decides who gets to be bedrock and who is a passing load.
   *Cheaply fixable:* the per-pair fixedness override (already in the plan). Better art too, because
   two people answering identically on content but differently on fixity then get different structures.
5. **The deterministic mapping is smooth, which undercuts the chaos framing.** The
   placement/deposit pipeline is Lipschitz, and SIMP *with* density filtering is specifically
   engineered to be stable. The app will convincingly demonstrate **emergence** and
   **self-organization** (which is what Wolfram and Prop 3 actually claim). It probably will not
   demonstrate **chaos**. *A framing fix — and honesty beats the claim:* ship a **sensitivity mode**
   that re-runs with exactly one slider moved one notch and reports whether the topology *class*
   flipped. If it sometimes flips, you have your own evidence for Prop 2's "discontinuous activation
   event." If it never does, "my model shows emergence but not chaos, and here is the measurement"
   is a substantially better paper than asserting chaos and hoping nobody checks.

**Bonus, best single addition:** the radial layout encodes a *contestable* sociological claim — that
birth facts are literally load-bearing bedrock. That cuts against Chao & Moon's bottom-up framing in
which associative tiles are fully cultural and not subordinate to demographics. **Add a toggle that
inverts it** (chosen associations pin, inherited traits load) and render both side by side. A few
lines of code, and it demonstrates that the artwork depends on an *interpretive* decision rather
than a natural one.
