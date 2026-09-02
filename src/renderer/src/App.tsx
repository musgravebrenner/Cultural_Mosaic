import LeftPanel from './components/LeftPanel'
import MosaicCanvas from './components/MosaicCanvas'
import { useStore } from './state/store'

export default function App(): JSX.Element {
  const render = useStore((s) => s.render)
  const setRender = useStore((s) => s.setRender)
  const layout = useStore((s) => s.layout)
  const setInvertAnchors = useStore((s) => s.setInvertAnchors)
  const title = useStore((s) => s.title)
  const loadSample = useStore((s) => s.loadSample)
  const clearProfile = useStore((s) => s.clearProfile)
  const answered = useStore((s) => s.answers.length)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          padding: '7px 12px',
          borderBottom: '1px solid var(--ink-border)',
          background: 'var(--ink-panel)',
          flex: '0 0 auto',
          fontSize: 12,
        }}
      >
        <strong style={{ fontWeight: 600 }}>Cultural Mosaic</strong>
        <span style={{ color: 'var(--ink-text-dim)' }}>{title}</span>
        <button onClick={loadSample} style={barBtn} title="Load a worked example profile">
          Sample
        </button>
        <button
          onClick={clearProfile}
          disabled={answered === 0}
          style={{ ...barBtn, opacity: answered === 0 ? 0.4 : 1 }}
          title="Remove every answer"
        >
          Clear
        </button>
        <span style={{ flex: 1 }} />

        <Toggle
          label="Scaffolding"
          on={render.showScaffolding}
          onChange={(v) => setRender({ showScaffolding: v })}
        />
        <Toggle
          label="Ghost"
          title="Render eroded material as a faint trace — the identities that did not become structure"
          on={render.showGhost}
          onChange={(v) => setRender({ showGhost: v })}
        />
        <Toggle
          label="Invert anchors"
          title="Chosen associations pin; inherited traits load. The layout encodes a contestable claim — this inverts it."
          on={layout.invertAnchors}
          onChange={setInvertAnchors}
        />
        <Segmented
          options={['mosaic', 'smooth'] as const}
          value={render.upscale}
          onChange={(v) => setRender({ upscale: v })}
        />
        <Segmented
          options={['ink', 'paper'] as const}
          value={render.theme}
          onChange={(v) => setRender({ theme: v })}
        />
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <LeftPanel />
        <div style={{ flex: 1, minWidth: 0 }}>
          <MosaicCanvas />
        </div>
      </div>
    </div>
  )
}

const barBtn: React.CSSProperties = {
  padding: '3px 10px',
  border: '1px solid var(--ink-border)',
  borderRadius: 4,
  background: 'var(--ink-bg)',
  color: 'var(--ink-text)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
}

function Toggle({
  label,
  on,
  onChange,
  title,
}: {
  label: string
  on: boolean
  onChange: (v: boolean) => void
  title?: string
}): JSX.Element {
  return (
    <label
      title={title}
      style={{ display: 'flex', gap: 5, alignItems: 'center', cursor: 'pointer' }}
    >
      <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ color: on ? 'var(--ink-text)' : 'var(--ink-text-dim)' }}>{label}</span>
    </label>
  )
}

function Segmented<T extends string>({
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
          key={o}
          onClick={() => onChange(o)}
          style={{
            padding: '3px 9px',
            border: 'none',
            background: value === o ? 'var(--ink-bg)' : 'transparent',
            color: value === o ? 'var(--ink-text)' : 'var(--ink-text-dim)',
            cursor: 'pointer',
            font: 'inherit',
            fontSize: 11,
          }}
        >
          {o}
        </button>
      ))}
    </div>
  )
}
