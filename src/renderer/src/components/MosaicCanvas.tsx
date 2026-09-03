import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { placeAnswers } from '../layout/polar'
import { buildFields, createFields, createGrid } from '../layout/fields'
import type { Grid, MosaicFields } from '../layout/fields'
import { buildBoundary } from '../layout/boundary'
import type { BoundaryConditions } from '../layout/boundary'
import { ANTAGONISMS } from '../domain/library'
import { LEAN_NOTCHES } from '../domain/types'
import type { PlacedTile } from '../domain/types'
import { FieldRenderer, snapToCells } from '../render/FieldRenderer'
import { OverlayRenderer } from '../render/OverlayRenderer'
import { getSolverSession } from '../solver/SolverSession'
import { FREE, SOLID_PASSIVE, VOID_PASSIVE } from '../solver/protocol'
import { deriveVolumeFraction } from '../layout/fields'
import { exportPng } from '../render/export-png'
import { THEMES } from '../render/tone'

/**
 * Two stacked canvases and ONE rAF loop.
 *
 * This component mounts once and never re-renders during a run. That is the single most
 * important architectural property in the app: if the solver's frame path touched React
 * state it would schedule 60 renders/sec of a tree containing the canvas, and the canvas
 * would be re-reconciled or torn down every frame.
 *
 * So: three dirty flags, read by the loop. Store subscriptions and worker messages set
 * a flag and return. Nothing on a hot path calls setState.
 */

interface Derived {
  tiles: PlacedTile[]
  fields: MosaicFields
  bc: BoundaryConditions
}

export default function MosaicCanvas(): JSX.Element {
  const fieldRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Low-frequency UI state only. Never touched from the frame path.
  const [readout, setReadout] = useState<{
    anchors: number
    loads: number
    volume: number
    repairs: readonly string[]
    answered: number
    synthetic: number
  }>({ anchors: 0, loads: 0, volume: 0, repairs: [], answered: 0, synthetic: 0 })

  const theme = useStore((s) => s.render.theme)

  useEffect(() => {
    const fieldCanvas = fieldRef.current
    const overlayCanvas = overlayRef.current
    const wrap = wrapRef.current
    if (!fieldCanvas || !overlayCanvas || !wrap) return

    const fctx = fieldCanvas.getContext('2d', { alpha: false })
    const octx = overlayCanvas.getContext('2d')
    if (!fctx || !octx) return

    const renderer = new FieldRenderer(fieldCanvas, fctx)
    const overlay = new OverlayRenderer(overlayCanvas, octx)
    const session = getSolverSession()

    let grid: Grid | null = null
    let derived: Derived | null = null
    let gridSize = 0

    let seedDirty = true
    let overlayDirty = true
    let sizeDirty = true
    let phase = 0
    let raf = 0
    /** True once a run has produced frames, so the seed is not redrawn over them. */
    let showingSolverOutput = false

    /**
     * Build the element-state array the kernel needs: void outside the disc, solid
     * where a pin or load patch sits, free elsewhere.
     */
    const buildProblem = (): void => {
      if (!derived || !grid) return
      const s = useStore.getState()
      const { fields, bc } = derived
      const state = new Uint8Array(grid.count)
      for (let i = 0; i < grid.count; i++) state[i] = grid.mask[i] ? FREE : VOID_PASSIVE
      for (const e of bc.solidPassive) state[e] = SOLID_PASSIVE

      const rho0 = new Float32Array(grid.count)
      const wField = new Float32Array(grid.count)
      for (let i = 0; i < grid.count; i++) {
        rho0[i] = fields.rho0[i]!
        wField[i] = fields.w[i]!
      }

      const vf =
        s.solver.volumeFraction === 'derived'
          ? deriveVolumeFraction(derived.tiles)
          : s.solver.volumeFraction

      session.init(
        {
          nelx: grid.n,
          nely: grid.n,
          state,
          rho0,
          w: wField,
          fixedDofs: bc.fixedDofs,
          loadDofs: bc.loadDofs,
          loadValues: bc.loadValues,
        },
        {
          mode: s.solver.mode,
          volumeFraction: vf,
          penalty: s.solver.penalty,
          filterRadius: s.solver.filterRadius,
          moveLimit: s.solver.moveLimit,
        },
      )
    }

    const onRun = (ev: Event): void => {
      const n = (ev as CustomEvent<{ iterations: number }>).detail?.iterations ?? 120
      if (seedDirty) {
        rebuild()
        seedDirty = false
      }
      buildProblem()
      showingSolverOutput = true
      session.step(n)
    }

    const onReset = (): void => {
      showingSolverOutput = false
      session.clearFrame()
      seedDirty = true
    }

    /**
     * Export renders FRESH at the target size rather than scaling the display canvas,
     * using whichever field is currently on screen (optimized result if a run has
     * produced one, otherwise the seed).
     */
    const onExport = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ size: number; done: (err?: string) => void }>).detail
      void (async () => {
        try {
          if (!derived) throw new Error('Nothing to export yet.')
          const s = useStore.getState()
          const density =
            showingSolverOutput && session.latestFrame
              ? session.latestFrame.density
              : derived.fields.rho0
          const bytes = await exportPng(
            {
              n: derived.fields.grid.n,
              density,
              hue: derived.fields.hue,
              kappa: derived.fields.kappa,
              mask: derived.fields.grid.mask,
              ...(s.render.showGhost ? { ghost: derived.fields.rho0 } : {}),
            },
            s.render,
            {
              size: detail.size,
              includeScaffolding: s.render.showScaffolding,
              tiles: derived.tiles,
              synthetics: derived.bc.syntheticAnchors,
              rimRadius: s.layout.rimRadius,
            },
          )
          const name = `${s.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'mosaic'}-${detail.size}.png`
          const res = await window.mosaic.exportPng(bytes, name)
          detail.done(res.error)
        } catch (err) {
          detail.done((err as Error).message)
        }
      })()
    }

    window.addEventListener('mosaic:run', onRun)
    window.addEventListener('mosaic:reset', onReset)
    window.addEventListener('mosaic:export', onExport)

    const rebuild = (): void => {
      const s = useStore.getState()
      if (!grid || gridSize !== s.layout.gridSize) {
        gridSize = s.layout.gridSize
        grid = createGrid(gridSize, s.layout.rimRadius)
        derived = null
        sizeDirty = true
      }
      const pairs = s.allPairs()
      const tiles = placeAnswers({ answers: s.answers, pairs, layout: s.layout })
      const fields = derived?.fields ?? createFields(grid)
      buildFields(fields, tiles, {
        filterRadius: s.solver.filterRadius,
        volumeFraction: s.solver.volumeFraction,
      })
      const leanByPair = new Map<string, number>()
      for (const a of s.answers) leanByPair.set(a.pairId, LEAN_NOTCHES[a.leanIndex] ?? 0)
      const bc = buildBoundary(tiles, { grid, antagonisms: ANTAGONISMS, leanByPair })

      // Roles are finalized by boundary.ts (anchor caps, promotions, repairs), so fold
      // them back so the overlay draws the marks that were actually applied.
      const finalTiles = tiles.map((t) => ({ ...t, role: bc.roles.get(t.answerId) ?? t.role }))
      derived = { tiles: finalTiles, fields, bc }

      // One low-frequency setState per profile edit -- human speed, not frame speed.
      setReadout({
        anchors: bc.nAnchors,
        loads: bc.nLoads,
        volume: fields.volumeFraction,
        repairs: bc.repairs,
        answered: tiles.length,
        synthetic: bc.syntheticAnchors.length,
      })
    }

    const resize = (): void => {
      if (!grid) return
      const rect = wrap.getBoundingClientRect()
      /**
       * Bail on a degenerate box.
       *
       * The ResizeObserver watches the wrapper that App sets to `display: none` when the
       * user steps out to the splash or the quiz, and a hidden element reports a 0x0
       * content rect. Without this guard that collapses the backing store to one device
       * pixel per cell AND sets seedDirty, which aborts any run in flight -- exactly
       * what keeping the studio mounted was supposed to prevent. The observer fires
       * again with the real box on return, and the loop clears sizeDirty either way.
       */
      if (rect.width < 1 || rect.height < 1) return
      const dpr = window.devicePixelRatio || 1
      const { drawPx, cssPx } = snapToCells(rect.width, rect.height, grid.n, dpr)
      for (const c of [fieldCanvas, overlayCanvas]) {
        c.width = drawPx
        c.height = drawPx
        c.style.width = `${cssPx}px`
        c.style.height = `${cssPx}px`
      }
      seedDirty = true
      overlayDirty = true
    }

    const loop = (): void => {
      const s = useStore.getState()

      if (sizeDirty) {
        if (!grid) rebuild()
        resize()
        sizeDirty = false
      }
      if (seedDirty) {
        rebuild()
        seedDirty = false
        overlayDirty = true
        // Editing the profile invalidates any run in progress.
        if (showingSolverOutput) {
          showingSolverOutput = false
          session.abort()
          useStore.getState().setRunning(false)
        }
        if (derived) {
          renderer.draw(
            {
              n: derived.fields.grid.n,
              density: derived.fields.rho0,
              hue: derived.fields.hue,
              kappa: derived.fields.kappa,
              mask: derived.fields.grid.mask,
            },
            s.render,
          )
        }
      }

      /**
       * Solver output -> pixels. No setState anywhere on this path.
       *
       * Gated on showingSolverOutput because abort() is a postMessage: the worker can
       * already have a frame in flight when the profile is invalidated. Ungated, that
       * straggler repaints the stale optimized field over the freshly drawn seed, and
       * nothing marks the canvas dirty again, so it stays wrong until the next edit.
       */
      if (showingSolverOutput && session.fieldDirty && session.latestFrame && derived) {
        renderer.draw(
          {
            n: derived.fields.grid.n,
            density: session.latestFrame.density,
            hue: derived.fields.hue,
            kappa: derived.fields.kappa,
            mask: derived.fields.grid.mask,
            ...(s.render.showGhost ? { ghost: derived.fields.rho0 } : {}),
          },
          s.render,
        )
        session.fieldDirty = false
        phase++
        if (s.render.showScaffolding) overlayDirty = true
      }

      if (overlayDirty && derived) {
        overlay.draw(
          {
            tiles: derived.tiles,
            synthetics: derived.bc.syntheticAnchors,
            rimRadius: s.layout.rimRadius,
            hovered: s.hoveredAnswerId,
            phase,
          },
          s.render,
        )
        overlayDirty = false
      }

      raf = requestAnimationFrame(loop)
    }

    // Non-React subscriptions: mark dirty, never setState.
    const unsubAnswers = useStore.subscribe((s, prev) => {
      if (s.answers !== prev.answers || s.customPairs !== prev.customPairs) seedDirty = true
      if (s.layout !== prev.layout || s.solver !== prev.solver) seedDirty = true
      if (s.render !== prev.render) {
        seedDirty = true
        overlayDirty = true
      }
      if (s.hoveredAnswerId !== prev.hoveredAnswerId) overlayDirty = true
    })

    const ro = new ResizeObserver(() => {
      sizeDirty = true
    })
    ro.observe(wrap)

    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      unsubAnswers()
      ro.disconnect()
      window.removeEventListener('mosaic:run', onRun)
      window.removeEventListener('mosaic:reset', onReset)
      window.removeEventListener('mosaic:export', onExport)
      renderer.dispose()
    }
    // Empty deps: this effect runs once for the app's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const t = THEMES[theme]

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: t.bgHex,
        transition: 'background 120ms',
      }}
    >
      <div
        ref={wrapRef}
        style={{
          flex: 1,
          minHeight: 0,
          position: 'relative',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <div style={{ position: 'relative', lineHeight: 0 }}>
          <canvas ref={fieldRef} style={{ display: 'block', imageRendering: 'pixelated' }} />
          <canvas
            ref={overlayRef}
            style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
          />
        </div>
      </div>
      <StatusStrip readout={readout} themeHex={t.dimHex} inkHex={t.inkHex} />
    </div>
  )
}

/**
 * A LEAF component. It must never sit above MosaicCanvas in the tree: it re-renders on
 * every profile edit, and from an ancestor position it would re-render the canvas too,
 * producing hitching that looks like a solver problem for hours before you find it.
 */
function StatusStrip({
  readout,
  themeHex,
  inkHex,
}: {
  readout: {
    anchors: number
    loads: number
    volume: number
    repairs: readonly string[]
    answered: number
    synthetic: number
  }
  themeHex: string
  inkHex: string
}): JSX.Element {
  return (
    <div style={{ padding: '8px 14px 10px', fontSize: 11, color: themeHex, flex: '0 0 auto' }}>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <span>
          <strong style={{ color: inkHex }}>{readout.answered}</strong> answered
        </span>
        <span title={readout.synthetic > 0 ? `${readout.synthetic} added by the app` : ''}>
          <strong style={{ color: inkHex }}>{readout.anchors}</strong> pinned
          {readout.synthetic > 0 ? ` (${readout.synthetic} neutral)` : ''}
        </span>
        <span>
          <strong style={{ color: inkHex }}>{readout.loads}</strong> loads
        </span>
        <span>
          volume <strong style={{ color: inkHex }}>{readout.volume.toFixed(2)}</strong>
        </span>
      </div>
      {readout.repairs.map((r) => (
        <div key={r} style={{ marginTop: 4, color: 'var(--warn)' }}>
          {r}
        </div>
      ))}
    </div>
  )
}
