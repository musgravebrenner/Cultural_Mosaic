import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { getSolverSession } from '../solver/SolverSession'
import type { FrameMetrics } from '../solver/protocol'
import type { GridSize } from '../domain/types'

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
  const layout = useStore((s) => s.layout)
  const setGridSize = useStore((s) => s.setGridSize)
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
        borderTop: '1px solid var(--ink-border)',
        padding: '8px 10px',
        background: 'var(--ink-panel)',
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
        <span style={{ fontSize: 10, color: 'var(--ink-text-dim)', fontVariantNumeric: 'tabular-nums' }}>
          {progress
            ? `${progress.iteration}/${solver.iterations} · vol ${progress.volume.toFixed(2)} · C ${progress.compliance.toPrecision(3)}`
            : disabled
              ? 'add some pairs first'
              : 'ready'}
        </span>
      </div>

      {progress && (progress.islands > 0 || progress.unsupportedLoads > 0 || !progress.cgConverged) && (
        <div style={{ marginTop: 5, fontSize: 10, color: '#d9a441', lineHeight: 1.4 }}>
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

      <button
        onClick={() => setOpen(!open)}
        style={{ ...linkish, marginTop: 6 }}
        aria-expanded={open}
      >
        {open ? '⌄' : '›'} Solver
      </button>

      {open && (
        <div style={{ display: 'grid', gap: 7, marginTop: 6, fontSize: 10 }}>
          <Row label="Mode">
            <Seg
              options={['simp', 'beso'] as const}
              value={solver.mode}
              onChange={(mode) => setSolver({ mode })}
            />
          </Row>
          <Row label="Resolution">
            <Seg
              options={[64, 96, 128] as const}
              value={layout.gridSize}
              onChange={(n) => setGridSize(n as GridSize)}
            />
          </Row>
          <Row label={`Iterations ${solver.iterations}`}>
            <input
              type="range"
              min={20}
              max={300}
              step={10}
              value={solver.iterations}
              onChange={(e) => setSolver({ iterations: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </Row>
          <Row
            label={
              solver.volumeFraction === 'derived'
                ? `Volume derived${progress ? ` (${progress.volume.toFixed(2)})` : ''}`
                : `Volume ${solver.volumeFraction.toFixed(2)}`
            }
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
          <Row label={`Penalty p ${solver.penalty.toFixed(1)}`}>
            <input
              type="range"
              min={1}
              max={5}
              step={0.1}
              value={solver.penalty}
              onChange={(e) => setSolver({ penalty: Number(e.target.value) })}
              style={{ width: '100%' }}
            />
          </Row>
          <Row label={`Filter r ${solver.filterRadius.toFixed(1)}`}>
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
          <div style={{ color: 'var(--ink-text-dim)', lineHeight: 1.45 }}>
            Volume is derived from how strongly you answered: decisive identities give a
            dense, load-bearing mosaic; tentative ones give a thin, filigree one.
          </div>
        </div>
      )}
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 3 }}>
      <span style={{ color: 'var(--ink-text-dim)' }}>{label}</span>
      {children}
    </label>
  )
}

function Seg<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: readonly T[]
  value: T
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div style={{ display: 'flex', border: '1px solid var(--ink-border)', borderRadius: 4 }}>
      {options.map((o) => (
        <button
          key={String(o)}
          onClick={() => onChange(o)}
          style={{
            flex: 1,
            padding: '3px 0',
            border: 'none',
            background: value === o ? 'var(--ink-bg)' : 'transparent',
            color: value === o ? 'var(--ink-text)' : 'var(--ink-text-dim)',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 10,
          }}
        >
          {String(o).toUpperCase()}
        </button>
      ))}
    </div>
  )
}

const btn: React.CSSProperties = {
  padding: '5px 9px',
  border: '1px solid var(--ink-border)',
  borderRadius: 4,
  background: 'var(--ink-bg)',
  color: 'var(--ink-text)',
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
  color: 'var(--ink-text-dim)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 10,
  textAlign: 'left',
}
