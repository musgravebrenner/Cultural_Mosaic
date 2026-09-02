Both PDFs read. Table 1's taxonomy and Proposition 2 are confirmed verbatim, and one of them changes a design answer materially. Environment check: `Documents` is a real local folder, **not** OneDrive-redirected (no `OneDrive\Documents` exists), so `node_modules` won't fight a sync client — the usual Windows EPERM build hazard is off the table.

Two things from the source docs worth stating up front, because they drive decisions below:

- **Table 1 is exactly as you specified** (Demographic: Age/Ethnicity/Gender/Race; Geographic: Climate/Temperature/Coastal-inland/Urban-rural/Regional-country; Associative: Family/Religion/Employer/Profession/Politics/Avocations). Use it as a literal two-level grouping in the UI.
- **Proposition 2, verbatim (p. 1133):** "Activation of particular patterns of cultural identities is influenced by the strength of the pattern as well as situational contexts," preceded by "Activation of a particular cultural identity or a cultural pattern of identities is likely to be a discontinuous event based on identity strengths and situational contexts. Strong identity patterns are more likely to be tapped than weak patterns." This settles section D's one-slider-vs-two question decisively in favor of two.

---

# A. Scaffold and toolchain

## Choice: electron-vite + electron-builder. Not Electron Forge.

```bash
# in C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic
git init
npm create @quick-start/electron@latest . -- --template react-ts
```

The scaffolder detects the non-empty directory and offers *Remove existing files / Ignore files and continue / Cancel* — choose **"Ignore files and continue"** to keep the PDFs, then move them to `docs/`. If your version only offers remove-or-cancel, scaffold into `./app` instead and treat `app/` as project root.

**Why electron-vite over Electron Forge + Vite:**

1. **Preload correctness.** electron-vite compiles preload to CJS/IIFE by default. This is the single most common Electron+ESM failure: an ESM preload silently fails to execute under `sandbox: true`, and you get `window.mosaic === undefined` with no error. Forge's Vite template leaves you to get this right yourself.
2. **Three explicit build targets in one config.** `main` / `preload` / `renderer` sections in `electron.vite.config.ts`, each a real Vite config. Worker options belong to the renderer section and behave like ordinary Vite there — which matters because the worker is your highest-risk dependency.
3. **Packaging quality.** electron-builder produces an NSIS installer with an install-location prompt, per-user/per-machine choice, uninstaller, and Start Menu entry. Forge's default Windows maker is Squirrel.Windows, which installs to `%LOCALAPPDATA%` with no prompts and no choices — it looks broken to a grader.
4. HMR for the renderer plus main/preload hot restart works out of the box.

Forge+Vite is the "official" path and is not wrong; I'm choosing against it on preload-ESM and installer-UX grounds, both of which cost you real time at the two moments you can least afford it (day one and the night before submission).

**Do not hand-roll.** You'd be writing the dev-server-vs-`file://` URL switch, the preload format handling, and the worker asset pipeline yourself — three things that are exactly where the bugs live.

## Dependencies, with the case for each

Runtime (`dependencies`):

| Package | Role | Verdict |
|---|---|---|
| `@electron-toolkit/utils` | `is.dev`, `optimizer.watchWindowShortcuts`, `electronApp.setAppUserModelId` (correct Windows taskbar identity) | Keep — ~2kB, saves real boilerplate |
| `@electron-toolkit/preload` | Ships an `electronAPI` bridge object | **Remove.** It exposes a broad `ipcRenderer` surface that defeats the narrow-bridge posture in A/security. Write 20 lines yourself. |
| `electron-updater` | Auto-update from a release server | **Remove.** You have no update server. It's the largest dependency in the template and pure dead weight. |
| `zustand` | Store the document; expose a vanilla `getState`/`subscribe` to non-React code | Add. Justified in C. |

Dev (`devDependencies`): `electron`, `electron-vite`, `electron-builder`, `vite`, `@vitejs/plugin-react`, `typescript`, `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@types/node`, `vitest`, plus the template's eslint/prettier.

**Argued against, deliberately:**

- **p5.js** — see B. It contributes nothing once you choose the ImageData path, which you must.
- **three.js / PixiJS** — WebGL for a ≤120² grid is solving a problem you don't have. Canvas 2D has ~50× the headroom you need.
- **zod** — you have ~6 interfaces and you need bespoke clamping and version migration anyway. A hand-written `parseProfile(unknown)` that *collects* errors and clamps numerics is ~80 lines, gives better messages, and doubles as the migration entry point. Zod would push you toward reject-on-invalid, which is the wrong policy for a user's saved artwork.
- **nanoid / uuid** — `crypto.randomUUID()` is available in the Electron renderer (secure context).
- **immer / Redux Toolkit** — see C.
- **Tailwind** — a two-panel app with a precisely-tuned art palette wants CSS custom properties and CSS Modules (both free in Vite), not a utility layer plus a build plugin. You'll be hand-tuning ~15 components, not 200.
- **d3** — you need `smoothstep`, `atan2`, and a Catmull-Rom resample. That's 40 lines.
- **A charting library** for the compliance-vs-iteration plot — draw it as a 200×60 canvas polyline in 25 lines.

## Web Worker in Vite: the exact configuration

This is the sharp edge, so here's the mechanics before the recommendation.

Vite supports two worker forms:

```ts
// Form 1 — query suffix
import SolverWorker from './solver.worker?worker';
const w = new SolverWorker();

// Form 2 — literal URL
const w = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
```

Form 2 requires the `new URL(...)` expression to be written **literally inline** — Vite static-analyzes it, so you cannot compute the path into a variable, build it from a constant, or wrap it in a helper. That constraint alone makes it hostile to the facade pattern you want.

**Use Form 1 (`?worker`).** Reasons:

1. TypeScript types come free from `vite/client`'s `declare module '*?worker'` — no ambient declaration to hand-write.
2. It's a normal import, so it lives happily inside `SolverSession.ts` behind a facade. Form 2's literal-inline constraint means the construction site can't be abstracted.
3. It gives you a one-token escape hatch: `?worker&inline` base64-inlines the worker as a blob URL, eliminating *all* path resolution concerns under `file://`. Switching is a one-line change in one file.

`electron.vite.config.ts`:

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main:    { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()],
    worker: {
      format: 'es',       // 'iife' cannot code-split; 'es' lets the kernel use imports
      plugins: () => [],  // MUST be a function in Vite 5+, not an array
    },
    build: {
      target: 'chrome126',      // match the bundled Electron's Chromium; no legacy transpiling
      rollupOptions: { output: { manualChunks: undefined } },
    },
  },
});
```

Three things that bite here:

- `worker.plugins` **must be a function** in Vite 5+. Passing an array is a config error people spend an hour on.
- `worker.*` belongs to the **renderer** config, not the top level. electron-vite silently ignores it at top level.
- Keep `solver.worker.ts` under `src/renderer/src/solver/`. If it lands anywhere electron-vite treats as a main/preload entry, it gets compiled for Node and fails at runtime with confusing errors.

**Risk, stated plainly:** module workers under the packaged `file://` origin are the one thing I'd verify before writing any app code. Chromium's worker loading under `file://` is more restricted than under `http://`, and `format: 'es'` produces a module worker. Mitigations, in order:

1. **Build Step 1 as a worker smoke test and run it against `npm run build && npm start`, not just `npm run dev`.** Dev serves over `http://localhost` and will pass even when the packaged build fails. Testing only dev is how this bug reaches submission night.
2. If it fails, change `?worker` → `?worker&inline`. Blob-URL worker, zero path resolution, works under any origin. Cost: the worker can't dynamic-import or fetch relative assets, which a self-contained numeric kernel doesn't need anyway.
3. If you later need WASM in the kernel (breaking inline), register a custom `app://` protocol via `protocol.handle` in main and load the renderer from it instead of `file://`. Structure the code so this is a main-process-only change.

Because of #1/#2, **`SolverSession.ts` must be the only file in the app that mentions `Worker`.**

**On SharedArrayBuffer: don't.** It needs cross-origin isolation and complicates the `file://` story for zero benefit here. Transferable `ArrayBuffer`s plus a **buffer ping-pong** (worker transfers frame buffers out; main thread transfers the previous pair back via a `recycle` message) gives you zero-copy *and* zero steady-state allocation. Concrete in C.

## tsconfig: four projects, not one

The renderer needs `lib: ["DOM", "DOM.Iterable"]`; the worker needs `lib: ["WebWorker"]`. **Putting both in one project produces conflicting global declarations** (`self`, `MessageEvent`, `postMessage`, `fetch` all get declared twice with different signatures) and generates errors that read like nonsense. Separate projects is the fix, and it conveniently solves a second problem.

`tsconfig.base.json` (shared strictness):

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler",
    "module": "ESNext",
    "target": "ES2022",
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

- `tsconfig.node.json` — main + preload. `"lib": ["ES2022"]`, `"types": ["node", "electron-vite/node"]`. **No DOM.**
- `tsconfig.web.json` — renderer. `"lib": ["ES2022", "DOM", "DOM.Iterable"]`, `"types": ["vite/client"]`, `"jsx": "react-jsx"`. The `vite/client` types are what make `?worker` imports typecheck.
- `tsconfig.worker.json` — `src/renderer/src/solver/**`. `"lib": ["ES2022", "WebWorker"]`, and **`"noUncheckedIndexedAccess": false`**.

That last override is the second problem solved. `noUncheckedIndexedAccess` is correct and valuable for config objects and answer arrays — it catches real off-by-one bugs. But it also makes `float64Array[i]` type as `number | undefined`, which in an FEA inner loop means either `!` on every access or genuinely slower defensive code. Rather than weaken it globally or litter the kernel with assertions, scope the relaxation to the one directory where it's a liability. `exactOptionalPropertyTypes` also matters here: it stops `loadVector?: {...}` from silently accepting `undefined` as an explicit value, which is exactly the kind of thing that turns into a `NaN` force.

`tsconfig.json` is a solution file with `"files": []` and `"references"` to all four, so `tsc -b` typechecks everything and `npm run typecheck` is one command.

## Electron security posture and the minimal IPC surface

```ts
new BrowserWindow({
  width: 1440, height: 900, minWidth: 1100, minHeight: 700,
  show: false, backgroundColor: '#101014',
  autoHideMenuBar: true,
  webPreferences: {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,   // default true; be explicit
    nodeIntegration: false,   // default false; be explicit
    sandbox: true,            // template ships false — turn it ON
    webSecurity: true,
    devTools: is.dev,
  },
});
```

`sandbox: true` works here because the preload touches only `contextBridge` and `ipcRenderer`, both available in a sandboxed preload. The template defaults it to `false` solely to accommodate `@electron-toolkit/preload`'s `require` usage — which is another reason to drop that package.

Also in main: `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))` and a `will-navigate` handler that denies any navigation away from your own origin. Two lines that close the "user clicks a link, your Electron app becomes an unsandboxed browser" hole.

CSP as a meta tag in `renderer/index.html`:

```html
<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; worker-src 'self' blob:;
           style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:;
           connect-src 'self' ws: http://localhost:*; object-src 'none'; base-uri 'none'">
```

`worker-src 'self' blob:` is what keeps the `?worker&inline` fallback available. `style-src 'unsafe-inline'` is required because Vite injects `<style>` tags in dev — note that React's `style={{}}` prop uses CSSOM and is *not* affected by CSP, so you're only loosening this for the dev server. `connect-src ws:` is HMR. Everything else is locked.

### The IPC surface: four channels, request/response only

The whole justification for the architecture is here — **the solver lives in a renderer worker, so no solver data crosses IPC at all.** The only capability the renderer lacks is filesystem access, so the only things that cross are file dialogs.

```ts
// src/shared/ipc-contract.ts — imported by main, preload, and renderer
export const IPC = {
  saveProfile:  'profile:save',
  openProfile:  'profile:open',
  exportPng:    'artwork:export-png',
  getAppVersion:'app:version',
} as const;

export interface SaveResult { canceled: boolean; filePath?: string; error?: string }
export interface OpenResult { canceled: boolean; filePath?: string; contents?: string; error?: string }
```

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../shared/ipc-contract';

contextBridge.exposeInMainWorld('mosaic', {
  saveProfile: (json: string, suggestedName: string) => ipcRenderer.invoke(IPC.saveProfile, json, suggestedName),
  openProfile: () => ipcRenderer.invoke(IPC.openProfile),
  exportPng:   (bytes: Uint8Array, suggestedName: string) => ipcRenderer.invoke(IPC.exportPng, bytes, suggestedName),
  getAppVersion: () => ipcRenderer.invoke(IPC.getAppVersion),
});
```

**Why this shape:**

- **Four named functions, not a generic `invoke(channel, ...args)`.** A generic passthrough re-exposes every handler main ever registers, including future ones, to any script that reaches `window`. It also destroys the type safety that's the entire point of doing this in TypeScript. Named functions are the whole benefit of `contextBridge`.
- **All `invoke`/`handle`, zero `ipcRenderer.on`.** No main→renderer pushes means no subscription API on the bridge, which means no listener-leak surface and no `removeListener` hygiene to get wrong. If you later want native menu items to trigger renderer actions, that's the moment to add exactly one `on` channel — not before.
- **`fs` appears in exactly one file** (`src/main/dialogs.ts`). Main receives a *string* to write, or returns a *string* it read. It never receives a path from the renderer, so there is no path-traversal surface: the user picks the path via the OS dialog, and main is the only party that ever knows it. That's a meaningfully stronger property than validating renderer-supplied paths.
- **`Uint8Array` for PNG bytes.** `invoke` uses structured clone, so typed arrays pass efficiently. A 4096² PNG is ~3–10MB, which is a non-issue as a one-shot. Do not use a data URL — 33% larger and it forces a base64 round trip.

**Do not** run the solver in the main process or a `utilityProcess`. You'd pay structured-clone serialization on ~115KB of float data per iteration across a process boundary at up to 60Hz, lose transferables entirely, and block the process that owns your window. The renderer worker shares the renderer's heap, so transfers are genuine pointer handoffs.

---

# B. Rendering the mosaic

## Your claim is correct, but the strongest argument isn't the one you made

Dependency weight is the weak argument — p5 is ~1MB, and you're shipping a 200MB Electron app. Nobody will notice. And "p5 global mode fights React" is true but avoidable: p5 instance mode (`new p5(sketch, el)` in a `useEffect`, `p.remove()` in cleanup) coexists with React fine.

The decisive argument is **throughput, and what it forces you to do:**

At N=120 you have 14,400 cells. The idiomatic p5 approach is `fill(r,g,b); rect(x,y,w,h)` per cell — 14,400 fill-state changes plus 14,400 rect fills per frame, wrapped in p5's own state stack. At 60fps that's ~1.7M canvas state operations per second, on the same thread that's servicing worker messages and React. You'd land around 15–25fps while stealing CPU the solver needs.

The correct approach at this cell count is a single `Uint8ClampedArray` written directly and blitted with one `putImageData`. p5 *can* do that (`loadPixels()` / `pixels[]` / `updatePixels()`) — **but at that point you are writing byte-index arithmetic into a typed array, which is identical code with or without p5.** p5's entire value proposition is its drawing API, and the drawing API is precisely the thing you cannot afford to use. So p5 becomes a 1MB dependency that owns your canvas sizing and `pixelDensity` (fighting the DPR control you need below) while contributing zero lines of useful code.

**Recommendation: raw Canvas 2D.** Not because p5 is heavy, but because the one technique that makes this fast is the one technique that makes p5 irrelevant.

WebGL/regl is also wrong here, for the mirror-image reason: 14,400 cells is ~2 composited operations per frame in Canvas 2D. You'd add a shader pipeline to optimize something already 50× under budget. If you later want bloom/glow, do it as a second 2D pass or a CSS `filter` on the canvas element.

## Concrete pipeline: Float arrays → pixels

Three canvases, two of them on screen.

**1. Field buffer (offscreen, N×N).** One `OffscreenCanvas(N, N)` and one persistent `ImageData(N, N)`. Per dirty frame, walk the cells once:

```
for i in 0..N*N-1:
  ρ  = density[i]
  a  = smoothstep(solidLo, solidHi, ρ)              // solidLo≈0.25, solidHi≈0.60
  // composite in LINEAR light, not sRGB:
  rLin = a * srgbToLinear[colorR[i]] + (1-a) * bgLinR
  ...
  px[4i+0] = linearToSrgb8(rLin)  ... px[4i+3] = 255
putImageData(img, 0, 0)
```

Two LUTs make this fast and correct: a 256-entry `Float32Array` for sRGB→linear, and a 4096-entry `Uint8Array` for linear→sRGB8. Both built once at module load.

**2. Display canvas (on screen).** `imageSmoothingEnabled = false`, then one `drawImage(fieldCanvas, 0, 0, W, H)`.

**The Windows DPI detail that matters.** Windows commonly runs at 125% or 150% scaling, giving `devicePixelRatio` of 1.25 or 1.5. If the drawn size isn't an exact integer multiple of N, each mosaic cell straddles a fractional number of device pixels and you get shimmer and uneven cell widths — which looks like a bug in an app whose entire aesthetic is crisp tiles.

Fix: **snap the drawn size down to an integer cell size and center the result.**

```ts
const dpr = window.devicePixelRatio;
const availPx = Math.floor(Math.min(cssW, cssH) * dpr);
const cellPx  = Math.max(1, Math.floor(availPx / N));   // integer device px per cell
const drawPx  = cellPx * N;                              // exact
canvas.width = canvas.height = drawPx;
canvas.style.width = canvas.style.height = `${drawPx / dpr}px`;   // fractional CSS is fine
```

Every cell is now exactly `cellPx × cellPx` device pixels. No resampling, ever. Also set CSS `image-rendering: pixelated` as belt-and-braces. This same integer-snapping is why I recommend against pan/zoom below.

**3. Overlay canvas (on screen, stacked).**

## Making density render as artwork, not as a plot

Five things, in descending order of visual payoff:

1. **Composite in linear light.** This is the biggest single "why does it look cheap" fix. Alpha-blending sRGB values directly makes every fading edge and every color transition go muddy and dark — the classic dark-fringe artifact. Convert to linear, blend, convert back. Everything else on this list is a refinement; this one is the difference between "rendered" and "computed."

2. **Smoothstep, not hard threshold, not raw alpha.** A hard threshold aliases badly and throws away SIMP's gradient information. Raw `alpha = ρ` gives washed-out grey mush, because early SIMP iterations are almost entirely intermediate density. `smoothstep(0.25, 0.60, ρ)` gives a decisive solid/void read *and* free anti-aliasing, because the continuous field's gradient spans 1–2 cells at the boundary. Expose `solidLo`/`solidHi` in `RenderConfig` — they're the primary aesthetic dial and worth tuning by eye.

3. **Desaturate toward the void.** Multiply saturation by `a` so thin/low-density regions fade toward the background paper tone rather than toward grey. Voids that go grey read as missing data; voids that go to paper read as negative space. This is what makes it look painted.

4. **Edge accent (optional, high payoff).** One extra pass computing a cheap gradient magnitude of ρ (`|ρ[i+1]-ρ[i-1]| + |ρ[i+N]-ρ[i-N]|`), used to darken or lighten the boundary slightly. Gives the truss an inked, drawn quality for ~15 lines and one pass.

5. **Background is not white or black.** Warm paper `#F4F1EA` or deep ink `#101014`, selected by `RenderConfig.theme`. Pure `#fff`/`#000` is the fastest way to make generative output look like a screenshot of a debug view.

**Two render modes, one flag.** `imageSmoothingEnabled = false` → hard tiles, honoring the mosaic metaphor and the app's name. `true` with `imageSmoothingQuality: 'high'` → the organic truss/bone reading the source doc describes. Both aesthetics the doc wants, for one boolean. Default **Mosaic**; label the other "Reveal structure."

## Overlay: two stacked canvases, and a third cached offscreen

**Two on-screen canvases, absolutely positioned in a common container, identical CSS box, overlay on top with `pointer-events: none`.** Mouse handlers go on the container. Reasons this beats one canvas:

1. The field redraws at 60fps during Run; the overlay changes only on profile edit or hover. One canvas means re-stroking ~100 vector primitives and all the text labels every frame, for nothing.
2. The two layers want *opposite* context settings: field wants `imageSmoothingEnabled = false`, overlay wants smoothing on and anti-aliased text. These are per-context, so one canvas forces you to toggle mid-frame or accept ugly output on one layer.
3. Hit-testing and tooltip state live naturally with the overlay.

Additionally cache the *static* overlay (sector guides, rim ring, radius rings, category labels) into a third offscreen canvas, invalidated only on resize or profile-structure change. The on-screen overlay draw becomes: blit the cached static layer, then draw only the dynamic bits (hover ring, pulsing load arrows).

What to draw:

- **Sector guides:** three arcs at `r = rimRadius` in the category colors at ~12% alpha; radial dividers at 0°/120°/240°; faint concentric rings at 0.25/0.5/0.75 `rimRadius`, labeled "chosen daily → given at birth." Gate all of it behind a `showScaffolding` toggle, default **on** while building a profile and **off** for export — it's pedagogically useful and aesthetically noisy.
- **Rim anchors:** use the structural-engineering *ground symbol* — a small triangle with hatch strokes, pointing outward at `(rimRadius, θ)`, filled in the pair's color. It's honest to the FEA metaphor and instantly legible as "pinned."
- **Load arrows:** tapered arrow from the tile position along `(fx, fy)`, length ∝ `|F|` normalized to a max pixel length so one huge force doesn't blow out the composition. Add a subtle pulse only while running.
- **Every length, line width, and font size must be a function of a `scale` parameter,** not a hardcoded pixel value. This is what makes the high-res PNG export in E work without a second renderer.

**Hover tooltips need a provenance map** — the piece that's easy to overlook. When you build the seed field, also fill an `Int16Array(N*N)` holding, per cell, the index of the *dominant* contributing answer (argmax of stamp contribution, `-1` for empty). Hover then resolves canvas coords → cell index → provenance → `TileAnswer` → `WordPair` → label, in O(1), with no spatial search.

Render the tooltip as a **DOM element** (real text wrapping and styling for free), but **only `setState` when the hovered `answerId` changes**, not on every `mousemove`. Store the cursor position in a ref and let the rAF loop position the tooltip via `style.transform`. Result: a handful of React renders per second instead of 120, and zero renders while moving within one tile.

## Pan/zoom: no. Recommend against.

1. The composition is a fixed circular domain meant to be read whole. It's an artwork with a canonical framing; a viewport transform is an invitation to look at it wrong.
2. It's expensive in exactly the wrong places: the transform must be threaded through hit-testing, overlay scaling, export, *and* it breaks the integer-cell DPR snapping that makes the mosaic crisp — the moment you allow arbitrary zoom, cells become fractional device pixels again and the core aesthetic degrades.
3. Everything users actually want from zoom is available more cheaply:
   - **Resolution selector (60/90/120)** — this is the real "zoom in." More structural detail, not a bigger view.
   - **Collapse-left-panel / fullscreen toggle** for presenting.
   - **High-res PNG export** for inspecting fine structure.

That's 100% of the value at ~5% of the complexity.

---

# C. State management and data model

## The separation the source doc collapses

`CulturalNode` in the PDF mashes together four things that have completely different lifetimes, sizes, and owners:

| Layer | What it is | Cardinality | Mutability | Owner |
|---|---|---|---|---|
| **1. Library definition** (`WordPair`) | Shipped data: poles, category mix, immutability preset | ~70 | frozen | module constant |
| **2. User answer** (`TileAnswer`) | The document: which pair, slider position, strength | ~10–40 | user edits | zustand + JSON file |
| **3. Derived placement** (`PlacedTile`) | Pure f(1, 2, layout): θ, r, color, load, anchor flag | ~10–40 | recomputed | memoized selector |
| **4. Solver domain** (`SeedField`, frames) | Grid-indexed typed arrays: ρ, RGB, provenance | 14,400 cells | 60Hz | worker + a plain ref |

`CulturalNode` carries `label` (a layer-2/UI concern) *and* `density` (a layer-4, per-iteration concern) in one object. Follow that shape and you get a concrete disaster: `CulturalNode[]` with 14,400 entries that the solver must mutate every iteration, and React has no way to know what changed — so you either diff 14,400 objects per frame or re-render the tree 60 times a second. Neither works.

With the layers split, the solver only ever touches flat typed arrays (never a JS object), and React only ever holds ~40 small plain objects that change at human speed. That single split is what makes the rest of the app tractable.

## Interfaces

```ts
// ─── domain/taxonomy.ts ──────────────────────────────────────────────────────
export type CategoryId = 'demographic' | 'geographic' | 'associative';

/** Chao & Moon (2005) Table 1, "Sample tiles" column, verbatim. */
export type FacetId =
  | 'age' | 'ethnicity' | 'gender' | 'race'
  | 'climate' | 'temperature' | 'coastal-inland' | 'urban-rural' | 'regional-country'
  | 'family' | 'religion' | 'employer' | 'profession' | 'politics' | 'avocations';

export const SECTOR_CENTER_DEG: Record<CategoryId, number> =
  { demographic: 60, geographic: 180, associative: 300 };

/** Weights over (Demographic, Geographic, Associative) ≡ (R, G, B). Need not sum to 1. */
export interface CategoryMix {
  readonly demographic: number;
  readonly geographic: number;
  readonly associative: number;
}

// ─── domain/types.ts ─────────────────────────────────────────────────────────
export interface WordPair {
  readonly id: string;                    // stable: 'geo.urban-rural', 'custom.<uuid>'
  readonly source: 'library' | 'custom';
  readonly facet: FacetId | 'custom';
  readonly poleA: string;                 // 'Urban'
  readonly poleB: string;                 // 'Rural'
  readonly mix: CategoryMix;              // preset category weights
  readonly immutability: number;          // [0,1]; 1 = given at birth, 0 = chosen daily
  readonly note?: string;                 // one-line gloss shown in the library
}

/** Chao & Moon P2: activation depends on identity STRENGTH, distinct from content. */
export type StrengthLevel = 0 | 1 | 2 | 3;   // Dormant | Minor | Notable | Core

export interface TileAnswer {
  readonly answerId: string;              // crypto.randomUUID()
  readonly pairId: string;                // → WordPair.id
  /** -1 = fully poleA, 0 = equally both, +1 = fully poleB. CONTENT. */
  readonly position: number;
  /** Activation / how much it matters. MAGNITUDE. Orthogonal to position. */
  readonly strength: StrengthLevel;
  /** User override of the pair's preset; absent = use preset. */
  readonly immutabilityOverride?: number;
  /** ms epoch — stable ordering AND deterministic angular slotting. */
  readonly addedAt: number;
}

export interface MosaicProfile {
  readonly schemaVersion: 1;
  readonly kind: 'cultural-mosaic-profile';
  readonly id: string;
  title: string;
  createdAt: string;                      // ISO 8601
  updatedAt: string;
  appVersion: string;
  /** SNAPSHOT of every pair referenced by answers — library and custom alike. */
  pairs: WordPair[];
  answers: TileAnswer[];
  layout: LayoutConfig;
  solver: SolverConfig;
  render: RenderConfig;
}

export interface LayoutConfig {
  readonly gridSize: 60 | 90 | 120;       // N cells per side
  readonly rimRadius: number;             // R_max, normalized to half-extent (≈0.92)
  readonly minRadius: number;             // floor so r→0 tiles don't collapse (≈0.06)
  readonly poleSpreadDeg: number;         // angular separation of a pair's two poles (≈18)
  readonly stampSigmaCells: number;       // radial-basis footprint of one answer (≈3.5)
}

/** DERIVED. Never persisted. Pure f(WordPair, TileAnswer, LayoutConfig). */
export interface PlacedTile {
  readonly answerId: string;
  readonly pairId: string;
  readonly label: string;                 // "Urban ↔ Rural"
  readonly activePole: string;            // whichever pole the slider leans toward
  readonly thetaDeg: number;
  readonly radius: number;                // normalized [0,1]
  readonly x: number; readonly y: number; // normalized, centered, y-up
  readonly cell: { readonly col: number; readonly row: number };
  /** Within-tile category purity: 1 = single category, 0 = balanced three-way. */
  readonly purity: number;
  readonly rgb: readonly [number, number, number];   // 0..1
  readonly amplitude: number;             // seed density contribution, from strength
  readonly stiffnessScale: number;        // E₀ multiplier
  readonly isAnchor: boolean;             // pinned support
  readonly load?: { readonly fx: number; readonly fy: number };
}

export interface SolverConfig {
  readonly mode: 'simp' | 'beso';
  readonly volumeFraction: number;        // 0.15–0.60, default 0.35
  readonly penalty: number;               // SIMP p, default 3
  readonly filterRadius: number;          // cells, ≥1.5 to suppress checkerboarding
  readonly iterations: number;            // 20–300, default 120
  readonly moveLimit?: number;            // SIMP optimality-criteria step
  readonly erosionRate?: number;          // BESO ER
  readonly seed: number;                  // reproducibility
}

export interface RenderConfig {
  readonly upscale: 'mosaic' | 'smooth';
  readonly solidLo: number;               // smoothstep band, ≈0.25
  readonly solidHi: number;               // ≈0.60
  readonly theme: 'paper' | 'ink';
  readonly showScaffolding: boolean;
  readonly edgeAccent: number;            // 0 = off
}
```

Four notes on choices in there:

**Snapshot the pairs into the file.** `pairs: WordPair[]` contains library definitions too, not just custom ones. If you reference library pairs by id only, then tuning a preset mix in v1.1 silently changes every previously-saved artwork — and a `.json` from three months ago may not load at all. Snapshotting costs ~40 duplicated small objects (a few KB) and makes the file self-contained and reproducible, which is the entire point of saving an artwork. On load, prefer the file's snapshot; optionally offer "update to current library definitions" as an explicit user action.

**`purity` is a free and useful derived scalar.** It's the magnitude of the circular-mean vector (below), in [0,1]. Low purity → balanced RGB → near-white → the source doc's "Concordant Core."

**Keep `purity` and `concordance` strictly separate — this is easy to conflate and it makes the physics incoherent if you do.** They are different quantities from different parts of the theory:
- `purity` is **within** one tile: how single-category it is. Low purity is the doc's white "fully integrated identity," which the doc says should act as a high-stiffness anchor.
- `concordance` is **between** neighboring tiles: Proposition 1's "concordant vs discordant," measured as color similarity between overlapping stamps. This is what drives the stiffness field and therefore the erosion — the adjacency matrix `S_ij` in the doc.

Name them differently in code and never let one stand in for the other.

**`strength` is discrete (0–3), not continuous.** Justified in D — it halves the interaction cost of the second control while giving the physics all the resolution it needs.

## Solver boundary

```ts
// ─── solver/protocol.ts — pure types, no DOM and no WebWorker deps ───────────
export interface MeshSpec {
  readonly nx: number; readonly ny: number;
  readonly domainMask: Uint8Array;        // nx*ny; 0 outside the circular domain
}

export interface SeedField {
  readonly nx: number; readonly ny: number;
  density: Float32Array;                  // nx*ny — initial ρ
  color: Float32Array;                    // nx*ny*3
  stiffness: Float32Array;                // nx*ny — E₀ multiplier from concordance
  provenance: Int16Array;                 // nx*ny — dominant answer index, or -1
}

export interface BoundaryConditions {
  readonly fixedDofs: Uint32Array;
  readonly loadDofs: Uint32Array;
  readonly loadValues: Float32Array;
}

export type SolverRequest =
  | { type: 'init'; mesh: MeshSpec; seed: SeedField; bc: BoundaryConditions; config: SolverConfig }
  | { type: 'step'; n: number }
  | { type: 'recycle'; density: Float32Array; color: Float32Array }   // buffer pool return
  | { type: 'abort' };

export type SolverResponse =
  | { type: 'ready'; dofCount: number }
  | { type: 'frame'; iteration: number; compliance: number; volume: number; change: number;
      density: Float32Array; color: Float32Array }
  | { type: 'done'; iteration: number; reason: 'converged' | 'iterations' | 'aborted' }
  | { type: 'error'; message: string };
```

The `recycle` message is the ping-pong: the worker transfers frame buffers out (losing ownership), the main thread renders from them and transfers the same buffers back on the next frame. Steady-state allocation is zero, which matters because 14,400 `Float32Array`s at 60Hz is otherwise ~13MB/s of garbage.

**One contract to hand the numerics agent explicitly: the solver must be deterministic given `(mesh, seed, bc, config, config.seed)`.** No bare `Math.random()`. Persistence in E promises that reopening a file reproduces the artwork, and that promise is only as good as this.

## State management: Zustand

- **Redux Toolkit: no.** Slices, store configuration, and devtools wiring for ~6 pieces of state is ceremony without payoff. Its immutability guarantees protect data you aren't keeping in the store anyway.
- **useState + Context: no, for a specific reason.** A single context holding the profile re-renders every consumer on every slider tick. You'd fix it by splitting contexts and hand-placing `memo` — reimplementing, worse, what zustand gives you in 1.2kB.
- **Zustand: yes**, and the deciding feature is the one people rarely cite: **its vanilla API works outside React.** `useStore.getState()` from inside the rAF loop, `useStore.subscribe(selector, cb)` from `SolverSession`. Your renderer and solver client are not components and must not be; zustand is the only one of the three options where non-React consumers are a first-class, non-hacky path. Selector-based per-component subscriptions, no provider, React 18 StrictMode-safe.

Store the **document** (profile + UI toggles) in zustand. Store **solver frames** nowhere near it.

## The critical pattern: 60Hz solver output → canvas, zero React renders

Two independent dirty flags and one rAF loop. That's the whole trick, and it's used twice.

```ts
// ─── solver/SolverSession.ts — a plain class. Not a hook. Not a component. ───
import SolverWorker from './solver.worker?worker';   // ← ONLY mention of Worker in the app

export class SolverSession {
  private worker = new SolverWorker();

  /** Mutable, plain. Read by the rAF loop. NOT React state. */
  latestFrame: { density: Float32Array; color: Float32Array; iteration: number } | null = null;
  fieldDirty = false;

  private spent: { density: Float32Array; color: Float32Array } | null = null;
  private progressListeners = new Set<(p: Progress) => void>();
  private lastProgressAt = 0;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<SolverResponse>) => {
      const msg = e.data;
      if (msg.type === 'frame') {
        // 1. Return the PREVIOUS frame's buffers to the worker for reuse.
        if (this.spent) {
          this.worker.postMessage(
            { type: 'recycle', ...this.spent },
            [this.spent.density.buffer, this.spent.color.buffer],
          );
        }
        // 2. Hand off the new frame. No setState. No store write. Return immediately.
        this.spent = { density: msg.density, color: msg.color };
        this.latestFrame = { density: msg.density, color: msg.color, iteration: msg.iteration };
        this.fieldDirty = true;

        // 3. Throttled, low-frequency progress for the UI only.
        const now = performance.now();
        if (now - this.lastProgressAt > 100) {
          this.lastProgressAt = now;
          const p = { iteration: msg.iteration, compliance: msg.compliance, volume: msg.volume };
          for (const l of this.progressListeners) l(p);
        }
        return;
      }
      // ready / done / error are rare — these MAY touch the store.
    };
  }
}
```

```tsx
// ─── components/MosaicCanvas.tsx — mounts once, never re-renders during a run ─
useEffect(() => {
  const renderer = new FieldRenderer(fieldCanvasRef.current!, overlayCanvasRef.current!);
  let raf = 0;
  const loop = () => {
    // (a) solver output → pixels
    if (session.fieldDirty && session.latestFrame) {
      renderer.drawField(session.latestFrame, useStore.getState().render);
      session.fieldDirty = false;
    }
    // (b) slider edits → seed field → pixels (same mechanism, coalesced per frame)
    if (seedDirty.current) {
      rebuildSeedFieldInPlace(seedField, useStore.getState());   // mutates, never allocates
      renderer.drawField(seedField, useStore.getState().render);
      seedDirty.current = false;
    }
    if (overlayDirty.current) { renderer.drawOverlay(/* ... */); overlayDirty.current = false; }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // Non-React subscription: mark dirty, never setState.
  const unsub = useStore.subscribe(
    (s) => s.answers,
    () => { seedDirty.current = true; overlayDirty.current = true; },
  );

  return () => { cancelAnimationFrame(raf); unsub(); renderer.dispose(); };
}, []);   // ← empty deps. This effect runs once for the app's lifetime.
```

Four points to be explicit about:

1. **The `onmessage` handler never calls `setState` on the frame path.** It writes two fields and returns. If it touched React state, you'd schedule 60 renders/sec of a tree containing the canvas, and the canvas would be torn down and rebuilt or at minimum re-reconciled — which is the failure mode this whole design exists to avoid.

2. **`RunStatus` must be a leaf component.** It's the only thing subscribing to the throttled `progress` events, and it re-renders ~10×/sec. If it sits anywhere above `MosaicCanvas` in the tree, you re-render the canvas 10×/sec and get hitching that will look like a solver problem for hours before you find it. Put `RunStatus` as a sibling of `MosaicCanvas`, never an ancestor.

3. **Slider edits use the identical dirty-flag mechanism, which is what makes them cheap.** A store subscription sets `seedDirty = true` and returns; the rAF loop coalesces any number of input events into one rebuild per frame. Cost of a rebuild: 40 stamps × ~225 cells within a 3.5σ footprint ≈ 9,000 writes into a pre-allocated `Float32Array`. Tens of microseconds, zero allocation. You could drag at 1000Hz and not notice. **Do not rebuild synchronously in the input handler** — that's what makes slider drags feel gluey.

4. **React 18 StrictMode double-mounts effects in dev.** Create the `SolverSession` as a module-level singleton (or guard it with a ref and terminate in cleanup), or you'll get two workers, two frame streams interleaved into one `latestFrame`, and an apparently-doubled iteration rate. This looks exactly like a solver bug and isn't one.

---

# D. Left panel UX

## Library browsing

**Two tabs at the top of the left panel: `Library` and `My Profile (n)`.** Not both lists in one scroll — while tuning sliders you want only your ~20 cards visible; while browsing you want only the 70 library rows. Nesting an accordion inside an accordion inside a shared scroll container is how left panels become unusable.

**Library tab:**
- **Search box at top.** With 70 pairs this is not optional. Match against both poles, the facet name, and the note.
- **Two-level grouping that mirrors Table 1 literally.** Level 1 = the three primary categories with R/G/B swatches. Level 2 = the Table 1 sample tiles (Age, Ethnicity, Gender, Race / Climate, Temperature, Coastal-Inland, Urban-Rural, Regional-Country / Family, Religion, Employer, Profession, Politics, Avocations). This costs nothing extra and it *teaches the taxonomy while the user browses* — real value for a class project, where the grader is looking for evidence you engaged with the source framework.
- **Each row:** `Urban ↔ Rural`, a 3-segment mix bar showing the R/G/B weights, an immutability pip, and a `+`. Already-added pairs show a check; clicking scrolls to their card rather than duplicating. **One answer per `pairId`, enforced** — simpler, and semantically right (you have one position on urban-vs-rural).
- Default state: all groups collapsed except Demographic, so you don't open onto a wall of 70 rows.

## The answer card

```
┌──────────────────────────────────────────────────┐
│ ● Geographic · Urban-Rural              [⌄] [×]  │
│                                                  │
│  Urban ◀━━━━━━━━━━━━━●━━━━━━━━▶ Rural            │
│              ╵                                   │
│           somewhat Rural  (+0.35)                │
│                                                  │
│  Matters to me   ○ ─ ◉ ─ ○ ─ ○                   │
│                  Dormant Minor NOTABLE Core      │
└──────────────────────────────────────────────────┘
   [⌄] expands →  Fixedness ◀━━●━━━━━━━▶ 0.25  [↺]
```

- Poles labeled at both ends, permanently. Never a dropdown, never a legend.
- **A word readout, not just a number:** "strongly Urban" / "leaning Urban" / "equally both" / "leaning Rural" / "strongly Rural", with the numeric value secondary. The entire app is about words; the primary readout should be one.
- Center tick on the track with **snap-to-center within ±0.03**, so "equally both" is exactly achievable rather than approximately. Shift-drag for fine control.
- Keyboard: arrows ±0.05, Home/End to poles, `Backspace` removes.
- **Fixedness collapsed behind a disclosure**, pre-filled from the library preset. Most users never open it; it's exposed because it controls radius and is genuinely meaningful ("did you choose this or were you given it?"). Required for custom pairs.

## One slider or two? Two. This is the most consequential answer here.

**Recommend `position` + `strength` as separate controls.** Four reasons, strongest first:

1. **One slider cannot represent the theoretically interesting case.** With a single slider the center means both "I am equally both" and "this doesn't apply to me." Those are structural opposites. The first is a strong hybrid identity — Chao & Moon's discussion of hybrid and merged identities, LaFromboise et al.'s biculturalism, the paper's Hermans & Kempen quote ("I can speak differentially as a psychologist, a man, a Catholic, a member of a conservative Dutch family"). It should render as a **dense, high-stiffness tile straddling two poles**. The second is a dormant tile and should contribute **nothing**. No single number encodes both.

2. **The source theory separates them explicitly.** Proposition 2 (p. 1133): *"Activation of particular patterns of cultural identities is influenced by the strength of the pattern as well as situational contexts,"* with the surrounding text stating *"Strong identity patterns are more likely to be tapped than weak patterns."* Identity **content** and identity **strength** are two distinct constructs in Chao & Moon. Collapsing them into one control is a fidelity loss you would have to defend out loud in a class presentation — and you couldn't.

3. **The physics requires it.** SIMP/BESO needs a *magnitude* (load, seed density, stiffness) and a *direction* (which pole → where in space, which color emphasis). Position supplies direction; strength supplies magnitude. With one slider you'd be forced to fake magnitude as `|position|` — which makes balanced identities weightless, the exact inverse of what the theory says. That's not a compromise, it's a sign error.

4. **The cost is controllable if you pick the right control.** Use a **4-step segmented control (Dormant / Minor / Notable / Core), not a second continuous slider.** This is what keeps the second control from doubling interaction cost: 4 labeled buttons is one click and one glance, and 4 levels is ample resolution for the physics. Twenty continuous sliders to tune would be tedious; twenty one-click choices is fast. Map to `{0, 0.33, 0.66, 1.0}`.

**Dormant is a real, kept state.** A Dormant answer stays in the document (so you can toggle it back), renders ghosted in the list, and is excluded from the seed field. **Unanswered library pairs simply aren't in `answers`** and contribute nothing — no sentinel values, no special cases.

## Custom-pair form

Fields:
- **Pole A**, **Pole B** — text, required.
- **Category mix** — a **barycentric ternary picker**: a triangle with R/G/B at the vertices and a draggable dot. It is genuinely the correct control for a 3-way normalized mix (three independent sliders let you specify states that don't mean anything and hide the constraint), it's ~40 lines of canvas or SVG, and it *shows* the user that mixing means moving toward an edge. Provide three numeric inputs as a keyboard-accessible fallback.
- **Immutability** — slider with labeled anchors: "Chosen daily" / "Long-term" / "Given at birth."
- **Facet** — optional select from the Table 1 facets, plus "Custom."
- **Note** — optional, 0–120 chars.

Validation:
- Both poles present after trimming; 1–24 chars; **must differ case-insensitively**.
- Reject control characters; collapse internal whitespace.
- Mix must not be all-zero → *"Pick at least one category."* Normalize on save.
- Immutability clamped to [0,1].
- If the pole pair duplicates an existing pair, **warn but don't block** (users legitimately want their own phrasing).
- **Live preview chip** showing the resulting color and a dot on a miniature polar diagram, so the user sees *where it will land* before committing. This turns an abstract form into a direct-manipulation one.

## Run controls: a persistent footer on the LEFT panel

Not floating over the artwork, not in a modal, not on the right.

```
Row 1:  [▶ Run] [⏸] [↺ Reset]     iter 47/120 · vol 0.31 · C 1.4e3
Row 2:  ⌄ Solver  (collapsed by default)
          Mode        [ SIMP | BESO ]
          Volume      ◀━━━━●━━━━▶  0.35
          Iterations  ◀━━●━━━━━━▶  120
          Penalty p   ◀━━━●━━━━━▶  3.0      (SIMP only)
          Filter r    ◀━●━━━━━━━▶  1.8
          Resolution  [ 60 | 90 | 120 ]
```

Why the left footer: the right panel stays a clean art frame — which matters, because you will screenshot it for the class — and the controls sit adjacent to the inputs they operate on. The `Solver` group is collapsed by default because those are tuning parameters, not primary controls.

`Reset` restores density to the seed field and keeps all answers. `Clear profile` lives in the toolbar behind a confirmation — never adjacent to `Reset`.

## Full-window wireframe

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ Cultural Mosaic — untitled*                                                — □ × │
├───────────────────────────────────────────────────────────────────────────────────┤
│ [Open] [Save] [Export PNG…]        │  ☑ Scaffolding   Theme [Paper|Ink]  [⤢]     │
├──────────────────────────────────────┬────────────────────────────────────────────┤
│  ( Library )  ( My Profile · 14 )    │                                            │
│ ┌──────────────────────────────────┐ │            ·  ·  ·  ·  ·  ·  ·             │
│ │ 🔍 search 70 pairs…              │ │        ·                        ·          │
│ └──────────────────────────────────┘ │      ·      ◤ DEMOGRAPHIC ◥       ·        │
│                                      │    ▲                               ·       │
│ ▼ ● DEMOGRAPHIC                      │   ╱ ▓▓▓▒▒         ▒▒▓▓▓▓          ▲       │
│    ▸ Age            (5)              │  ·  ▓▓▓▓▓▒░     ░▒▓▓▓▓▓▓▓          ╲      │
│    ▸ Ethnicity      (4)              │ ·    ░▒▓▓▓▓▓▒▒▒▓▓▓▓▒░  ▒▓▓▓         ·     │
│    ▾ Gender         (3)              │ ·      ░▒▓▓▓▓▓▓▓▓▒░      ▒▓▓        ·     │
│       Masculine ↔ Feminine  ▮▯▯  ✓   │ ·  ░▒▓▓▓▓▒░  ░▒▒▒▒░   ░▒▓▓▓▓▒      ·      │
│       Cis      ↔ Trans      ▮▯▯  +   │ ▲   ▓▓▓▒░       ↓F      ░▒▓▓▓▓▓     ·     │
│    ▸ Race           (4)              │ ╲     ░▒▓▓▓▒▒▒▓▓▓▓▓▓▒▒▒▓▓▓▓▒░      ▲     │
│                                      │ ·        ░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▒░        ╱      │
│ ▶ ● GEOGRAPHIC       (24)            │  ·          ░░▒▒▓▓▓▓▒▒░░          ·      │
│ ▶ ● ASSOCIATIVE      (30)            │   ·                              ·        │
│                                      │     ◣ ASSOCIATIVE      GEOGRAPHIC ◢       │
│ ┌── + New custom pair ─────────────┐ │        ·                       ·          │
│ │  Pole A [Individualist        ]  │ │             ·  ·  ·  ·  ·  ·               │
│ │  Pole B [Collectivist         ]  │ │                                            │
│ │  Mix        ╱◆╲   R ●━ 0.50      │ │   ┌──────────────────────────┐             │
│ │            ╱ ● ╲  G ━  0.00      │ │   │ Urban ↔ Rural            │             │
│ │           ╱─────╲ B ●━ 0.50      │ │   │ somewhat Rural · Notable │             │
│ │  Fixed  ◀━━●━━━━▶  0.30          │ │   │ Geographic · r 0.41      │             │
│ │  preview ◐ magenta · r 0.70      │ │   └──────────────────────────┘             │
│ │              [Cancel]  [Add]     │ │           ▲ hover tooltip                  │
│ └──────────────────────────────────┘ │                                            │
├──────────────────────────────────────┤   ▲ = pinned rim anchor (ground symbol)    │
│ [▶ Run] [⏸] [↺]  47/120 vol .31     │   ↓F = load vector                         │
│ ⌄ Solver   SIMP|BESO  vol ━●━ .35   │   · = sector guide (scaffolding on)         │
└──────────────────────────────────────┴────────────────────────────────────────────┘
   ← 380px fixed                              → flex, square-cropped and centered
```

---

# E. Persistence and export

## Profile JSON

- **Extension: `.mosaic.json`.** Double extension so it's obviously plain JSON — openable in any editor, readable by a grader, diffable in git — while still filterable in the dialog. Filter: `[{ name: 'Cultural Mosaic Profile', extensions: ['json'] }]`.
- **Pretty-print, 2-space indent.** The file is 10–30KB; size is irrelevant and human-readability is worth real points on a class project.
- Shape is `MosaicProfile` from section C, verbatim — including the `pairs` snapshot and the full `solver` config with its `seed`, so that reopening a file and pressing Run reproduces the *same artwork*. That reproducibility promise is why determinism is a hard contract with the numerics agent.

**Load policy: liberal on read, strict on write.**

```ts
export function parseProfile(raw: unknown): 
  { ok: true; profile: MosaicProfile; warnings: string[] } | { ok: false; errors: string[] };
```

- Check `kind === 'cultural-mosaic-profile'` first — it's what lets you reject an unrelated JSON file with a real message instead of a `TypeError`.
- If `schemaVersion` is **newer** than you know: refuse, with *"This file was saved by a newer version."* Silently dropping fields you don't understand loses user data.
- If **older**: run an ordered migration chain.
- Otherwise: **clamp rather than reject.** Out-of-range `position`, `strength`, `volumeFraction` become warnings, not failures. Collect *all* problems and report them together. A user should never lose an artwork because one number drifted.

**Write `migrate.ts` on day one, with a single identity migration.** It's 15 lines now, and retrofitting it after v1 files exist in the wild is exactly when people lose files.

**Unsaved-changes guard, zero extra IPC:** track a dirty flag in the renderer and use `window.onbeforeunload`. Electron fires `beforeunload` on window close, and returning a non-void value cancels it — at which point you show your own dialog. No new channel needed. Low priority; add it late.

## High-resolution PNG export

**Never scale the display canvas.** Render fresh at target size using the same renderer code with a different `scale`, which is why `OverlayRenderer` must take `scale` as a parameter from the start rather than hardcoding pixel sizes.

Presets: `1× (display)`, `2048px`, `4096px`, `8× cells`.

**Mosaic mode:** build the N×N `ImageData` exactly as on screen, put it on an N×N offscreen canvas, then `drawImage` to the large canvas with `imageSmoothingEnabled = false` at an **integer** scale factor. Nearest-neighbour at an integer factor is mathematically exact — perfectly hard-edged tiles, no artifacts.

**Smooth mode — the one insight that matters most here: resample the float field first, tone-map second. Never the reverse.**

The obvious approach (tone-map at 120², then bilinear-upscale 34× to 4096) gives you a mushy image whose solid/void boundary was anti-aliased at 120px and then blurred. Instead, Catmull-Rom resample **ρ and each color channel as floats** to the output resolution, *then* apply the smoothstep and gamma composite per output pixel. The structural boundary is now anti-aliased at 4096px. It is the difference between a blown-up screenshot and a print. ~50 lines in `render/resample.ts`, used only by export.

**Overlay in export:** optional (`Include scaffolding` checkbox, default off). Draw to the same large canvas with every length, stroke width, and font size multiplied by the same scale factor.

**Getting bytes out:** `canvas.toBlob('image/png')` → `await blob.arrayBuffer()` → `new Uint8Array(...)` → `window.mosaic.exportPng(bytes, name)`. Main runs `showSaveDialog` and `fs.writeFile`. A 4096² PNG is ~3–10MB, fine as a one-shot structured clone.

**Also offer "save the profile JSON alongside the image."** An exported artwork that can't be traced back to the answers that produced it is a dead end, and this is the two-line version of solving that. (The elegant version — embedding the profile JSON in a PNG `tEXt` chunk so the image literally carries its own genome — needs a ~40-line CRC32 chunk splicer. Lovely for an art project, but a stretch goal, not a v1.)

## SVG export: recommend against, with a condition

1. **It would throw away the point of the piece.** Marching squares on ρ at an iso-level gives you a single-color contour. The mosaic's whole identity is the *multi-colored* field. To preserve color you'd need either one contour set per color-quantized region (a full planar-map / polygon-boolean problem) or 14,400 `<rect>` elements — which is not vector art, it's a bitmap in XML at 10× the bytes.
2. **The benefit is near-zero.** SVG buys resolution independence for print. An 8192px PNG prints at 27 inches at 300dpi. You are not exceeding that.
3. **The cost is high and concentrated in fiddly places:** contour stitching, hole detection, winding-order correctness for interior voids, degenerate-cell disambiguation. All of it debugging geometry, none of it advancing the project's actual thesis.

**The condition:** if you later want a *truss line-art* aesthetic — stroked iso-contours over flat fills — then you'd implement marching squares for **rendering** reasons. At that point contours exist and SVG export becomes nearly free. So the honest ordering is: ship PNG; revisit SVG only if a contour render mode earns its way in aesthetically. Don't build the contour extractor for the export format.

---

# F. File and module layout

```
Cultural Mosaic/
├─ docs/                              # the two source PDFs, moved out of the root
├─ electron.vite.config.ts            # three build targets; renderer.worker options
├─ electron-builder.yml               # Windows NSIS installer config
├─ tsconfig.json                      # solution file: files:[] + references to the four below
├─ tsconfig.base.json                 # shared strictness (see A)
├─ tsconfig.node.json                 # main + preload: ES2022, node types, NO DOM
├─ tsconfig.web.json                  # renderer: DOM + vite/client, strict
├─ tsconfig.worker.json               # solver: WebWorker lib only, noUncheckedIndexedAccess OFF
└─ src/
   ├─ shared/
   │  └─ ipc-contract.ts              # channel names + request/response types; imported by all three
   ├─ main/
   │  ├─ index.ts                     # app lifecycle, hardened BrowserWindow, navigation denial
   │  ├─ ipc.ts                       # registers exactly four ipcMain.handle handlers
   │  └─ dialogs.ts                   # save/open dialogs + fs read/write — the ONLY fs in the app
   ├─ preload/
   │  ├─ index.ts                     # contextBridge.exposeInMainWorld('mosaic', {4 named fns})
   │  └─ index.d.ts                   # global Window augmentation for window.mosaic
   └─ renderer/
      ├─ index.html                   # CSP meta tag, single #root
      └─ src/
         ├─ main.tsx                  # React root; constructs the SolverSession singleton
         ├─ App.tsx                   # toolbar + two-panel shell
         ├─ styles/
         │  ├─ theme.css              # CSS custom properties: paper/ink palettes, category colors
         │  └─ *.module.css           # one per component
         ├─ domain/
         │  ├─ taxonomy.ts            # CategoryId/FacetId, SECTOR_CENTER_DEG, category→RGB
         │  ├─ types.ts               # WordPair, TileAnswer, MosaicProfile, *Config — pure, zero imports
         │  ├─ library.ts             # the ~70 seeded pairs as one typed const array
         │  ├─ library.test.ts        # ids unique, mixes non-zero, immutability in range, facets valid
         │  ├─ pair-utils.ts          # pairId→WordPair resolution, label formatting, word readouts
         │  ├─ validate.ts            # parseProfile(unknown): clamp + collect errors
         │  └─ migrate.ts             # ordered schemaVersion migration chain
         ├─ layout/
         │  ├─ polar.ts               # placeAnswers(answers, pairs, cfg) → PlacedTile[] — PURE
         │  ├─ polar.test.ts          # golden-file + property tests on the placement math
         │  ├─ seed-field.ts          # PlacedTile[] → SeedField, mutating in place, zero allocation
         │  ├─ seed-field.test.ts     # determinism, mass-vs-strength linearity, provenance coverage
         │  └─ boundary.ts            # PlacedTile[] → BoundaryConditions (fixed dofs, load dofs/values)
         ├─ solver/
         │  ├─ protocol.ts            # SolverRequest/Response, MeshSpec, SeedField — no DOM, no WebWorker
         │  ├─ solver.worker.ts       # worker entry: message loop + buffer recycling; owns the kernel
         │  ├─ kernel/                # ← the numerics agent's territory (FEA assembly, OC/BESO, filter)
         │  └─ SolverSession.ts       # THE boundary: the only file that mentions Worker; latestFrame + dirty
         ├─ state/
         │  ├─ store.ts               # zustand: profile document + UI toggles + actions
         │  └─ selectors.ts           # memoized derived reads (placedTiles, groupedLibrary, isDirty)
         ├─ render/
         │  ├─ tone.ts                # sRGB↔linear LUTs, smoothstep, gamma-correct compositing
         │  ├─ FieldRenderer.ts       # density+color → ImageData → offscreen → integer-snapped blit
         │  ├─ OverlayRenderer.ts     # sector guides, ground symbols, load arrows, hover ring; takes scale
         │  ├─ resample.ts            # Catmull-Rom float-field resample — export only
         │  └─ export-png.ts          # offscreen high-res render → Blob → Uint8Array
         ├─ components/
         │  ├─ MosaicCanvas.tsx       # two stacked canvases, rAF loop, DPR snapping, hit-testing
         │  ├─ LeftPanel.tsx          # Library | My Profile tabs + run footer
         │  ├─ LibraryBrowser.tsx     # search + two-level Table 1 accordions + add buttons
         │  ├─ AnswerCard.tsx         # pole slider + strength segments + fixedness disclosure
         │  ├─ PolePairSlider.tsx     # labeled two-pole slider: keyboard, snap-to-center, word readout
         │  ├─ StrengthSelector.tsx   # 4-step Dormant/Minor/Notable/Core segmented control
         │  ├─ CustomPairForm.tsx     # new-pair fields + validation + live preview chip
         │  ├─ TernaryMixPicker.tsx   # barycentric R/G/B weight picker
         │  ├─ RunControls.tsx        # Run/Pause/Reset + collapsed Solver disclosure
         │  ├─ RunStatus.tsx          # LEAF — the only throttled-progress subscriber (isolation is load-bearing)
         │  ├─ Toolbar.tsx            # Open / Save / Export PNG / theme / scaffolding
         │  └─ Tooltip.tsx            # provenance tooltip, re-renders only when hovered answerId changes
         └─ hooks/
            ├─ useAnimationFrame.ts   # rAF loop with correct cleanup
            └─ useCanvasSize.ts       # ResizeObserver → DPR-snapped integer-cell canvas sizing
```

---

# G. Build order

Each step ends in something you can run and check.

**Step 0 — Scaffold and harden.**
Move PDFs to `docs/`, `git init`, scaffold, delete `electron-updater` and `@electron-toolkit/preload`, split the four tsconfigs, add the CSP meta tag, set `sandbox: true`.
**See:** an empty window titled Cultural Mosaic; editing `App.tsx` hot-updates instantly.
**Verify:** `npx tsc -b` clean; DevTools console has zero CSP violations; preload logs `process.contextIsolated === true`.

**Step 1 — Prove the worker path before writing any app code.**
A throwaway `solver.worker.ts` that receives a `Float32Array`, doubles it, and transfers it back. Wired through `?worker` inside `SolverSession.ts`.
**See:** a debug button printing the round-tripped array.
**Verify (automatable):** assert `sentArray.byteLength === 0` after posting — that's proof the transfer was zero-copy rather than a silent structured-clone copy. Then **run the same check against `npm run build && npm start`, not just `npm run dev`.** Dev serves over `http://localhost` and will pass even when the packaged `file://` build fails. This is the highest-risk item in the project and it costs 30 minutes to retire on day one. If it fails: `?worker` → `?worker&inline`, one line, one file.

**Step 2 — Domain model and library data. No UI.**
`types.ts`, `taxonomy.ts`, all ~70 pairs in `library.ts`.
**Verify (no human eye):** vitest asserts 70 unique ids; every `mix` sums > 0; every `immutability` ∈ [0,1]; every `facet` is a valid Table 1 facet; all poles non-empty, trimmed, and distinct within a pair. This catches the data-entry typos that would otherwise surface as one mysteriously-misplaced tile in week three.

**Step 3 — Polar placement math with golden-file tests.**
`placeAnswers` as a pure function. θ from the **circular weighted mean** of sector centers:
`vx = Σ wᶜ·cos(centerᶜ)`, `vy = Σ wᶜ·sin(centerᶜ)`, `θ = atan2(vy, vx)`, `purity = |v|`.

This has an elegant property worth asserting explicitly: **equal two-way mixes land exactly on the corresponding sector boundary.** 50/50 R+B → `(1.0, 0)` → **0°**, the Demographic/Associative boundary. 50/50 R+G → **120°**. 50/50 G+B → **240°**. So the doc's own example — "Individualist vs Collectivist affects R and B" — lands on the R/B seam with no special-casing. That's the mapping validating itself.

**And it has a silent failure mode you must handle.** An equal three-way mix gives `v = (0, 0)`, and JavaScript's `atan2(0, 0)` returns `0` — not `NaN`. So a perfectly integrated identity is quietly placed at 0° (the R/B seam) and *nothing looks broken*. Correct handling: when `|v| < ε`, the tile is category-neutral — it *is* the doc's "Concordant Core" — so place it at `r = minRadius` with θ from a stable hash of the `pairId`, and let it render near-white. Semantically right, and it turns a silent lie into a designed behavior.

**Verify (fully automated):**
- Golden table of placements for a fixed 12-answer fixture, written as explicit expected values (not an opaque snapshot) so a diff is readable.
- Property assertions: pure-Demographic θ ∈ [0,120); the three two-way boundary cases above, exactly; `immutability = 1` → `r === rimRadius`; `immutability = 0` → `r === minRadius`; the degenerate three-way case hits the documented tiebreak rather than 0°; identical input → byte-identical output across runs.
- **Angular slotting must spread by the answer's index within the user's set, not by the pair's index in the library.** Otherwise a user who adds 20 Associative pairs gets them all stacked near 300°. Assert minimum angular separation over a 20-same-category fixture.

**Step 4 — Seed field + FieldRenderer + canvas. No solver.**
**See:** the right panel shows the colored seed mosaic from a hardcoded fixture.
**Verify:** seed-field determinism; total seeded mass linear in strength; every non-empty cell has a valid `provenance`. Screenshot at both 100% and 150% Windows display scaling to confirm the integer-cell snapping — cells must be identical widths at both.

**Step 5 — Left panel: library browser, answer cards, zustand store.**
**See:** browse 70 pairs, search, add, drag sliders; the seed mosaic updates live with no perceptible lag.
**Verify:** add a dev-only render counter to `MosaicCanvas` that `console.warn`s if it renders more than once per profile-*structure* change. Drag a slider through its full range: the warning must not fire. This is a cheap, permanent regression test on the single most important architectural property in the app.

**Step 6 — SolverSession + frame pump against a FAKE solver.**
A stub kernel that just blurs-and-thresholds ρ each step. Same `protocol.ts`, same messages, same recycling.
**See:** press Run → animated erosion at 60fps, iteration counter ticking, Pause and Reset working.
**Verify:** the entire streaming architecture is proven *before* the real numerics land — so when they do, any bug is unambiguously in the kernel. Also log allocation count per frame: it must go flat after the first two frames, proving the buffer ping-pong works. This step is also the clean integration seam with the other agent.

**Step 7 — Drop in the real FEA/SIMP kernel behind the identical protocol.**
**See:** real truss-like structures emerging from your actual identity profile.
**Verify:** the numerics agent's own benchmarks (MBB beam / cantilever against published compliance), plus integration assertions here: compliance decreases monotonically after the first few iterations; volume converges to `volumeFraction` within tolerance; two runs with the same config and seed produce bit-identical final density.

**Step 8 — Overlay layer, provenance tooltips, scaffolding toggle.**
**See:** sector guides, ground symbols at rim anchors, load arrows; hovering a tile names the word pair that produced it.
**Verify:** unit test mapping canvas coordinates → cell index → provenance → `answerId` for a known fixture, including the edges and the outside-domain case.

**Step 9 — Custom pairs, ternary picker, validation.**
**See:** author "Individualist ↔ Collectivist" at a 50/50 R/B mix and watch it land exactly on the R/B seam — the source doc's own example, working.
**Verify:** one unit test per validation rule, including the all-zero-mix rejection and the case-insensitive duplicate-pole check.

**Step 10 — Persistence.**
Save/Open via IPC, `parseProfile`, migration scaffold.
**See:** save, quit, relaunch, open → the same mosaic, and pressing Run reproduces the same artwork.
**Verify:** round-trip test (`parseProfile(JSON.parse(JSON.stringify(p)))` deep-equals `p`); a golden fixture `.mosaic.json` committed to the repo that must keep loading forever; assert a v2-labeled file is *refused* rather than silently degraded.

**Step 11 — PNG export.**
**See:** a 4096px PNG on disk that looks materially *better* than the screen version.
**Verify:** assert output dimensions; assert a 1× export is pixel-identical to the display render — that's a genuine regression test on the whole tone-mapping path. Then eyeball the 4096 for the resample-then-tone-map edge quality.

**Step 12 — Package.**
`electron-builder --win nsis`.
**See:** an installer in `dist/`; install it, launch from the Start Menu, run a full optimization, export a PNG.
**Verify:** this is where a broken worker path or CSP rule surfaces — which is exactly why Step 1 tested the built output too.

---

# Genuine risks, ranked

1. **Module worker under packaged `file://`.** Highest-probability blocker. Retired on day one by Step 1 testing the *built* output; contained by `SolverSession.ts` being the only file that names `Worker`. Fallback is `?worker&inline`.
2. **StrictMode double-mount creating two workers.** Presents as a doubled frame rate and interleaved garbage in `latestFrame`. Looks exactly like a solver bug; isn't. Singleton or ref-guard + `terminate()` in cleanup.
3. **`RunStatus` placed above `MosaicCanvas`.** Silently reintroduces 10Hz whole-tree re-renders and hitching, after you did all the work in C to avoid it. Enforced by the Step 5 render-counter test.
4. **The `atan2(0,0) === 0` degenerate mix.** A silent semantic bug, not a crash — the worst kind. Handled explicitly in Step 3 and asserted.
5. **Angular crowding.** ~65 of the 70 library pairs are single-category, so a user with 20 Associative answers gets them all near 300°. Slot by *answer index within the user's set*, not by library position. Asserted in Step 3.
6. **`noUncheckedIndexedAccess` vs. FEA inner loops.** Real friction, solved cleanly by scoping the relaxation to `tsconfig.worker.json` rather than weakening it everywhere.
7. **`DOM` + `WebWorker` libs in one tsconfig.** Produces conflicting global declarations and error messages that read like nonsense. Prevented by the four-project split.
8. **Windows fractional DPI (1.25/1.5).** Shimmer and uneven cells — reads as a rendering bug in an app about crisp tiles. Prevented by integer-cell snapping.
9. **Solver determinism.** The persistence promise in E depends on it. Make it an explicit written contract with the numerics agent: no bare `Math.random()`; all stochasticity seeded from `SolverConfig.seed`.
10. **A space in the project path** (`Cultural Mosaic`). Almost always fine, but if you hit an inexplicable electron-builder or native-tooling error, this is the first suspect. OneDrive is *not* a factor here — `Documents` is a real local folder on this machine, so the usual `node_modules` sync-lock hazard doesn't apply. Just don't enable OneDrive's Documents backup while working on this.

### Critical Files for Implementation

- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\electron.vite.config.ts` — the worker bundling config; the single highest-risk file
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\renderer\src\solver\SolverSession.ts` — the only file that constructs a `Worker`; owns `latestFrame`, the dirty flag, and buffer recycling
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\renderer\src\layout\polar.ts` — the circular-mean placement math, including the degenerate-mix tiebreak and angular slotting
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\renderer\src\components\MosaicCanvas.tsx` — the rAF loop that keeps 60Hz solver output out of React
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\renderer\src\domain\types.ts` — the four-layer separation that the source doc's `CulturalNode` collapses
- `C:\Users\bmusgrave\Documents\Electron\Cultural Mosaic\src\renderer\src\render\FieldRenderer.ts` — linear-light tone mapping and integer-cell DPR snapping