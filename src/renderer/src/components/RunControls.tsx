import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { getSolverSession } from '../solver/SolverSession'
import type { FrameMetrics } from '../solver/protocol'
import { placeAnswers } from '../layout/polar'
import { createGrid, createFields, buildFields } from '../layout/fields'
import { rankConflicts, rankBonds } from '../layout/interference'
import type { ConflictEntry, BondEntry } from '../layout/interference'
import { ANTAGONISMS } from '../domain/library'
import { useThemeColors, hueToCss } from '../render/useThemeColors'

/**
 * The run footer, pinned to the bottom of the LEFT panel.
 *
 * Not floating over the artwork and not in a modal: the right panel stays a clean art
 * frame -- which matters, because that is what gets screenshotted -- and the controls
 * sit next to the inputs they operate on.
 *
 * This component subscribes to the throttled progress stream and therefore re-renders
 * about ten times a second. It is a LEAF for exactly that reason: from anywhere above
 * MosaicCanvas in the tree it would re-render the canvas ten times a second too, giving
 * hitching that looks like a solver problem for hours before you find it.
 */
export default function RunControls(): JSX.Element {
  const running = useStore((s) => s.running)
  const setRunning = useStore((s) => s.setRunning)
  const solver = useStore((s) => s.solver)
  const setSolver = useStore((s) => s.setSolver)
  const answers = useStore((s) => s.answers)

  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<FrameMetrics | null>(null)

  useEffect(() => {
    const session = getSolverSession()
    const offProgress = session.onProgress(setProgress)
    const offLife = session.onLifecycle((msg) => {
      if (msg.type === 'done' || msg.type === 'error') useStore.getState().setRunning(false)
    })
    return () => {
      offProgress()
      offLife()
    }
  }, [])

  const start = (): void => {
    setRunning(true)
    // The canvas owns the derived fields, so it is the one that can build the problem.
    window.dispatchEvent(new CustomEvent('mosaic:run', { detail: { iterations: solver.iterations } }))
  }
  const pause = (): void => {
    getSolverSession().abort()
    setRunning(false)
  }
  const reset = (): void => {
    getSolverSession().abort()
    setRunning(false)
    setProgress(null)
    // Restores the seed field and keeps every answer.
    window.dispatchEvent(new CustomEvent('mosaic:reset'))
  }

  const disabled = answers.length === 0

  return (
    <div
      style={{
        borderTop: '1px solid var(--border)',
        padding: '8px 10px',
        background: 'var(--panel)',
        flex: '0 0 auto',
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <button onClick={running ? pause : start} disabled={disabled} style={primaryBtn(disabled)}>
          {running ? '❚❚ Pause' : '▶ Run'}
        </button>
        <button onClick={reset} style={btn} title="Restore the seed field, keeping all answers">
          ↺
        </button>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {progress
            ? `${progress.iteration}/${solver.iterations} · vol ${progress.volume.toFixed(2)} · C ${progress.compliance.toPrecision(3)}`
            : disabled
              ? 'add some pairs first'
              : 'ready'}
        </span>
      </div>

      {progress && (progress.islands > 0 || progress.unsupportedLoads > 0 || !progress.cgConverged) && (
        <div style={{ marginTop: 5, fontSize: 10, color: 'var(--warn)', lineHeight: 1.4 }}>
          {progress.islands > 0 && (
            <div>
              {progress.islands} fragment{progress.islands === 1 ? '' : 's'} floating free of the
              structure.
            </div>
          )}
          {progress.unsupportedLoads > 0 && (
            <div>
              {progress.unsupportedLoads} identit{progress.unsupportedLoads === 1 ? 'y has' : 'ies have'}{' '}
              no path to the rim.
            </div>
          )}
          {!progress.cgConverged && <div>Solver hit its iteration cap; result is approximate.</div>}
        </div>
      )}

      <InterferencePanel />

      <button
        onClick={() => setOpen(!open)}
        style={{ ...linkish, marginTop: 8 }}
        aria-expanded={open}
      >
        {open ? '⌄' : '›'} Solver
      </button>

      {open && (
        <div style={{ display: 'grid', gap: 10, marginTop: 6, fontSize: 10 }}>
          <Row
            label={
              solver.volumeFraction === 'derived'
                ? `Volume derived${progress ? ` (${progress.volume.toFixed(2)})` : ''}`
                : `Volume ${solver.volumeFraction.toFixed(2)}`
            }
            desc="How much of the material your answers deposit is allowed to survive -- as a share of what was actually placed, not of the whole disc. 'Derived' sets it from how decisively you answered: strongly-held identities keep more of themselves. Whatever the target cuts is what the physics decides to give up: weak convictions, discordant seams, and both sides of an engaged conflict go first."
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                type="range"
                min={0.18}
                max={0.55}
                step={0.01}
                value={solver.volumeFraction === 'derived' ? 0.35 : solver.volumeFraction}
                onChange={(e) => setSolver({ volumeFraction: Number(e.target.value) })}
                style={{ flex: 1 }}
              />
              {solver.volumeFraction !== 'derived' && (
                <button onClick={() => setSolver({ volumeFraction: 'derived' })} style={linkish}>
                  derive
                </button>
              )}
            </div>
          </Row>
          <Row
            label={`Filter r ${solver.filterRadius.toFixed(1)}`}
            desc="Minimum feature width the optimizer may build, in elements -- this is what stops the checkerboard artifact plane-stress topology optimization produces without it. Must stay at or below half the width of the smallest tile in the profile, or the filter can erase a tile's seed before the solver ever acts on it."
          >
            <input
              type="range"
              min={1.5}
              max={4}
              step={0.1}
              value={solver.filterRadius}
              onChange={(e) => setSolver({ filterRadius: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </Row>
        </div>
      )}
    </div>
  )
}

/**
 * What the last completed run actually did to specific pairs of tiles: which engaged
 * conflicts it ate the most of, and which lattice-neighbour bridges it built the most
 * real material into.
 *
 * A SEPARATE component from the metrics readout above, but the same LEAF discipline:
 * it reads the shared solver session directly (as RunControls itself already does for
 * `progress`) rather than reaching into MosaicCanvas, and it only recomputes on a
 * genuine run completion -- never per frame -- so it adds no cost to the animation
 * loop. See layout/interference.ts for what "conflict" and "bond" mean here.
 */
function InterferencePanel(): JSX.Element | null {
  const answers = useStore((s) => s.answers)
  const layout = useStore((s) => s.layout)
  const solver = useStore((s) => s.solver)
  const theme = useThemeColors()

  // Prominent by default: this is the "reinforced and conflicting pairs" readout, and
  // it should be the first thing visible under the Run button, not a disclosure a
  // user has to know to open.
  const [open, setOpen] = useState(true)
  const [result, setResult] = useState<{
    conflicts: readonly ConflictEntry[]
    bonds: readonly BondEntry[]
  } | null>(null)

  useEffect(() => {
    const session = getSolverSession()
    return session.onLifecycle((msg) => {
      // 'done' also covers an aborted run (a profile edit interrupting mid-solve) --
      // that is a snapshot of an intermediate state, not a result, so it is excluded.
      if (msg.type !== 'done' || msg.reason === 'aborted') return
      const frame = session.latestFrame
      if (!frame) return

      // Recomputed from CURRENT store state rather than cached from run-start: any
      // profile or solver-setting edit aborts the run (see MosaicCanvas), so a genuine
      // 'done' can only fire when nothing has changed since the run began, and the
      // current state IS the state that produced this frame.
      const s = useStore.getState()
      const pairs = s.allPairs()
      const tiles = placeAnswers({ answers: s.answers, pairs, layout: s.layout })
      const grid = createGrid(s.layout.gridSize, s.layout.rimRadius)
      const fields = createFields(grid)
      buildFields(fields, tiles, {
        filterRadius: s.solver.filterRadius,
        volumeFraction: s.solver.volumeFraction,
        antagonisms: ANTAGONISMS,
      })

      setResult({
        conflicts: rankConflicts(tiles, ANTAGONISMS, grid, fields.provenance, frame.density, 4),
        bonds: rankBonds(tiles, grid, fields.provenance, fields.rho0, frame.density, 4),
      })
    })
  }, [])

  // A stale result from a previous profile is worse than no result: clear it the
  // moment the thing it describes changes.
  useEffect(() => {
    setResult(null)
  }, [answers, layout, solver.filterRadius, solver.volumeFraction])

  return (
    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          ...linkish,
          fontSize: 11,
          fontWeight: 700,
          color: 'var(--text)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
        aria-expanded={open}
      >
        {open ? '⌄' : '›'} Reinforced &amp; conflicting pairs
      </button>

      {open && (
        <div style={{ marginTop: 6, fontSize: 10 }}>
          {!result ? (
            <div style={{ color: 'var(--text-dim)', lineHeight: 1.45 }}>
              Run the mosaic to see which identities the solver eroded through conflict,
              and which lattice-neighbours it reinforced into a shared strut.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              <InterferenceGroup
                title="Most eroded by conflict"
                empty="No authored conflict was engaged by this profile's leans."
                entries={result.conflicts.map((c) => ({
                  a: c.a,
                  b: c.b,
                  fraction: c.loss / 2,
                  note: `${Math.round((1 - c.survivalA) * 100)}% / ${Math.round((1 - c.survivalB) * 100)}% eroded`,
                }))}
                theme={theme}
              />
              <InterferenceGroup
                title="Most reinforced by concordance"
                empty="No neighbouring tiles were bridged into shared structure."
                entries={result.bonds
                  .filter((b) => b.growth > 0.01)
                  .map((b) => ({
                    a: b.a,
                    b: b.b,
                    fraction: b.growth / (1 - FLOOR_APPROX),
                    note: `bridge density ${b.seedDensity.toFixed(2)} → ${b.finalDensity.toFixed(2)}`,
                  }))}
                theme={theme}
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The connectivity floor, duplicated as a display constant rather than imported from
 * layout/fields.ts. It only normalizes a bar width here -- if it drifts from the real
 * FIELD_CONSTANTS.RHO_FLOOR the bar is very slightly mis-scaled, never wrong in sign or
 * direction, which is a safe failure mode for a decorative width.
 */
const FLOOR_APPROX = 0.25

interface InterferenceRow {
  readonly a: { readonly activePole: string; readonly hue: readonly [number, number, number] }
  readonly b: { readonly activePole: string; readonly hue: readonly [number, number, number] }
  /** 0..1, drives the bar width. */
  readonly fraction: number
  readonly note: string
}

function InterferenceGroup({
  title,
  empty,
  entries,
  theme,
}: {
  title: string
  empty: string
  entries: readonly InterferenceRow[]
  theme: ReturnType<typeof useThemeColors>
}): JSX.Element {
  return (
    <div>
      <div style={{ color: 'var(--text-dim)', marginBottom: 5, fontWeight: 600 }}>{title}</div>
      {entries.length === 0 ? (
        <div style={{ color: 'var(--text-dim)', lineHeight: 1.4 }}>{empty}</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {entries.map((e, i) => (
            <div key={i}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 6,
                  marginBottom: 3,
                }}
              >
                <span style={{ color: hueToCss(e.a.hue, theme) }}>{e.a.activePole}</span>
                <span style={{ color: hueToCss(e.b.hue, theme) }}>{e.b.activePole}</span>
              </div>
              <div
                style={{
                  display: 'flex',
                  height: 5,
                  borderRadius: 3,
                  overflow: 'hidden',
                  background: 'var(--bg)',
                }}
              >
                <div
                  style={{
                    width: `${Math.max(4, Math.min(100, e.fraction * 100)) / 2}%`,
                    background: hueToCss(e.a.hue, theme),
                  }}
                />
                <div
                  style={{
                    width: `${Math.max(4, Math.min(100, e.fraction * 100)) / 2}%`,
                    background: hueToCss(e.b.hue, theme),
                  }}
                />
              </div>
              <div style={{ color: 'var(--text-dim)', marginTop: 2 }}>{e.note}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({
  label,
  desc,
  children,
}: {
  label: string
  /** Plain-English explanation of what the control does and when to touch it. */
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 3 }}>
      <span style={{ color: 'var(--text-dim)' }}>{label}</span>
      {children}
      {desc && (
        <span style={{ color: 'var(--text-dim)', lineHeight: 1.45, fontWeight: 400 }}>
          {desc}
        </span>
      )}
    </label>
  )
}

const btn: React.CSSProperties = {
  padding: '5px 9px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return {
    ...btn,
    minWidth: 84,
    fontWeight: 600,
    opacity: disabled ? 0.4 : 1,
    cursor: disabled ? 'default' : 'pointer',
  }
}

const linkish: React.CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  color: 'var(--text-dim)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 10,
  textAlign: 'left',
}
