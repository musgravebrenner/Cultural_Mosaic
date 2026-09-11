import { useState } from 'react'
import { useStore } from '../state/store'
import { circularMean } from '../layout/polar'
import type { Cat3 } from '../domain/types'
import { CATEGORY_OF_FACET, FACET_LABEL } from '../domain/taxonomy'
import type { CategoryId, FacetId } from '../domain/taxonomy'
import { useThemeColors } from '../render/useThemeColors'


export default function CustomPairForm(): JSX.Element {
  const theme = useThemeColors()
  const CAT_CSS = theme.catCss
  const addCustomPair = useStore((s) => s.addCustomPair)
  const existing = useStore((s) => s.customPairs)

  const [open, setOpen] = useState(false)
  const [poleA, setPoleA] = useState('')
  const [poleB, setPoleB] = useState('')
  const [mix, setMix] = useState<Cat3>([1 / 3, 1 / 3, 1 / 3])
  const [immutability, setImmutability] = useState(0.5)
  const [facet, setFacet] = useState<FacetId | 'custom'>('custom')

  const a = poleA.trim()
  const b = poleB.trim()
  const errors: string[] = []
  if (a === '' || b === '') errors.push('Both poles are required.')
  if (a.length > 44 || b.length > 44) errors.push('Poles must be 44 characters or fewer.')
  if (a !== '' && a.toLowerCase() === b.toLowerCase()) errors.push('The two poles must differ.')
  if (mix[0] + mix[1] + mix[2] < 1e-6) errors.push('Pick at least one category.')

  const duplicate = existing.some(
    (p) => p.poleA.toLowerCase() === a.toLowerCase() && p.poleB.toLowerCase() === b.toLowerCase(),
  )

  const norm = normalize(mix)
  const { thetaDeg, purity, degenerate } = circularMean(norm)

  const reset = (): void => {
    setPoleA('')
    setPoleB('')
    setMix([1 / 3, 1 / 3, 1 / 3])
    setImmutability(0.5)
    setFacet('custom')
  }

  const submit = (): void => {
    if (errors.length > 0) return
    const category: CategoryId =
      facet !== 'custom' ? CATEGORY_OF_FACET[facet] : dominantCategory(norm)
    addCustomPair({ category, facet, poleA: a, poleB: b, mix: norm, immutability })
    reset()
    setOpen(false)
  }

  // Deliberately unprominent: a small text link, not a full-width button. Adding a
  // brand-new pair to a primary category is a power-user move -- possible, but the
  // panel should not be inviting it as loudly as answering what is already there.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 'none',
          padding: '4px 2px',
          color: 'var(--text-dim)',
          textDecoration: 'underline',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 10,
        }}
      >
        + add a custom question (advanced)
      </button>
    )
  }

  return (
    <div style={{ ...box, display: 'grid', gap: 8 }}>
      <Field label="Pole A">
        <input value={poleA} onChange={(e) => setPoleA(e.target.value)} style={input} maxLength={60} />
      </Field>
      <Field label="Pole B">
        <input value={poleB} onChange={(e) => setPoleB(e.target.value)} style={input} maxLength={60} />
      </Field>

      <Field label="Category mix">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <TernaryPicker value={norm} onChange={setMix} />
          <div style={{ display: 'grid', gap: 3, flex: 1 }}>
            {(['Demographic', 'Geographic', 'Associative'] as const).map((name, i) => (
              <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span
                  style={{ width: 7, height: 7, borderRadius: 7, background: CAT_CSS[i] }}
                />
                <span style={{ flex: 1, fontSize: 10 }}>{name}</span>
                <input
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={Number(norm[i]!.toFixed(2))}
                  onChange={(e) => {
                    const next: [number, number, number] = [norm[0], norm[1], norm[2]]
                    next[i] = Math.max(0, Number(e.target.value))
                    setMix(next as Cat3)
                  }}
                  style={{ ...input, width: 54, padding: '2px 4px' }}
                />
              </label>
            ))}
          </div>
        </div>
      </Field>

      <Field label={`Fixedness ${immutability.toFixed(2)}`}>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={immutability}
          onChange={(e) => setImmutability(Number(e.target.value))}
          style={{ width: '100%' }}
        />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: 'var(--text-dim)' }}>
          <span>chosen daily</span>
          <span>long-term</span>
          <span>unchangeable</span>
        </div>
      </Field>

      <Field label="Table 1 tile (optional)">
        <select
          value={facet}
          onChange={(e) => setFacet(e.target.value as FacetId | 'custom')}
          style={input}
        >
          <option value="custom">Custom</option>
          {(Object.keys(FACET_LABEL) as FacetId[]).map((f) => (
            <option key={f} value={f}>
              {FACET_LABEL[f]}
            </option>
          ))}
        </select>
      </Field>

      {/* Live preview: shows WHERE the pair will land before committing, which turns an
          abstract form into a direct-manipulation one. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 10,
          color: 'var(--text-dim)',
        }}
      >
        <span
          style={{
            width: 16,
            height: 16,
            borderRadius: 3,
            background: swatch(norm, CAT_CSS),
            border: '1px solid var(--border)',
          }}
        />
        {degenerate ? (
          <span>Balanced across all three — lands near the hub as a concordant core.</span>
        ) : (
          <span>
            lands at {thetaDeg.toFixed(0)}° · purity {purity.toFixed(2)}
            {purity > 0.45 && purity < 0.55 ? ' · on a category seam' : ''}
          </span>
        )}
      </div>

      {duplicate && (
        <div style={{ fontSize: 10, color: 'var(--warn)' }}>
          You already have a pair with these poles. Adding it again is allowed.
        </div>
      )}
      {errors.map((e) => (
        <div key={e} style={{ fontSize: 10, color: 'var(--danger)' }}>
          {e}
        </div>
      ))}

      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button
          onClick={() => {
            reset()
            setOpen(false)
          }}
          style={smallBtn}
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={errors.length > 0}
          style={{ ...smallBtn, opacity: errors.length > 0 ? 0.4 : 1, fontWeight: 600 }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

/**
 * A barycentric triangle rather than three independent sliders.
 *
 * Three sliders let you specify states that do not mean anything (all zero) and hide
 * the fact that the values are a normalized mix at all. A triangle SHOWS that mixing
 * means moving toward an edge -- which is also exactly what the layout does with the
 * resulting hue, since a two-way blend lands on the seam between its parents.
 */
function TernaryPicker({
  value,
  onChange,
}: {
  value: Cat3
  onChange: (c: Cat3) => void
}): JSX.Element {
  const CAT_CSS = useThemeColors().catCss
  const size = 88
  const h = (size * Math.sqrt(3)) / 2
  // Vertices: Demographic top, Geographic bottom-left, Associative bottom-right.
  const V: [number, number][] = [
    [size / 2, 0],
    [0, h],
    [size, h],
  ]
  const px = value[0] * V[0]![0] + value[1] * V[1]![0] + value[2] * V[2]![0]
  const py = value[0] * V[0]![1] + value[1] * V[1]![1] + value[2] * V[2]![1]

  const pick = (e: React.MouseEvent<SVGSVGElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * size
    const y = ((e.clientY - r.top) / r.height) * h
    // Barycentric coordinates, clamped back onto the simplex.
    const d = 1
    const l0 = y / h
    const l1 = (V[2]![0] - x) / size - l0 / 2
    const l2 = d - l0 - l1
    onChange(normalize([1 - l0, Math.max(0, l1), Math.max(0, l2)] as Cat3))
  }

  return (
    <svg
      width={size}
      height={h}
      viewBox={`0 0 ${size} ${h}`}
      onMouseDown={pick}
      style={{ cursor: 'crosshair', flex: '0 0 auto' }}
      role="img"
      aria-label="Category mix picker"
    >
      <defs>
        <linearGradient id="tri" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor={CAT_CSS[1]} />
          <stop offset="50%" stopColor={CAT_CSS[0]} />
          <stop offset="100%" stopColor={CAT_CSS[2]} />
        </linearGradient>
      </defs>
      <polygon
        points={V.map(([x, y]) => `${x},${y}`).join(' ')}
        fill="url(#tri)"
        opacity={0.35}
        stroke="var(--border)"
      />
      <circle cx={px} cy={py} r={4.5} fill="var(--text)" stroke="var(--bg)" strokeWidth={1.5} />
    </svg>
  )
}

function normalize(c: Cat3): Cat3 {
  const r = Math.max(0, c[0])
  const g = Math.max(0, c[1])
  const b = Math.max(0, c[2])
  const s = r + g + b
  return s < 1e-9 ? [1 / 3, 1 / 3, 1 / 3] : [r / s, g / s, b / s]
}

function dominantCategory(c: Cat3): CategoryId {
  const max = Math.max(c[0], c[1], c[2])
  if (max === c[0]) return 'demographic'
  if (max === c[1]) return 'geographic'
  return 'associative'
}

/**
 * The preview swatch, mixed from the ACTIVE theme's inks.
 *
 * Takes the palette as bytes rather than as CSS strings because it computes a weighted
 * average, and mixing has to happen in numbers. Previously it carried its own hardcoded
 * copy of the ink palette, so on paper the preview would have shown a colour the mosaic
 * never renders.
 */
function swatch(c: Cat3, catCss: readonly string[]): string {
  const cols = catCss.map((hex) => {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
  })
  const m = (i: number): number =>
    Math.round(c[0] * cols[0]![i]! + c[1] * cols[1]![i]! + c[2] * cols[2]![i]!)
  return `rgb(${m(0)}, ${m(1)}, ${m(2)})`
}

const box: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius)',
  padding: 10,
  background: 'var(--bg)',
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 11,
  textAlign: 'left',
}

const input: React.CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  background: 'var(--panel)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text)',
  font: 'inherit',
  fontSize: 11,
}

const smallBtn: React.CSSProperties = {
  padding: '4px 12px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--panel)',
  color: 'var(--text)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 11,
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label style={{ display: 'grid', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{label}</span>
      {children}
    </label>
  )
}
