import { useEffect, useState } from 'react'
import { getSolverSession } from './solver/SolverSession'

interface Diag {
  contextIsolated: boolean
  workerOk: boolean
  zeroCopy: boolean
  sumOk: boolean
  version: string
  error?: string
}

export default function App(): JSX.Element {
  const [diag, setDiag] = useState<Diag | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next: Diag = {
        contextIsolated: typeof window.mosaic?.getAppVersion === 'function',
        workerOk: false,
        zeroCopy: false,
        sumOk: false,
        version: '?',
      }
      try {
        next.version = await window.mosaic.getAppVersion()
        const r = await getSolverSession().smokeTest()
        next.workerOk = true
        next.zeroCopy = r.transferred
        next.sumOk = Math.abs(r.sum - r.expected) < 1e-3
      } catch (err) {
        next.error = (err as Error).message
      }
      const pass =
        next.contextIsolated && next.workerOk && next.zeroCopy && next.sumOk && !next.error
      console.log(`MOSAIC_DIAG ${JSON.stringify({ ...next, pass })}`)
      if (!cancelled) setDiag(next)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const row = (label: string, ok: boolean, detail?: string): JSX.Element => (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
      <span style={{ color: ok ? 'var(--cat-geographic)' : 'var(--cat-demographic)', width: 14 }}>
        {ok ? '\u2713' : '\u2717'}
      </span>
      <span style={{ flex: 1 }}>{label}</span>
      {detail ? <code style={{ color: 'var(--ink-text-dim)' }}>{detail}</code> : null}
    </div>
  )

  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
      <div style={{ width: 460 }}>
        <h1 style={{ margin: '0 0 4px', fontSize: 22, fontWeight: 500 }}>Cultural Mosaic</h1>
        <p style={{ margin: '0 0 20px', color: 'var(--ink-text-dim)' }}>
          Step 1 &mdash; worker path verification
        </p>
        <div
          style={{
            background: 'var(--ink-panel)',
            border: '1px solid var(--ink-border)',
            borderRadius: 'var(--radius)',
            padding: 16,
            display: 'grid',
            gap: 8,
          }}
        >
          {diag === null ? (
            <span style={{ color: 'var(--ink-text-dim)' }}>running&hellip;</span>
          ) : (
            <>
              {row('contextBridge reachable', diag.contextIsolated, `v${diag.version}`)}
              {row('module worker loaded', diag.workerOk)}
              {row('transfer was zero-copy', diag.zeroCopy, 'probe.byteLength === 0')}
              {row('payload arrived intact', diag.sumOk)}
              {diag.error ? (
                <div style={{ color: 'var(--cat-demographic)', marginTop: 6 }}>{diag.error}</div>
              ) : null}
            </>
          )}
        </div>
        <p style={{ color: 'var(--ink-text-dim)', marginTop: 14, fontSize: 12 }}>
          All four must pass in a <strong>packaged</strong> build, not just <code>npm run dev</code>.
        </p>
      </div>
    </div>
  )
}
