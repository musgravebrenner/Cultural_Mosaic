# Cultural Mosaic — Numerical Core Design

Greenfield. Everything below is decided, not offered. Units: element edge `h = 1`, thickness `t = 1`, `E0 = 1`, `nu = 0.3`, plane stress.

---

## A. Mesh and domain

### A.1 Resolution

**Default: `nelx = nely = 96`.** Presets: Draft 64, Standard 96, Gallery 128.

| N | total elems | active (disc) | ndof | nnz(K) | est. assemble | est. CG matvec | warm CG iters | est. ms/iter |
|---|---|---|---|---|---|---|---|---|
| 64 | 4096 | ~3170 | 8450 | ~115k | 0.6 ms | 0.5 ms | 20–40 | 15–30 |
| **96** | **9216** | **~6940** | **18818** | **~255k** | **1.4 ms** | **1.2 ms** | **25–60** | **45–100** |
| 128 | 16384 | ~12470 | 33282 | ~455k | 2.5 ms | 2.2 ms | 35–80 | 90–200 |

Justification for 96:
- **Cost model.** Per optimization iteration you pay 1 assembly + `n_cg` CSR matvecs + 1 sensitivity pass + 1 filter pass + ~15–60 bisection passes. Everything except the CG loop is under 4 ms. The whole budget is `n_cg x t_matvec`. `nnz ≈ 18 x ndof` (each node couples to a 3x3 node stencil = 9 nodes = 18 DOFs). At 255k nnz, a CSR matvec is 255k FMA + 255k sequential index loads + 255k semi-random `x` loads; measured JS throughput for this pattern on Float64Array is ~200–400 M effective FMA/s, giving **1.2 ms**. 60 CG iterations = 72 ms. Fits the 200 ms budget with 2x headroom.
- **Visual model.** With `rmin = 2.4`, minimum member width ≈ `2 x rmin ≈ 5` elements. A 94-element-diameter disc therefore supports ~19 resolvable members across it — enough for a genuine truss, not enough to look like noise. At N=64 you get ~13 members (chunky); at 128, ~25 (filigree, and CG cost triples because iterations grow ~O(N) while matvec grows ~O(N²)).
- **96 = 2^5 x 3** halves cleanly twice (96 → 48 → 24), which the Phase-2 multigrid preconditioner (§C.6) needs.

CG iteration count is the **single biggest unknown** in this estimate. Mitigations in §C.

### A.2 Index arithmetic (exact)

Column-major, `iy` increasing **downward**. This matches the top88 `edofMat` convention so the closed-form `KE` in §B drops in without permutation.

```
nnodex = nelx + 1;  nnodey = nely + 1;
ndof   = 2 * nnodex * nnodey;
nelem  = nelx * nely;

nodeId(ix, iy) = ix * nnodey + iy            // ix in [0,nelx], iy in [0,nely], iy down
dofX(n) = 2*n ;  dofY(n) = 2*n + 1

elemId(ex, ey) = ex * nely + ey              // ex in [0,nelx-1], ey in [0,nely-1]
ex = (e / nely) | 0 ;  ey = e - ex*nely

// element corner nodes
n_tl = ex * nnodey + ey
n_bl = n_tl + 1
n_tr = n_tl + nnodey
n_br = n_tr + 1

// element DOF vector, CCW from bottom-left in physical (y-up) coords.
// MUST be this order to match KE.
edof[0..7] = [ 2*n_bl, 2*n_bl+1,   2*n_br, 2*n_br+1,
               2*n_tr, 2*n_tr+1,   2*n_tl, 2*n_tl+1 ]
```

Physical coordinates (y-up for the math, flip only at render time):

```
nodePos(ix,iy)  = ( ix,        nely - iy )
elemCentroid(e) = ( ex + 0.5,  nely - ey - 0.5 )
cx0 = nelx/2 ; cy0 = nely/2
r(e)     = hypot(cxe - cx0, cye - cy0)
theta(e) = atan2(cye - cy0, cxe - cx0)   normalized to [0, 2*PI)
```

Because the elements are **squares**, the Q4 plane-stress `KE` is *exactly independent of `h`* (`B ~ 1/h`, area `~ h²`, so `K ~ h²/h² = const`). Using `h = 1` is not an approximation. Do not introduce an `h` scale factor; it is a common source of silent bugs.

### A.3 Disc mask

```
Rmax = min(nelx, nely)/2 - 1.0        // = 47.0 at N=96
```

Three element states, in a `Uint8Array elemState(nelem)`:

| state | value | condition | rho | in volume constraint | in filter | assembled |
|---|---|---|---|---|---|---|
| `VOID_PASSIVE` | 0 | `r(e) > Rmax` | fixed `rho_min` | no | no | **no** |
| `FREE` | 1 | inside disc, not a patch | design variable | yes | yes | yes |
| `SOLID_PASSIVE` | 2 | load/pin patch (§E.5) | fixed `1.0` | yes, as a constant | yes | yes |

Keep **full-length** `nelem` arrays for `rho`, `color`, `w`, `dc` (index arithmetic stays O(1), rendering is trivial, and 9216 doubles is 74 KB). Loop only over precomputed `Int32Array` lists:

```
designList : Int32Array   // states 1 and 2 ; length nDesign (~6940)
freeList   : Int32Array   // state 1 only  ; length nFree
```

`VOID_PASSIVE` elements are **not assembled at all**. Their `Emin` contribution is numerically irrelevant, and omitting them means the support of `K` is exactly the disc. Consequence: DOFs not touched by any design element are permanently constrained, folded into the fixed-DOF mask at init.

**Volume constraint bookkeeping.** With `Vfrac` the target and `nSolid = |SOLID_PASSIVE|`:

```
V_target_total = Vfrac * nDesign
V_target_free  = V_target_total - nSolid        // budget for the free elements
```

Assert `V_target_free > 0.05 * nFree` at init; if the passive-solid patches alone exceed the budget, raise `Vfrac` and warn (this happens if the user answers ~36 pairs at full intensity with a small `Vfrac`).

---

## B. Element stiffness

### B.1 Construction (use this, don't hardcode decimals)

Exactly the Sigmund/Andreassen top88 form, which is the analytically integrated Q4 unit-square plane-stress matrix:

```
A11 = [[12, 3, -6, -3], [ 3, 12,  3,  0], [-6,  3, 12, -3], [-3,  0, -3, 12]]
A12 = [[-6,-3,  0,  3], [-3, -6, -3, -6], [ 0, -3, -6,  3], [ 3, -6,  3, -6]]
B11 = [[-4, 3, -2,  9], [ 3, -4, -9,  4], [-2, -9, -4, -3], [ 9,  4, -3, -4]]
B12 = [[ 2,-3,  4, -9], [-3,  2,  9, -2], [ 4,  9,  2,  3], [-9, -2,  3,  2]]

A = (A11 + nu*B11) / (24*(1 - nu^2))
B = (A12 + nu*B12) / (24*(1 - nu^2))
KE = [[A, B], [B^T, A]]          // 8x8, row-major Float64Array(64)
```

For `nu = 0.3` the scale factor is `1/21.84`. Exact rational entries:

```
a = 45/91   = 0.4945054945054945     d = -5/364  = -0.0137362637362637
b =  5/28   = 0.1785714285714286     e = -45/182 = -0.2472527472527473
c = -55/182 = -0.3021978021978022    f =  5/91   =  0.0549450549450549
```

Golden 8x8 (assert every entry to 1e-15 in a unit test):

```
row0:  0.4945054945  0.1785714286 -0.3021978022 -0.0137362637 -0.2472527473 -0.1785714286  0.0549450549  0.0137362637
row1:  0.1785714286  0.4945054945  0.0137362637  0.0549450549 -0.1785714286 -0.2472527473 -0.0137362637 -0.3021978022
row2: -0.3021978022  0.0137362637  0.4945054945 -0.1785714286  0.0549450549 -0.0137362637 -0.2472527473  0.1785714286
row3: -0.0137362637  0.0549450549 -0.1785714286  0.4945054945  0.0137362637 -0.3021978022  0.1785714286 -0.2472527473
row4: -0.2472527473 -0.1785714286  0.0549450549  0.0137362637  0.4945054945  0.1785714286 -0.3021978022 -0.0137362637
row5: -0.1785714286 -0.2472527473 -0.0137362637 -0.3021978022  0.1785714286  0.4945054945  0.0137362637  0.0549450549
row6:  0.0549450549 -0.0137362637 -0.2472527473  0.1785714286 -0.3021978022  0.0137362637  0.4945054945 -0.1785714286
row7:  0.0137362637 -0.3021978022  0.1785714286 -0.2472527473 -0.0137362637  0.0549450549 -0.1785714286  0.4945054945
```

I have verified: symmetric to machine precision; `trace = 8 x 45/91 = 3.956...`; both rigid translations and the rigid rotation `d = [0.5,-0.5, 0.5,0.5, -0.5,0.5, -0.5,-0.5]` lie in the null space (`||KE d||_inf < 1e-15`), so `rank(KE) = 5`. If your generated matrix fails any of these, the DOF ordering is wrong.

Also store the packed 36-entry upper triangle `KE_U` for the quadratic form in §D.1 (halves the flops of `u_e^T KE u_e`).

Plane-stress constitutive matrix (needed for the patch test and for an optional von Mises overlay):

```
D = 1/(1-nu^2) * [[1, nu, 0], [nu, 1, 0], [0, 0, (1-nu)/2]]
  = [[1.0989011, 0.32967033, 0], [0.32967033, 1.0989011, 0], [0, 0, 0.38461538]]
```

### B.2 Material interpolation

Modified SIMP, with the concordance multiplier `w_e` from §E.3 folded in:

```
E(e) = w_e * ( Emin + rho_e^p * (E0 - Emin) )
dE/drho(e) = w_e * p * rho_e^(p-1) * (E0 - Emin)
```

**Constants:**

| symbol | value | why |
|---|---|---|
| `E0` | `1.0` | normalization; compliance is reported relative to iteration 1 anyway |
| `Emin` | `1e-6` | top88 uses `1e-9`. Raised three decades because the user-driven seed makes thin one-node hinges and near-islands likely, and `Emin` sets a floor on `cond(K)` contributed by any such feature the connectivity pass (§C.5) fails to catch. `1e-6` is 6 decades below `E0` — visually indistinguishable from void — but bounds the worst uncaught contrast at `1e6` instead of `1e9`. Guarantees `K` is SPD unconditionally. |
| `rho_min` | `1e-3` | lower OC bound; `E(rho_min) ≈ Emin`, consistent |
| `p` | `3.0` | **fixed, no continuation** |

**No continuation on `p`.** Continuation (p: 1 → 3) exists to steer from a uniform gray start into a good basin. Here the seed field *is* a purpose-built non-uniform initial guess that already breaks symmetry along culturally meaningful directions — continuation would fight it, and it roughly doubles the iteration count, which the interactive animation cannot afford.

**Exception — the export "hardening pass":** when the user clicks Export, run 20 extra iterations ramping `p: 3 → 4.5` linearly and `move: 0.2 → 0.05`. This drives the remaining gray to black/white for a crisp print without changing the topology. Ship this; it visibly improves the artifact.

---

## C. Solver

### C.1 Assembled CSR, not matrix-free. Decided.

Cost accounting per optimization iteration:
- EBE matrix-free matvec: `nDesign x 64` FMA = 444k, plus 8 gathers + 8 scatters per element (scatter also needs care) ≈ **1.9x the cost of one CSR matvec**.
- Assembled CSR matvec: `nnz` = 255k FMA, sequential in the values array.
- Re-assembly per iteration: `nDesign x 64` accumulations = 444k, i.e. **≈ 1 EBE matvec, paid once**.

Break-even is at `n_cg ≈ 2`. We run 25–80. **Assembled CSR wins by ~1.9x on the dominant term**, and additionally gives you the exact diagonal for free (Jacobi), an easy path to SSOR/IC(0) or a direct fallback, and a clean object to unit-test against a dense reference.

The mesh **never changes**, so build the pattern and the scatter map once:

```
// ONCE, at init:
// 1. Pattern. For each e in designList, for each i,j in 0..7 emit (edof[i], edof[j]).
//    Count-then-fill into rowStart/colIdx, sort each row, dedupe.
//    -> rowPtr: Int32Array(ndof+1), colIdx: Int32Array(nnz)
// 2. Scatter map. For each e, for each k = 8*i + j, binary-search colIdx within
//    row edof[i] for column edof[j]; store the position.
//    -> scatter: Int32Array(nDesign * 64)          (1.8 MB at N=96)
// 3. diagPos: Int32Array(ndof), position of (i,i) in values.

// EVERY iteration:
values.fill(0);
for (let a = 0; a < nDesign; a++) {
  const e = designList[a];
  const Ee = w[e] * (Emin + Math.pow(rho[e], p) * (E0 - Emin));
  const base = a * 64;
  for (let k = 0; k < 64; k++) values[scatter[base + k]] += Ee * KE[k];
}
for (let i = 0; i < ndof; i++) { diag[i] = values[diagPos[i]]; }
for (const c of fixedDofs) diag[c] = 1.0;         // preconditioner safety
for (let i = 0; i < ndof; i++) if (diag[i] <= 0) diag[i] = 1.0;   // untouched DOFs
```

Store the **full** matrix (both triangles). 255k doubles = 2.0 MB; not worth the write-conflict complexity of a symmetric matvec.

### C.2 Jacobi-preconditioned CG with explicit DOF masking

`fixedMask: Uint8Array(ndof)`, 1 = constrained. The invariant that makes this correct: **every vector in the Krylov space is exactly zero at constrained DOFs.** You get that by zeroing `f`, `u0`, and the output of every matvec.

```
function pcg(values, rowPtr, colIdx, diag, f, u, fixedMask, tolRel, maxIter) {
  // Precondition: f[c] == 0 and u[c] == 0 for all constrained c. Enforce, don't assume.
  for (c of fixed) { f[c] = 0; u[c] = 0; }

  spmv(values, rowPtr, colIdx, u, Ku);
  for (i) r[i] = f[i] - Ku[i];
  for (c of fixed) r[c] = 0;                       // <-- essential

  for (i) z[i] = r[i] / diag[i];
  for (c of fixed) z[c] = 0;
  for (i) pv[i] = z[i];
  let rz = dot(r, z);
  const bnorm = norm2(f);
  const tol   = Math.max(tolRel * bnorm, 1e-300);

  for (k = 0; k < maxIter; k++) {
    spmv(values, rowPtr, colIdx, pv, q);
    for (c of fixed) q[c] = 0;                     // <-- essential: K*p is nonzero at c
    const alpha = rz / dot(pv, q);
    for (i) { u[i] += alpha * pv[i]; r[i] -= alpha * q[i]; }
    const rn = norm2(r);
    if (rn <= tol) return { iters: k+1, residual: rn / bnorm, converged: true };
    for (i) z[i] = r[i] / diag[i];
    for (c of fixed) z[c] = 0;
    const rzNew = dot(r, z);
    const beta  = rzNew / rz;  rz = rzNew;
    for (i) pv[i] = z[i] + beta * pv[i];           // pv[c] stays 0 automatically
  }
  return { iters: maxIter, residual: norm2(r)/bnorm, converged: false };
}
```

Note: `r[c] = 0` and `q[c] = 0` are the *only* two places masking is required for correctness; the `z[c] = 0` lines are redundant given `diag[c] = 1` and `r[c] = 0`, but keep them as cheap assertions of intent. Do **not** modify `values` to enforce BCs (no row/column zeroing) — it destroys the precomputed scatter map's validity and is unnecessary.

**Tolerances and caps:**

| parameter | value | rationale |
|---|---|---|
| `tolRel` (animation) | `1e-4` on `||r||_2/||f||_2` | compliance is a quadratic functional of `u`; a `1e-4` residual gives a compliance error far below the `1e-3`-level density changes the optimizer is making. Inexact solves at this level are established practice (Amir & Sigmund). |
| `tolRel` (final iter / export) | `1e-7` | for a trustworthy reported compliance number |
| `maxIter` (animation) | `600` | 600 x 1.2 ms = 720 ms hard ceiling. On non-convergence, **proceed anyway** and surface `cgResidual` + a warning badge in the UI. Never hang. |
| `maxIter` (export) | `4000` | |

### C.3 Warm start — honest numbers

Reuse the previous iteration's `u` as `u0`. Expected speedup: **1.5–2.0x, not 10x.** The arithmetic: CG's residual reduction per iteration is roughly `rho_cg = (sqrt(kappa)-1)/(sqrt(kappa)+1)`, so iterations ≈ `ln(reduction)/ln(1/rho_cg)`. Cold start needs a reduction of `1e4`; warm start after iteration ~15 (when `||Δrho||_inf ≈ 0.03`) starts at a relative residual of ~0.03 and needs only ~`3e2`. Ratio of logs: `ln(1e4)/ln(3.3e2) = 9.2/5.8 = 1.6x`. During the first ~10 iterations `Δrho` is at the move limit (0.2) and the benefit is smaller, ~1.2x.

Two rules that make warm start *correct* rather than merely fast:
1. **When the supported-DOF mask changes (§C.5), zero `u0` at every newly-constrained DOF** before entering CG. Otherwise `r[c] = 0` silently discards a nonzero component of `u` and the initial residual is inconsistent.
2. Keep two `u` buffers; never write into the one you might need to fall back to.

Do **not** attempt linear extrapolation `u0 = 2u_{k-1} - u_{k-2}`. It helps when densities move smoothly and actively hurts across a topology change; not worth the branch.

### C.4 Cheap additional win: adaptive tolerance

```
tolRel_k = clamp(0.02 * changeLinf_{k-1}, 1e-6, 1e-3)
```
where `changeLinf` is `max|rho_k - rho_{k-1}|`. Early iterations (big moves, sloppy gradients acceptable) get `1e-3`; converged iterations tighten automatically. Typical saving: another 1.3–1.6x. Cheap, safe, recommended.

### C.5 Floating / disconnected material — the main failure mode

This is correctly identified as the highest risk. **Four layers of defense; implement all four.**

**Layer 1 — `Emin = 1e-6` floor.** Guarantees `K` is symmetric positive-definite for *any* `rho in [rho_min, 1]^n`, so CG never divides by a non-positive `p^T K p`. This is the mathematical safety net, not the performance fix: an island of solid material connected to the anchored structure only through `Emin` material has a near-rigid-body mode with eigenvalue `~Emin`, so `kappa ~ E0/Emin x N²` and Jacobi-PCG would need thousands of iterations. Jacobi does *not* fix this — it normalizes the diagonal, but the island's low mode survives.

**Layer 2 — connected-component pass + supported-DOF elimination.** This is the actual fix. Run **every iteration** (cost: BFS over 9216 cells, < 0.5 ms):

```
// solidSet with hysteresis to prevent chattering:
//   e enters solidSet if rho[e] > 0.12 ; leaves if rho[e] < 0.08 ; else keeps last state.
// 4-connectivity BFS/union-find over designList restricted to solidSet.
// A component is ANCHORED if it contains any element having a corner node in pinnedNodes.
// supportedDof[d] = 1 iff d belongs to some element in an anchored component.
// fixedMask = pinnedDofs OR (NOT supportedDof)
```

With unsupported DOFs constrained to zero, the solved system's condition number is governed by **geometry only** (`kappa ~ N²`), independent of the density contrast. This is what keeps CG at 25–80 iterations instead of thousands.

Continuity concern is small and bounded: an element crossing the 0.12/0.08 hysteresis band contributes at most `E(0.12) = 1e-6 + 1.7e-3 ≈ 1.7e-3` of stiffness, so the compliance discontinuity is O(0.1%) — well below the OC step size. Hysteresis prevents the mask from oscillating between iterations.

**Layer 3 — load-point handling.** If a load DOF lands in the unsupported set, zero that load component for the solve and increment `unsupportedLoads`. Report it to the UI: *"this identity has no cultural highway to the rim."* That is a legitimate analytic output of the artwork, not just an error. But it is also a gradient dead end (a zeroed load generates no sensitivity pulling material toward it), so:

**Layer 4 — never let the optimizer be handed a disconnected starting point, and never let it delete a load.**
- `rho_init` has a **floor of 0.25 everywhere inside the disc** (§E.2). At iteration 1 the entire disc is one connected component containing every pin and every load. The user's answers therefore *cannot* create a disconnected initial state — disconnection can only arise from the optimizer's own choices, and compliance minimization will not sever a path it needs.
- Every load node and every pin node gets a **`SOLID_PASSIVE` 3x3 element patch** (`rho ≡ 1`, radius 1.5 elements). This is standard practice for point loads in topology optimization: it removes the degenerate "delete the material under the load, compliance goes to zero" local minimum and eliminates the mesh-dependent stress singularity at a single-node load.

**Layer 5 (reporting only).** Count non-anchored components with total volume > 8 elements and expose `islands: n` per frame. Small islands are normal mid-run and shrink away; a persistent large island after iteration 40 means the seed genuinely partitioned the domain, and the UI should say so.

### C.6 Phase 2: MGCG (implement only if N=128 misses budget)

Geometric multigrid V-cycle used *as the PCG preconditioner* (Amir/Aage/Lazarov). Gives roughly mesh-independent iteration counts (~10–25) and a 5–15x speedup at N=128.

- Hierarchy `96 → 48 → 24` (3 levels).
- Coarse operators by **re-discretization with 2x2 density averaging** (`rho_coarse = mean of 4 children`, then the same `E(rho)` and the same `KE` — remember `KE` is `h`-independent for squares, so the coarse element matrix is *identical*). This is far cheaper than Galerkin `P^T K P` and entirely adequate as a preconditioner.
- Prolongation `P`: bilinear, applied independently per displacement component. For a fine node coincident with a coarse node, weight 1; edge-midside, `[1/2, 1/2]`; cell-center, `[1/4 x 4]`. Restriction `R = P^T` (full weighting).
- Smoother: 2 pre- and 2 post-sweeps of damped Jacobi, `omega = 0.6` (Gauss-Seidel is ~1.5x better per sweep but is order-dependent; use Jacobi for reproducibility across runs).
- Coarsest level (24x24, ndof = 1250): 200 Jacobi-PCG iterations, or a dense Cholesky — either is < 1 ms.
- Zero the fixed-DOF entries after *every* smoothing sweep and after every prolongation/restriction, on every level. The coarse-level fixed set is the set of coarse DOFs whose prolongation stencil touches only fine fixed DOFs.

---

## D. Sensitivity and update

### D.1 Compliance and its derivative

With `K = sum_e E(e) * KE` and `K u = f`, `f` independent of `rho`:

```
ce_e = u_e^T KE u_e                                    // >= 0, the unit-E strain energy x2
c    = sum_{e in designList} E(e) * ce_e   ( == f^T u )
dc/drho_e = -( dE/drho(e) ) * ce_e
          = -w_e * p * rho_e^(p-1) * (E0 - Emin) * ce_e      <= 0
dv/drho_e = 1                                          // unit element area
```

Evaluate `ce_e` with the packed upper triangle:

```
let s = 0;
for (i = 0; i < 8; i++) {
  const ui = u[edof[i]];
  s += KE_U[idx(i,i)] * ui * ui;
  for (j = i+1; j < 8; j++) s += 2 * KE_U[idx(i,j)] * ui * u[edof[j]];
}
```
36 terms x 6940 elements = 250k FMA, ~0.8 ms. Also assert `f^T u == sum E(e)*ce_e` to 1e-9 once per run in dev builds — it catches DOF-ordering and assembly bugs immediately.

### D.2 Filter: sensitivity filter (Sigmund). Decided.

**Choose the sensitivity filter, not the density filter.** Three reasons: (1) it is what top88 pairs with OC and is the most robust combination known for this problem class; (2) it requires no chain rule, so the SIMP and BESO code paths share it identically — a density filter would need `drho_phys/drho` propagation that BESO's discrete update cannot use; (3) it is cheaper (one sparse apply per iteration, no second apply for the chain rule).

Cost of that choice, stated plainly: the sensitivity filter is a heuristic, not a consistent gradient, so the compliance history can be mildly non-monotonic and you cannot bolt on Heaviside projection for perfectly crisp 0/1 results. The §B.2 hardening pass covers the crispness need. If you later want projection, that's the moment to switch to a density filter.

```
H_ei  = max(0, rmin - dist(centroid_e, centroid_i))     // linear "cone" weights
Hs_e  = sum_i H_ei
dcF_e = ( sum_i H_ei * rho_i * dc_i ) / ( Hs_e * max(rho_min_filter, rho_e) )
        with rho_min_filter = 1e-3
```

**`rmin = 2.4` elements** (default; expose 1.5–4.0). Sets minimum member width ≈ 4.8 elements ≈ 5% of the disc diameter → ~19 resolvable members. Below 1.8 you get checkerboarding and hinges (which also hurts CG conditioning); above 3.5 the mosaic reads as blobs rather than a truss.

Precompute `H` once as CSR over the **design element list** (never touch `VOID_PASSIVE`):

```
hRowPtr : Int32Array(nDesign + 1)
hColIdx : Int32Array(nnzH)        // compact design-list indices, not global elem ids
hVal    : Float64Array(nnzH)
hSum    : Float64Array(nDesign)
```

`nnzH` = lattice points within radius 2.4 ≈ 17–21, so `nnzH ≈ 6940 x 19 ≈ 132k`. Build by scanning the `ceil(rmin)`-radius square window around each element and skipping non-design neighbors. Memory ~1.6 MB, build time ~10 ms, once. Apply cost 132k FMA = ~0.4 ms.

Properties to unit-test: `H_ei == H_ie` (symmetry); `sum_i H_ei / Hs_e == 1`; the filter reproduces a constant sensitivity field exactly.

Reuse this same `H` for the color-coherence field in §E.3 — one neighbor structure, three consumers (sensitivity filter, BESO averaging, coherence).

### D.3 OC update

```
eta   = 0.5          // damping exponent (the classic sqrt)
move  = 0.2          // move limit
l1 = lam_prev / 4 ; l2 = lam_prev * 4       // warm bracket; l1=1e-9, l2=1e9 on iteration 1

// expand bracket if the warm guess doesn't straddle the root (rare, but must be handled)
while (volAt(l1) < V_target_free) l1 /= 4;
while (volAt(l2) > V_target_free) l2 *= 4;

while ((l2 - l1) / (l1 + l2) > 1e-3) {
  const lmid = 0.5 * (l1 + l2);
  // Be = -dcF_e / (lmid * dv_e)  with dv_e = 1
  for (a in freeList) {
    const e = freeList[a];
    const Be = -dcF[e] / lmid;                       // >= 0
    const t  = rho[e] * Math.pow(Be, eta);           // eta = 0.5 -> Math.sqrt(Be)
    rhoNew[e] = Math.min( Math.min(1, rho[e] + move),
                Math.max( Math.max(rho_min, rho[e] - move), t ) );
  }
  if (sum(rhoNew over freeList) > V_target_free) l1 = lmid; else l2 = lmid;
}
lam_prev = 0.5 * (l1 + l2);
changeLinf = max |rhoNew - rho| over freeList;
```

Guards: clamp `Be` at 0 from below before the power (a positive `dcF_e` can occur because the sensitivity filter is a heuristic — do not let it produce a NaN); skip `SOLID_PASSIVE` elements entirely (they stay 1.0 and are already accounted in `V_target_free`).

The warm bracket cuts bisections from ~58 to ~15 (each is a 6940-element pass), saving ~1 ms/iteration. Small, but free.

**Convergence / stopping:** stop when `changeLinf < 0.01` for 3 consecutive iterations, or at `maxIter = 120` (animation) / `250` (export). Report both to the UI.

### D.4 BESO mode

BESO shares the FEA core **completely unchanged**. `rho` is simply restricted to `{x_min, 1}` with `x_min = 1e-3` and fed into the same `E(rho) = w*(Emin + rho^p(E0-Emin))` (soft-kill BESO, Huang & Xie). Same assembly, same CG, same `ce_e`, same `H`. Only the update step differs, and only the sensitivity *number* definition differs slightly.

**Sensitivity number** (unified for solid and void, so voids can be re-admitted):

```
alpha_e = 0.5 * w_e * rho_e^(p-1) * ce_e
```
At `rho = 1` this is `0.5 * w_e * ce_e`; at `rho = x_min = 1e-3` with `p = 3` it is `1e-6` times smaller. Void elements are therefore essentially invisible on their own — **the filter is what lets them be re-admitted**, by borrowing their solid neighbors' values. Do not skip the filter in BESO mode; the algorithm does not work without it.

**Filter (plain weighted average, not the top88 rho-weighted form):**
```
alphaF_e = sum_i H_ei * alpha_i / Hs_e
```

**History averaging — mandatory.** Without it BESO oscillates indefinitely.
```
alphaBar_e^k = 0.5 * ( alphaF_e^k + alphaBar_e^{k-1} )      // alphaBar^0 = alphaF^0
```
Store `alphaBar` in a persistent `Float64Array(nelem)`.

**Volume schedule** (`ER = 0.02`, `V^k` as a fraction of `nDesign`):
```
V^0 = actual volume fraction of the thresholded seed (rho_seed > 0.5 -> solid)
if V^k > Vfrac:  V^{k+1} = max(Vfrac, V^k * (1 - ER))     // erode
else:            V^{k+1} = min(Vfrac, V^k * (1 + ER))     // grow
```
Supporting both directions matters here because the seed volume is user-determined and may start below the target.

**Two-threshold add/remove with `AR_max = 0.05`:**
```
target = round(V^{k+1} * nDesign) - nSolid          // count of FREE elements to be solid

1. Bisect on th over [min alphaBar, max alphaBar] (40 iterations, counting
   free elements with alphaBar > th) until count == target. Provisional split.
2. nAdd = |{ e free : rho_e == x_min AND alphaBar_e > th }|
3. if nAdd <= AR_max * nDesign : accept the single threshold. Done.
4. else: raise a separate ADD threshold th_add by bisection so exactly
   floor(AR_max * nDesign) currently-void elements are promoted. Then set the
   DELETE threshold th_del by bisection over currently-solid elements so that
   (nSolidPrev + nAddCapped - nDel) == target. Apply: promote alphaBar > th_add
   among voids, demote alphaBar <= th_del among solids.
```
Capping additions is what keeps BESO from flooding material back in during the first few iterations after a seed that starts below target.

**BESO convergence test** (Huang & Xie, `M = 5`, `tau = 0.001`):
```
converged  <=>  V^k == Vfrac  AND
                | sum_{i=1..M} (C_{k-i+1} - C_{k-M-i+1}) | / sum_{i=1..M} C_{k-i+1}  <= tau
```
Requires 2M = 10 stored compliance values. `maxIter` for BESO: 150 (it needs `ln(V0/Vfrac)/ln(1/(1-ER))` ≈ 35–50 iterations just to reach the target volume, then ~20 more to settle).

**Artistically:** SIMP produces smooth, cartilage-like gradients (better for a print with soft edges); BESO produces hard black-and-white truss members (better for a graphic, laser-cut, or vinyl output). Offer both; default SIMP.

---

## D2. Volume constraint target

**Derive it from the person's answers, with an Advanced-panel override.**

```
S     = ( sum_i |a_i| ) / nAnswered              // mean identification intensity, in [0,1]
Vfrac = clamp( 0.22 + 0.30 * S, 0.20, 0.55 )
```

Why derived:
1. **It is the point of the app.** Volume fraction is the single most visually dominant parameter — it controls whether the artwork reads as dense and robust or sparse and filigree. If it is a free slider, it *swamps* every other signal from the person's answers and the artwork stops being a portrait. Binding it to total identification strength means "a person with strong, decisive cultural identities gets a dense, load-bearing mosaic; a person who answered mostly near the neutral midpoint gets a thin, tentative one" — which is a direct, defensible reading of the metatheory.
2. **The clamp is a well-posedness requirement, not decoration.** Below ~0.18, a disc carrying 10–20 point loads cannot form a connected truss at `rmin = 2.4`; the optimizer returns disconnected fragments and the connectivity pass starts eliminating loads. Above ~0.60 nothing erodes and you get a solid disc with dimples. `[0.20, 0.55]` is the range where the optimization is both feasible and interesting.
3. **Override, don't hide.** Expose `Vfrac` in an Advanced panel initialized to the derived value, showing both numbers ("derived 0.34 / manual"). Class projects get graded on the mapping being *legible*, and a visible derived-vs-override is legible.

---

## E. Coupling the culture data to the physics

### E.1 Answer → domain position

Authored catalog (`src/culture/wordPairs.ts`), one record per antonym pair:

```
{ id, labelA, labelB, category: 'DEMOGRAPHIC'|'GEOGRAPHIC'|'ASSOCIATIVE',
  immutability: number in [0,1],       // 1 = birthplace, birth sex ; 0 = this week's hobby
  slot: number, slotsInCategory: number }
```

Answers `a_i in [-1, +1]`: `-1` = pole A, `+1` = pole B, `0` = "neither / equally both".

```
sectorStart = { DEMOGRAPHIC: 0, GEOGRAPHIC: 2*PI/3, ASSOCIATIVE: 4*PI/3 }
slotWidth   = (2*PI/3) / slotsInCategory
theta_i     = sectorStart[cat] + (slot + 0.5) * slotWidth
              + 0.35 * slotWidth * a_i                  // the answer's SIGN displaces
                                                        // the deposit within its slot
r_i         = Rmax * ( 0.15 + 0.85 * immutability_i )
amp_i       = |a_i|                                     // intensity, in [0,1]
```

Two decisions embedded there. First, `|a_i|` is the amplitude because for an antonym pair the *midpoint* means weak/ambivalent identification and the *extremes* mean strong identification — that is the correct reading of a bipolar semantic-differential scale, and it makes "strength" fall out of the answers with no extra question. Second, the sign displaces the deposit angularly within its slot (±35% of the slot width), so the two poles of a pair land in geometrically distinct places. This is what makes two different people produce visibly different mosaics rather than the same mosaic at different densities.

`r_i` bottoms out at `0.15 * Rmax`, not 0, so the most fluid identities don't all pile onto the origin.

### E.2 Deposit shape and combination

```
sigma_i = clamp( sigma_min + (sigma_max - sigma_min) * (1 - immutability_i),  2.0,  0.22*Rmax )
          sigma_min = 0.05 * Rmax  (= 2.35 at N=96)
          sigma_max = 0.14 * Rmax  (= 6.58 at N=96)

g_i(e)  = exp( -d(e,i)^2 / (2 * sigma_i^2) )        // d = plain Cartesian distance
                                                    // between element centroid and (r_i, theta_i)
```

**`sigma` is driven by immutability.** Justification: an immutable trait is a sharp, local, unarguable fact — it should deposit as a tight, high-contrast blob. A fluid daily choice diffuses through many aspects of life — it should deposit broadly. This also has a useful geometric side effect: fluid deposits live at small `r` where the angular slots are physically narrow, and a broad `sigma` there is exactly what keeps the center from being a ring of disconnected dots. The **floor of 2.0 elements is a Nyquist constraint** — a Gaussian with `sigma < ~1.5h` aliases on the mesh and produces single-element spikes that the sensitivity filter then smears into artifacts. The **cap at `0.22*Rmax`** prevents one answer from dominating the disc.

Use plain Cartesian distance, not a polar metric. A polar metric would make deposits fan-shaped, and near `r=0` the fan degenerates. Isotropic Gaussians in Cartesian space are the simplest thing that is correct.

**Combination — different rules for color and for density, deliberately:**

```
// Color: ADDITIVE vector accumulation. hue basis vectors are the RGB axes.
hDEMO = (1,0,0) ; hGEO = (0,1,0) ; hASSOC = (0,0,1)
c_e = sum_i  amp_i * g_i(e) * h_{cat(i)}          // Float32Array(3 * nelem)

// Density seed: ADDITIVE accumulation with a SMOOTH SATURATION (never a hard clamp)
A_e       = sum_i  amp_i * g_i(e)
rhoSeed_e = 1 - exp( -lambda * A_e ) ,   lambda = -ln(0.4) = 0.9163
```

Additive color is not an arbitrary choice — it is what makes the concordance field in §E.3 emerge for free. Parallel deposits add to a long vector (high coherence); deposits from different categories partially cancel (low coherence). A weighted *average* would normalize that information away.

Saturating density (`1 - exp(-lambda A)`) rather than `min(1, A)`: a hard clamp creates flat plateaus with `C^0` kinks that the optimizer sees as spurious features. `lambda = 0.9163` is set so a single full-intensity deposit reaches `rhoSeed = 0.6` at its center, leaving headroom for overlaps to read as genuinely denser.

**Initial densities, with the connectivity guarantee:**

```
rhoHat_e = 0.25 + 0.75 * rhoSeed_e                  // 0.25 floor => disc is connected at k=0
// then bisect on scalar t so the volume constraint is satisfied exactly at k=0:
find t : mean_{e in freeList} clamp(t * rhoHat_e, rho_min, 1) == V_target_free / nFree
rho_e^0 = clamp(t * rhoHat_e, rho_min, 1)   for free e ;  1.0 for SOLID_PASSIVE
```
That bisection is the same 15-line routine as the OC bisection — reuse it. The 0.25 floor is what makes user-driven disconnection impossible at startup (see §C.5 Layer 4).

### E.3 Concordance / discordance as a material property

Chao & Moon's Proposition 1 (concordant identity tiles → predictable, strong; discordant → unpredictable, weak) maps to a **scalar per-element stiffness quality multiplier `w_e`**, computed once at seed time and held constant during optimization.

```
// magnitude-weighted directional coherence, over the SAME H neighborhood as the filter
M_e = sum_i H_ei * c_i          (a 3-vector)
Z_e = sum_i H_ei * ||c_i||      (a scalar)
s_e = (Z_e > 1e-9) ? ||M_e|| / Z_e : 0            // in [0, 1] exactly
w_e = w_min + (1 - w_min) * s_e^q ,   w_min = 0.15,  q = 2
```

Why this form:
- `s_e = 1` exactly when all colors in the neighborhood are **parallel** (perfectly concordant), regardless of magnitude — this is the standard spherical-coherence statistic, and it is the natural generalization of pairwise cosine similarity to a whole neighborhood in one pass.
- `s_e` degrades smoothly toward 0 as the neighborhood mixes categories. An equal three-way Demographic/Geographic/Associative mix gives `||(1,1,1)||/3 = 0.577`; a two-way equal mix gives `0.707`; orthogonal-and-opposing content drives it lower.
- Magnitude-weighting is what makes it well-defined where the color field is nearly zero. A naive average of *unit* colors is numerically garbage where `||c|| → 0`. Here the denominator carries the magnitude and the `Z_e < 1e-9` branch defines the empty case cleanly.
- **`w_e > 0` always** (`>= w_min = 0.15`), and `w_e` multiplies `E(e)` as a positive scalar. Therefore `K = sum_e w_e E(rho_e) KE` is a positive combination of PSD element matrices plus the `Emin` floor: **`K` remains symmetric positive-definite unconditionally.** No well-posedness risk. `q = 2` makes the falloff quadratic so partial discordance is punished noticeably but not catastrophically.

`w_e` enters the sensitivity through `dE/drho` (already written in §D.1) — no extra chain-rule term, because `w_e` does not depend on `rho`.

**What this actually produces, and the counterintuitive part you should expect.** The optimizer routes load *around* low-`w` regions whenever an alternative path exists, because weak material needs more volume to buy the same stiffness — so discordant seams erode into voids and trusses detour along concordant ridges. That is the desired artwork. **But** where a load has *no* alternative — a fluid identity surrounded entirely by contradiction — the series-spring sensitivity `dC/drho ~ -F² p /(rho^{p+1} w)` grows *larger* as `w` shrinks, and the optimizer will **thicken** the discordant material rather than erode it. Do not "fix" this. It is the physics being honest, and it is thematically excellent: an identity that can only be supported through contradiction requires a visibly thick, effortful buttress. Put that sentence in the app's explanatory copy; it is the strongest thing the physics gives you for free.

Also note: near the disc center, deposits from all three sectors overlap, so `s_e` is low and `w_e ≈ w_min`. The center will be a weak, contested, thickly-buttressed core. That is the correct reading of "the active daily self is where all three categories contend," and it looks good.

Do **not** add an artificial sensitivity bias (`dcF_e *= w_e^beta`) or a `w`-dependent volume cost. Both break the gradient's meaning and neither is needed — the routing effect above is already the mechanism you want.

### E.4 Phase 2 (highest-value upgrade): orthotropic `w`

Recommend **scalar for v1**. But the anisotropic version is the single best artistic upgrade available, and it is fully well-posed, so spec it now:

Make material stiff **along** iso-color contours and weak **across** color boundaries. Then trusses follow cultural boundaries instead of crossing them.

```
// 1. Per-element 2x2 structure tensor of the color field (central differences on c):
T_e = sum_{k=0..2} (grad c_k)(grad c_k)^T          // then smooth T with H
// 2. Closed-form 2x2 eigendecomposition -> phi_e = angle of the MINOR eigenvector
//    (the along-boundary direction). Coherence check: if (l1-l2)/(l1+l2) < 0.15,
//    the direction is undefined -> fall back to scalar w_e for that element.
// 3. Orthotropic plane stress in the (along, across) frame:
E1 = 1 (along) ; E2 = w_e (across) ; nu12 = 0.3 ; nu21 = nu12*E2/E1 = 0.3*w_e
G12 = sqrt(E1*E2) / (2*(1 + 0.3)) = sqrt(w_e)/2.6
Dloc = 1/(1 - nu12*nu21) * [[E1, nu12*E2, 0], [nu21*E1, E2, 0], [0,0,(1-nu12*nu21)*G12]]
// symmetric because nu12*E2 == nu21*E1 (reciprocity), and
// SPD because E1,E2,G12 > 0 and nu12*nu21 = 0.09*w_e <= 0.09 < 1.   <-- rigorous guarantee
// 4. Rotate by phi_e with the standard 3x3 stress/strain transform: D_e = R^T Dloc R.
// 5. KE_e = sum over 2x2 Gauss points of  B^T D_e B * detJ   (B is 3x8; ~200 flops/elem)
//    Store per-element packed upper triangle: Float64Array(nDesign * 36) = 2.0 MB.
```
Sensitivity is unchanged in form: `dc/drho_e = -p rho^(p-1)(E0-Emin) * u_e^T KE_e u_e`, now with the element's own `KE_e`. Assembly cost is identical (the scatter map doesn't change). The only real cost is the one-time per-element `KE_e` build (~1.5 M flops total, ~5 ms) and 2 MB of memory.

### E.5 Boundary conditions from answers

```
// PINS: pairs with immutability >= 0.75
for each such pair i:
  arcHalf_elems = 2 + 4 * |a_i|                       // stronger identification = wider anchor
  dTheta = arcHalf_elems / Rmax                        // arc length -> radians
  pin every node with  |r_node - Rmax| <= 1.0  and  angular distance to theta_i <= dTheta
  -> both x and y DOFs
  mark the elements adjacent to those nodes SOLID_PASSIVE

// LOADS: pairs with immutability < 0.75
for each such pair i:
  node = nearest node to (r_i, theta_i)
  dir  = normalize( sum_k c_node[k] * uHat_k )         // uHat at 60deg, 180deg, 300deg
  if ||dir|| < 0.2 : dir = radially outward at theta_i  // degenerate fallback
  F[dofX(node)] += F0 * |a_i| * dir.x
  F[dofY(node)] += F0 * |a_i| * dir.y                   // F0 = 1
  mark the 3x3 element patch around node SOLID_PASSIVE
```

Load *direction* = the 2D projection of that tile's own accumulated color onto the sector geometry: a fluid identity that is strongly Geographic pushes toward 180°. This gives a rich, non-collinear load set (so the trusses are genuinely 2D and interesting) with a clean semantic reading: *"this daily choice pulls your identity toward its category."*

Single-node pins produce mesh-dependent stress singularities and artifacts, hence the arc + adjacent-solid treatment. The arc half-width scaling with `|a_i|` is not decorative — a neutral answer on an immutable pair should not be a load-bearing anchor.

**Degenerate-case guards, all mandatory:**
1. **Always pin at least 3 arcs.** If the derived pin set is empty or has fewer than 3 spatially separated arcs, add default pins at rim `theta = 0, 2*PI/3, 4*PI/3` with half-width 2 elements. Three points 120° apart are non-collinear, so all three rigid-body modes are removed and `K` restricted to free DOFs is nonsingular. Without this, a user who answers every immutable pair neutral gets a singular system.
2. **Minimum arc half-width 2.0 elements** for every pin (so `|a_i| = 0` still yields a real anchor when that pair is one of the three fallbacks).
3. **Assert `||F||_2 > 0`.** If every answer is exactly neutral, apply a default unit load at the center-nearest node directed at 90°, and show "no answers recorded" in the UI.
4. Assert every load DOF is not also a pinned DOF (possible if an authored `immutability` is near 0.75 and geometry collides). Resolve by moving the load node one element inward.

### E.6 How the color field is carried

**Fixed at seed time. Never advected. Decided.**

Compute `c_e`, `s_e`, `w_e` **once** per seed change; during optimization only `rho` changes. Three reasons: (1) color is *data* — a record of which identity deposited where — and diffusing it destroys the record; (2) advecting it would require a transport PDE with no basis in either the metatheory or the mechanics, and it would make `w_e` time-varying, which would make the objective non-stationary and the compliance history meaningless; (3) it is much simpler and much faster.

Render as: **hue from the normalized color, opacity/lightness from `rho`.**
```
hue_e   = c_e / max(||c_e||, 1e-9)          // sent to the main thread once, as Uint8 RGB
alpha_e = smoothstep(0.15, 0.65, rho_e)     // per frame
```
This gives exactly the intended reading: erosion *reveals* which identities survived as load-bearing structure. Nothing more is needed.

Optional bonus, nearly free: a von Mises overlay. You already have `u` and `D`; `sigma_vm` per element is ~30 flops from the element strains at the centroid. Rendering stress as a luminance highlight on the surviving members reads as "these are the cultural highways actually carrying the load." Strongly recommend for the final artwork; it is the most legible visualization of the whole metaphor.

---

## F. Worker protocol

### F.1 Division of responsibility

The **worker owns the seed computation**, not just the optimization. Rationale: the seed, the BCs, and `w_e` must be derived from one code path, and the derivation is only ~330k operations (36 deposits x 9216 elements) = **under 2 ms** — fast enough that a slider drag can round-trip through the worker and still feel instant. One source of truth, main thread stays free for rendering.

### F.2 Messages: main → worker

```ts
type ToWorker =
  | { type:'init';       config: SolverConfig; catalog: WordPair[] }
  | { type:'setAnswers'; answers: Float32Array }      // length = catalog.length, values in [-1,1]
  | { type:'setParams';  patch: Partial<SolverParams> } // volfrac, rmin, p, move, er, mode
  | { type:'run';        maxIterations: number }
  | { type:'step';       n: number }
  | { type:'pause' }
  | { type:'reset' }
  | { type:'export';     hardening: boolean }          // final tight-tolerance polish pass
  | { type:'recycle';    buf: ArrayBuffer }            // buffer returned for reuse (transferred)
```

`init` builds: disc mask, `designList`/`freeList`, CSR pattern, scatter map, `diagPos`, filter `H`. Cost ~40 ms at N=96, once.
`setAnswers` recomputes: deposits → `c`, `rhoSeed`, `s`, `w`, `Vfrac`, pins, loads, `SOLID_PASSIVE` patches, `rho^0`. Cost ~3 ms. Does **not** rebuild the CSR pattern (`SOLID_PASSIVE` changes affect values, not structure — the pattern covers all design elements regardless of state). Replies with a `seed` frame.

### F.3 Messages: worker → main

```ts
type FromWorker =
  | { type:'ready'; nelx; nely; Rmax; nDesign; nFree }
  | { type:'seed';
      hueRGB: Uint8Array;        // 3 * nelem, TRANSFERRED, sent only on answer change
      elemState: Uint8Array;     //     nelem, TRANSFERRED, sent only on answer change
      wField: Uint8Array;        //     nelem, TRANSFERRED, quantized w for a debug overlay
      rho: Float32Array;         //     nelem, TRANSFERRED
      derived: { volfrac, nPins, nLoads, S } }
  | { type:'iter';
      k: number; mode: 'simp'|'beso';
      compliance: number; complianceRel: number; volume: number; changeLinf: number;
      cgIters: number; cgResidual: number; cgConverged: boolean;
      islands: number; unsupportedLoads: number;
      rho: Float32Array }        // nelem, TRANSFERRED
  | { type:'done'; reason:'converged'|'maxIter'|'paused'; k: number }
  | { type:'error'; where: string; message: string }
```

### F.4 Exact per-frame byte traffic (N = 96, nelem = 9216)

| array | dtype | bytes | frequency |
|---|---|---|---|
| `rho` | Float32Array(9216) | **36,864** | every iteration |
| `hueRGB` | Uint8Array(27648) | 27,648 | on answer change only |
| `elemState` | Uint8Array(9216) | 9,216 | on answer change only |
| `wField` | Uint8Array(9216) | 9,216 | on answer change only |
| scalars | — | ~120 | every iteration |

**~37 KB per iteration.** At 20 iterations/s that is 0.74 MB/s — completely negligible, *provided* you don't allocate. Two rules:

1. **Float32 on the wire, Float64 internally.** The canvas needs ≤8 bits of density precision. Float32 halves the traffic and the allocation churn, and costs nothing (`rho` is only ever *displayed* from this copy).
2. **Buffer recycling ring, 3 deep.** Allocating a fresh `Float32Array(9216)` every iteration is 37 KB/iter of garbage; at 20 iter/s that is a GC pause every few seconds, visible as animation jank. Instead: the worker keeps a pool of 3 buffers; it transfers one out each iteration and the main thread transfers the detached buffer back in a `recycle` message after painting. If the pool is empty (main thread fell behind), allocate one rather than block.

### F.5 Preferred path in Electron: SharedArrayBuffer

Since you control the Electron page, do this and per-frame traffic becomes **zero bytes**:

- Serve the renderer over a registered custom protocol (not `file://`) and set `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` via `session.defaultSession.webRequest.onHeadersReceived`. Verify `crossOriginIsolated === true` at startup.
- Allocate one `SharedArrayBuffer` holding `rho` as Float32 plus a small `Int32Array` control block. The worker writes `rho`, then `Atomics.store(ctrl, FRAME, k)` and `Atomics.notify`. The main thread's `requestAnimationFrame` loop does `Atomics.load(ctrl, FRAME)`, and if it changed, paints from the SAB.
- Scalars (compliance, cgIters, ...) go in the same SAB as a Float64 slice, so no `postMessage` at all in the steady state.
- **Keep the transferable path as a fallback** behind a `crossOriginIsolated` check. SAB availability across Electron versions and packaging modes is exactly the kind of thing that breaks two days before a deadline.

The SAB path also decouples the rates cleanly: the worker iterates as fast as it can, the renderer paints at 60 Hz and simply shows the most recent state. Torn reads are harmless here (a half-updated density field for one frame is invisible), so no double-buffering is needed — but if you want strictness, use two `rho` slices and flip an index atomically.

---

## G. File layout, and the tests that actually catch bugs

### G.1 Modules

```
src/solver/
  types.ts                 Shared interfaces: MeshSpec, SolverParams, SeedField, BCs, IterationResult.
  mesh.ts                  Index arithmetic (nodeId/elemId/edofs/centroid/polar); disc mask; elemState; designList/freeList; freeDof mask.
  elementStiffness.ts      buildKE(nu) from A11/A12/B11/B12; exports KE (Float64Array 64) and packed KE_U (36).
  material.ts              E(rho,w), dE/drho, Emin/rho_min/p constants, hardening-pass p schedule.
  assembly.ts              One-time CSR pattern + element->CSR scatter map + diagPos; per-iteration assemble(rho, w).
  spmv.ts                  CSR matvec; dot/axpy/norm2 kernels over Float64Array.
  cg.ts                    Jacobi-PCG with explicit fixed-DOF masking, warm start, adaptive tolerance.
  multigrid.ts             (Phase 2) V-cycle preconditioner: hierarchy, bilinear P/R, damped-Jacobi smoother.
  connectivity.ts          Union-find components on the element grid; anchored-component test; supportedDof mask; island + unsupported-load reporting.
  filter.ts                One-time H in CSR + row sums; sensitivityFilter (SIMP); plainAverage (BESO); coherence (reuses H).
  sensitivity.ts           ce_e = u_e^T KE u_e (packed 36-term form); dc/drho_e; f^T u cross-check.
  ocUpdate.ts              Lagrange bisection (warm-bracketed) + OC update with move limits, passive handling, volume bookkeeping.
  beso.ts                  Sensitivity numbers, history averaging, ER volume schedule, two-threshold add/remove with AR_max, Huang-Xie convergence test.
  seedField.ts             Answers -> deposits -> c_e, rhoSeed, s_e, w_e; Vfrac derivation; feasible rho^0 by bisection.
  boundaryConditions.ts    Answers -> pin arcs, load nodes/directions/magnitudes, SOLID_PASSIVE patches; all four degenerate-case guards.
  optimizer.ts             Iteration driver: assemble -> solve -> sensitivity -> filter -> update -> metrics; SIMP/BESO mode switch; convergence.
  worker.ts                Message pump, SAB vs transferable path, buffer pool, throttling, error fencing.

src/culture/
  wordPairs.ts             Authored catalog: id, labels, category, immutability, slot. The only place culture content lives.
  mapping.ts               Pure functions: answer -> (r, theta, amp, sigma, force direction). No mesh knowledge.

src/render/
  mosaicCanvas.ts          rAF loop; ImageData or marching-squares contour at rho=0.5; hue x rho compositing.
  palette.ts               Category hues, colorblind-safe variant, print profile.
  stressOverlay.ts         Optional von Mises luminance highlight.

src/ui/
  Sliders.tsx, RunControls.tsx, Diagnostics.tsx   (compliance/volume/cgIters/islands readout)
```

### G.2 Tests, ordered by how much real breakage they catch

**1. `elementStiffness` — the highest-value test in the suite.**
- All 64 entries match the §B.1 golden table to `1e-15`.
- `KE[i][j] === KE[j][i]` exactly.
- Every row sums to 0 (both rigid translations in the null space).
- `||KE @ [0.5,-0.5, 0.5,0.5, -0.5,0.5, -0.5,-0.5]||_inf < 1e-14` (rigid rotation in the null space).
- `trace === 8 * 45/91` to `1e-14`; `rank === 5` (via the three null vectors).

**2. Patch test — catches plane-stress vs plane-strain, wrong `nu`, and wrong DOF ordering, all of which produce plausible-looking wrong answers.**
Apply the exact uniaxial-stress field `u_x = eps*x`, `u_y = -nu*eps*y` with `eps = 1e-3` to a single unit element (nodes at `(0,0),(1,0),(1,1),(0,1)` in the CCW order of §A.2). Then `sigma = [E*eps, 0, 0]` and the strain energy is `0.5*E*eps^2*V = 5e-7`, so:
```
assert |u^T KE u - 1e-6| < 1e-18
```
Repeat on a 4x4 assembled patch with the same field prescribed at all nodes and assert interior nodal residuals `|(K u)_interior| < 1e-12` — a correct element reproduces a linear field exactly.

**3. Iteration-1 compliance against MATLAB top88 — the best regression test available.**
Set up the MBB half-beam (`nelx=60, nely=20`, left edge x-rolled, bottom-right corner y-pinned, unit downward load at the top-left node), uniform `x = 0.5`, `p = 3`, `Emin = 1e-9`, `w ≡ 1`. Assert the **single-solve** compliance matches the value printed by top88's first iteration to 6 significant digits. This is path-independent (no filter, no OC, no convergence history), so it is a *hard* number, unlike the converged compliance. It simultaneously validates assembly, DOF ordering, BC handling, and CG accuracy. **Get this number from a MATLAB/Octave run of top88 during implementation and lock it in.**

**4. Converged MBB benchmark — assert loosely, and assert the topology.**
`(60, 20, volfrac=0.5, p=3, rmin=1.5)` with the sensitivity filter and OC converges to `c ≈ 205` (the exact value drifts by a few tenths depending on `Emin`, the change tolerance, and iteration count, so **do not** hardcode a tight literal from memory). Assert `190 < c < 225`, assert the volume constraint holds to `1e-6`, and separately snapshot-test the topology (the classic two-bar-with-interior-diagonals). Record your own converged value on the first successful run and lock *that* as the regression golden.

**5. Solid cantilever vs Euler-Bernoulli — catches BC and load-application bugs.**
`nelx=60, nely=10`, all left-edge DOFs fixed, unit downward tip load at the mid-height right node, `rho ≡ 1`. Analytic `delta = F L^3/(3 E I)` with `I = 10^3/12 = 83.33`, `L = 60` → `864`, plus a shear term. Q4 bilinear elements are stiff in bending (shear locking), so expect the FEA answer a few percent below analytic with 10 elements through the depth. **Assert within 10%.** A DOF-ordering or BC bug shows up here as a factor of 2 or a sign flip, not as 3%.

**6. CG vs a dense reference.** On a 4x4 mesh (`ndof = 50`), assemble densely, solve with dense Gaussian elimination, and assert `||u_pcg - u_dense||_inf < 1e-10`. Also assert `u[c] === 0` *exactly* for every fixed DOF, and that `(K u - f)` restricted to free DOFs has norm `< 1e-8 * ||f||`.

**7. The island regression test — this is the one that protects §C.5.**
Construct a synthetic `rho` on the disc with a deliberately disconnected solid blob (e.g. an annular ring of `rho_min` isolating a patch). Assert: the island is detected; its DOFs are in `fixedMask`; and **CG converges in within 2x the iteration count of the island-free case**. Without the connectivity pass this test will need thousands of iterations — which is exactly the production failure mode, made visible in CI.

**8. Filter.** `H_ei === H_ie`; `sum_i H_ei / Hs_e === 1` to `1e-15`; the filter maps a constant sensitivity field to itself exactly; `nnzH` matches a brute-force count within the design domain.

**9. OC update.** Volume constraint met to `1e-6`; `|rho_new - rho| <= move + 1e-12` everywhere; `rho in [rho_min, 1]`; `SOLID_PASSIVE` elements unchanged at 1.0; the bracket-expansion branch is exercised (feed a `lam_prev` off by 10^6).

**10. Mesh arithmetic.** Round-trip `elemId <-> (ex,ey)` and `nodeId <-> (ix,iy)` over the whole grid; `edofs(ex,ey)` matches a brute-force reference for all elements; disc element count within 1% of `pi*Rmax^2`.

**11. Seed determinism and coherence.** Identical answers produce byte-identical `rho^0`, `c`, `w` (no `Set`/`Map` iteration-order or `Math.random` leakage). `s_e === 1` (to 1e-12) for a monochrome field; `s_e ≈ 0.577` for an equal three-way mix; `w_e in [0.15, 1]` everywhere; `mean(rho^0) === Vfrac` to `1e-6`; a run with all answers at 0 still yields ≥3 pins and `||F|| > 0`.

**12. BESO.** Volume follows the `ER` schedule exactly each iteration; additions never exceed `AR_max * nDesign`; converges within 150 iterations on the MBB; final topology visually matches the SIMP result (snapshot with a generous IoU threshold, ~0.7).

---

## Risk register — where I expect you to iterate

1. **CG iteration count. Highest risk by far.** My 25–80 warm estimate assumes the connectivity pass is doing its job. If you measure 300+ per iteration, the cause is almost always a hole in the supported-DOF mask (a one-node hinge, or a component reachable only through a diagonal). Diagnose by logging `cgIters` alongside `islands` and the count of newly-constrained DOFs. Escalation order: (a) verify the mask, (b) raise `Emin` to `1e-4`, (c) raise `rmin` to 3.0 (thicker members = better conditioning), (d) drop to N=64, (e) build the multigrid preconditioner.

2. **`w_min = 0.15` is a guess.** Too high and discordance has no visible effect; too low and the series-bottleneck thickening (§E.3) dominates and every mosaic grows fat buttresses at the center. Expect to tune in `[0.1, 0.35]` while looking at real output. Make it a dev-panel slider from day one.

3. **`sigma` and `rmin` interact.** If `sigma < rmin` the filter erases the seed's structure before the optimizer can act on it, and every person's mosaic looks the same. Enforce `sigma_min >= rmin` as an assertion at init (`0.05*47 = 2.35 >= 2.4` is currently *marginally violated* — either raise `sigma_min` to `0.055*Rmax` or lower default `rmin` to 2.2). Flagging this explicitly because it is the kind of near-miss that silently flattens the whole app's expressiveness.

4. **Mask-change chatter.** If `islands` or `cgIters` oscillates period-2 across iterations, widen the hysteresis band from 0.08/0.12 to 0.06/0.15.

5. **SharedArrayBuffer in packaged Electron.** Test the packaged build early, not on deadline day. Keep the transferable fallback wired and actually exercised (a dev flag that forces it).

6. **The `Vfrac` clamp lower bound.** `0.20` is my estimate of feasibility at `rmin = 2.4` with 15–20 point loads on a 94-element disc. If low-`S` users get disconnected fragments, raise the floor to 0.25 — do not lower `rmin` to compensate, because that degrades conditioning too.

7. **The converged-MBB compliance value.** I deliberately gave a range rather than a literal. Do not let a hardcoded number from anyone's memory (including mine) become a failing test that costs you an afternoon — generate the golden from your own first green run and from top88 directly.

### Critical Files for Implementation

- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\solver\elementStiffness.ts`
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\solver\assembly.ts`
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\solver\connectivity.ts`
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\solver\seedField.ts`
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\solver\optimizer.ts`