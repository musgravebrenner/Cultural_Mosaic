import { useState } from 'react'
import { useStore } from '../state/store'
import { parseProfile, serializeProfile } from '../domain/validate'
import { EXPORT_SIZES } from '../render/export-png'

/**
 * Open / Save / Export, plus the view toggles.
 *
 * The file work goes through the four-channel preload bridge: main receives a string
 * (or bytes) to write and returns a string it read, and never receives a path from the
 * renderer. The user picks the path in the OS dialog, so there is no path surface to
 * validate.
 */
export default function Toolbar(): JSX.Element {
  const render = useStore((s) => s.render)
  const setRender = useStore((s) => s.setRender)
  const layout = useStore((s) => s.layout)
  const setInvertAnchors = useStore((s) => s.setInvertAnchors)
  const title = useStore((s) => s.title)
  const dirty = useStore((s) => s.dirty)
  const answers = useStore((s) => s.answers)
  const loadSample = useStore((s) => s.loadSample)
  const clearProfile = useStore((s) => s.clearProfile)

  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string } | null>(null)

  const say = (tone: 'ok' | 'warn' | 'bad', text: string): void => {
    setNotice({ tone, text })
    window.setTimeout(() => setNotice(null), 6000)
  }

  const onSave = async (): Promise<void> => {
    setBusy('save')
    try {
      const version = await window.mosaic.getAppVersion()
      const profile = useStore.getState().toProfile(version)
      const name = `${slug(profile.title)}.mosaic.json`
      const res = await window.mosaic.saveProfile(serializeProfile(profile), name)
      if (res.error) say('bad', res.error)
      else if (!res.canceled) {
        useStore.setState({ dirty: false })
        say('ok', 'Profile saved.')
      }
    } finally {
      setBusy(null)
    }
  }

  const onOpen = async (): Promise<void> => {
    setBusy('open')
    try {
      const res = await window.mosaic.openProfile()
      if (res.canceled) return
      if (res.error || res.contents === undefined) {
        say('bad', res.error ?? 'Could not read that file.')
        return
      }
      let raw: unknown
      try {
        raw = JSON.parse(res.contents)
      } catch {
        say('bad', 'That file is not valid JSON.')
        return
      }
      const parsed = parseProfile(raw)
      if (!parsed.ok) {
        say('bad', parsed.errors.join(' '))
        return
      }
      useStore.getState().loadProfile(parsed.profile)
      window.dispatchEvent(new CustomEvent('mosaic:reset'))
      say(
        parsed.warnings.length > 0 ? 'warn' : 'ok',
        parsed.warnings.length > 0
          ? `Opened with ${parsed.warnings.length} note(s): ${parsed.warnings[0]!}`
          : 'Profile opened.',
      )
    } finally {
      setBusy(null)
    }
  }

  const onExport = (size: number): void => {
    setBusy('export')
    // The canvas owns the frame and the derived tiles, so it does the rendering.
    window.dispatchEvent(
      new CustomEvent('mosaic:export', {
        detail: {
          size,
          done: (err?: string) => {
            setBusy(null)
            if (err) say('bad', err)
            else say('ok', `Exported at ${size}px.`)
          },
        },
      }),
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '7px 12px',
        borderBottom: '1px solid var(--ink-border)',
        background: 'var(--ink-panel)',
        flex: '0 0 auto',
        fontSize: 12,
      }}
    >
      <strong style={{ fontWeight: 600 }}>Cultural Mosaic</strong>
      <span style={{ color: 'var(--ink-text-dim)' }}>
        {title}
        {dirty ? ' *' : ''}
      </span>

      <button onClick={() => void onOpen()} style={barBtn} disabled={busy !== null}>
        Open
      </button>
      <button
        onClick={() => void onSave()}
        style={barBtn}
        disabled={busy !== null || answers.length === 0}
      >
        Save
      </button>
      <ExportMenu onPick={onExport} disabled={busy !== null || answers.length === 0} />
      <button onClick={loadSample} style={barBtn} title="Load a worked example profile">
        Sample
      </button>
      <button
        onClick={clearProfile}
        disabled={answers.length === 0}
        style={{ ...barBtn, opacity: answers.length === 0 ? 0.4 : 1 }}
      >
        Clear
      </button>

      {notice && (
        <span
          style={{
            fontSize: 11,
            color: notice.tone === 'bad' ? '#e5484d' : notice.tone === 'warn' ? '#d9a441' : '#46a758',
            maxWidth: 380,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={notice.text}
        >
          {notice.text}
        </span>
      )}

      <span style={{ flex: 1 }} />

      <Toggle
        label="Scaffolding"
        on={render.showScaffolding}
        onChange={(v) => setRender({ showScaffolding: v })}
      />
      <Toggle
        label="Ghost"
        title="Draw eroded material as a faint trace: the identities that did not become structure"
        on={render.showGhost}
        onChange={(v) => setRender({ showGhost: v })}
      />
      <Toggle
        label="Invert anchors"
        title="Chosen associations pin, inherited traits load. The layout encodes a contestable claim; this inverts it."
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
  )
}

function ExportMenu({
  onPick,
  disabled,
}: {
  onPick: (size: number) => void
  disabled: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span style={{ position: 'relative' }}>
      <button onClick={() => setOpen(!open)} style={barBtn} disabled={disabled}>
        Export PNG…
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '110%',
            left: 0,
            zIndex: 10,
            background: 'var(--ink-panel)',
            border: '1px solid var(--ink-border)',
            borderRadius: 4,
            padding: 4,
            display: 'grid',
            gap: 2,
            minWidth: 110,
          }}
        >
          {EXPORT_SIZES.map((s) => (
            <button
              key={s}
              onClick={() => {
                setOpen(false)
                onPick(s)
              }}
              style={{ ...barBtn, border: 'none', textAlign: 'left' }}
            >
              {s} px
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return out === '' ? 'mosaic' : out
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
