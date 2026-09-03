import { useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import { FACET_PREAMBLE, QUIZ_LENGTH, QUIZ_ORDER, isCentralityQuestion, pairAt } from '../domain/quiz'
import { CATEGORY_LABEL, FACET_LABEL } from '../domain/taxonomy'
import type { CategoryId } from '../domain/taxonomy'
import { LEAN_CENTER, LEAN_NOTCHES, STRENGTH_LABELS } from '../domain/types'
import type { LeanIndex, StrengthLevel } from '../domain/types'

const CAT_CSS: Record<CategoryId, string> = {
  demographic: '#e5484d',
  geographic: '#46a758',
  associative: '#5b6ee8',
}

/**
 * One question at a time through the whole library.
 *
 * The two controls stay separated here exactly as they are in the studio: WHICH pole,
 * and HOW MUCH it matters. Answering the first without the second would make every
 * balanced answer weightless, which is the opposite of what the source theory claims
 * about integrated identities.
 */
export default function Quiz(): JSX.Element {
  const index = useStore((s) => s.quizIndex)
  const setQuizIndex = useStore((s) => s.setQuizIndex)
  const setMode = useStore((s) => s.setMode)
  const answers = useStore((s) => s.answers)
  const answerQuiz = useStore((s) => s.answerQuiz)
  const skipQuiz = useStore((s) => s.skipQuiz)

  const pair = pairAt(index)
  const answeredIds = useMemo(() => new Set(answers.map((a) => a.pairId)), [answers])
  const current = pair ? answers.find((a) => a.pairId === pair.id) : undefined

  const lean = current?.leanIndex ?? LEAN_CENTER
  const strength: StrengthLevel = current?.strength ?? 2

  const advance = useCallback(() => {
    if (index >= QUIZ_LENGTH - 1) setMode('studio')
    else setQuizIndex(index + 1)
  }, [index, setMode, setQuizIndex])

  const commit = useCallback(
    (l: LeanIndex, s: StrengthLevel) => {
      if (pair) answerQuiz(pair.id, l, s)
    },
    [pair, answerQuiz],
  )

  // Keyboard: 1-7 sets the lean, Q/W/E/R the strength, arrows navigate, Enter advances,
  // S skips, Escape leaves for the studio. A 79-question instrument that requires the
  // mouse for every answer is a chore.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const k = e.key.toLowerCase()
      if (k >= '1' && k <= '7') {
        commit((Number(k) - 1) as LeanIndex, strength)
        e.preventDefault()
      } else if (k === 'q' || k === 'w' || k === 'e' || k === 'r') {
        const map: Record<string, StrengthLevel> = { q: 0, w: 1, e: 2, r: 3 }
        commit(lean, map[k]!)
        e.preventDefault()
      } else if (k === 'arrowright' || k === 'enter') {
        advance()
        e.preventDefault()
      } else if (k === 'arrowleft') {
        setQuizIndex(index - 1)
        e.preventDefault()
      } else if (k === 's') {
        if (pair) skipQuiz(pair.id)
        advance()
        e.preventDefault()
      } else if (k === 'escape') {
        setMode('studio')
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, advance, lean, strength, index, pair, setQuizIndex, setMode, skipQuiz])

  if (!pair) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <button onClick={() => setMode('studio')} style={navBtn}>
          Go to the graph
        </button>
      </div>
    )
  }

  const preamble = FACET_PREAMBLE[String(pair.facet)]
  const leanValue = LEAN_NOTCHES[lean] ?? 0
  const optional = isCentralityQuestion(pair.id)

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        overflowY: 'auto',
      }}
    >
      {/* Progress. Segments rather than a bar, so the taxonomy is visible in the shape
          of the run: you can see the three category blocks going by. */}
      <div style={{ width: '100%', padding: '10px 16px 0', maxWidth: 900 }}>
        <div style={{ display: 'flex', gap: 1, height: 4 }}>
          {QUIZ_ORDER.map((id, i) => {
            const p = pairAt(i)
            const done = answeredIds.has(id)
            return (
              <span
                key={id}
                title={`${i + 1}. ${p?.poleA ?? ''} / ${p?.poleB ?? ''}`}
                style={{
                  flex: 1,
                  borderRadius: 1,
                  background:
                    i === index
                      ? 'var(--ink-text)'
                      : done
                        ? CAT_CSS[p?.category ?? 'associative']
                        : 'var(--ink-border)',
                  opacity: i === index ? 1 : done ? 0.85 : 0.55,
                }}
              />
            )
          })}
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 7,
            fontSize: 11,
            color: 'var(--ink-text-dim)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{ width: 8, height: 8, borderRadius: 8, background: CAT_CSS[pair.category] }}
            />
            {CATEGORY_LABEL[pair.category]} ·{' '}
            {pair.facet === 'custom' ? 'Custom' : FACET_LABEL[pair.facet]}
          </span>
          <span>
            {index + 1} / {QUIZ_LENGTH}
          </span>
        </div>
      </div>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          width: '100%',
          maxWidth: 620,
          padding: '16px',
          minHeight: 0,
          margin: '0 auto',
        }}
      >
        {preamble && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--ink-text-dim)',
              lineHeight: 1.5,
              marginBottom: 18,
              paddingLeft: 11,
              borderLeft: `2px solid ${CAT_CSS[pair.category]}`,
            }}
          >
            {preamble}
          </div>
        )}

        <div style={{ display: 'grid', gap: 10, marginBottom: 22 }}>
          <Pole
            text={pair.poleA}
            active={leanValue < -0.01}
            strong={leanValue < -0.5}
            onClick={() => commit(0, strength)}
          />
          <div style={{ textAlign: 'center', fontSize: 10, color: 'var(--ink-text-dim)' }}>
            or
          </div>
          <Pole
            text={pair.poleB}
            active={leanValue > 0.01}
            strong={leanValue > 0.5}
            onClick={() => commit(6, strength)}
          />
        </div>

        {/*
          Seven notches, drawn as a scale on a track rather than as seven buttons.
          Empty bordered rectangles read as "nothing here yet"; dots on a line read as a
          position you have not chosen yet, which is what this actually is.

          Centre is a click, not a pixel hunt. That is the only reason "equally both"
          ever gets chosen, and therefore the only reason the balanced morphology ever
          appears in the artwork at all.
        */}
        <div style={{ position: 'relative', height: 40, marginBottom: 4 }}>
          <div
            style={{
              position: 'absolute',
              left: 10,
              right: 10,
              top: 19,
              height: 2,
              background: 'var(--ink-border)',
              borderRadius: 2,
            }}
          />
          <div style={{ position: 'relative', display: 'flex', height: '100%' }}>
            {[0, 1, 2, 3, 4, 5, 6].map((i) => {
              const selected = current !== undefined && i === lean
              const isCentre = i === 3
              const d = selected ? 20 : isCentre ? 14 : 10
              return (
                <button
                  key={i}
                  onClick={() => commit(i as LeanIndex, strength)}
                  aria-label={`position ${i + 1} of 7`}
                  title={`${i + 1}`}
                  style={{
                    flex: 1,
                    display: 'grid',
                    placeItems: 'center',
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    style={{
                      width: d,
                      height: d,
                      borderRadius: d,
                      background: selected ? CAT_CSS[pair.category] : 'var(--ink-bg)',
                      border: `2px solid ${
                        selected
                          ? CAT_CSS[pair.category]
                          : isCentre
                            ? 'var(--ink-text-dim)'
                            : 'var(--ink-border)'
                      }`,
                      boxShadow: selected ? '0 0 0 4px rgba(255,255,255,0.06)' : 'none',
                      transition: 'width 80ms, height 80ms',
                    }}
                  />
                </button>
              )
            })}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            color: 'var(--ink-text-dim)',
            marginBottom: 20,
          }}
        >
          <span>strongly the first</span>
          <span>equally both</span>
          <span>strongly the second</span>
        </div>

        <div style={{ fontSize: 11, color: 'var(--ink-text-dim)', marginBottom: 6 }}>
          How much does this matter to you?
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {STRENGTH_LABELS.map((label, i) => {
            const selected = current !== undefined && strength === i
            return (
              <button
                key={label}
                onClick={() => commit(lean, i as StrengthLevel)}
                style={{
                  flex: 1,
                  padding: '7px 4px',
                  border: `1px solid ${selected ? 'var(--ink-text-dim)' : 'var(--ink-border)'}`,
                  borderRadius: 4,
                  background: selected ? 'var(--ink-panel)' : 'transparent',
                  color: selected ? 'var(--ink-text)' : 'var(--ink-text-dim)',
                  fontWeight: selected ? 600 : 400,
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 11,
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div style={{ fontSize: 10, color: 'var(--ink-text-dim)', marginTop: 6, lineHeight: 1.5 }}>
          Dormant keeps the pair on file but contributes nothing. Answering{' '}
          <em>equally both</em> at full strength is not the same thing — it deposits the
          most diffuse strong material in the model.
        </div>

        {optional && (
          <div style={{ fontSize: 10, color: '#d9a441', marginTop: 14, lineHeight: 1.5 }}>
            This one is personal and entirely optional. Skipping it costs the mosaic one
            rim anchor and nothing else.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 26 }}>
        <button onClick={() => setQuizIndex(index - 1)} disabled={index === 0} style={navBtn}>
          ← Back
        </button>
        <button
          onClick={() => {
            skipQuiz(pair.id)
            advance()
          }}
          style={navBtn}
        >
          Skip
        </button>
        <span style={{ flex: 1 }} />
        <button onClick={() => setMode('studio')} style={navBtn}>
          Go to the graph
        </button>
        <button onClick={advance} style={{ ...navBtn, fontWeight: 600, minWidth: 96 }}>
          {index >= QUIZ_LENGTH - 1 ? 'Finish →' : 'Next →'}
        </button>
      </div>

        <div style={{ fontSize: 9, color: 'var(--ink-text-dim)', marginTop: 12, textAlign: 'center' }}>
        keys: 1–7 lean · Q W E R strength · S skip · ← → move · Enter next · Esc to graph
      </div>
      </div>

    </div>
  )
}

function Pole({
  text,
  active,
  strong,
  onClick,
}: {
  text: string
  active: boolean
  strong: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '15px 18px',
        border: `1px solid ${active ? 'var(--ink-text-dim)' : 'var(--ink-border)'}`,
        borderRadius: 'var(--radius)',
        background: active ? 'var(--ink-panel)' : 'transparent',
        color: 'var(--ink-text)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 16,
        lineHeight: 1.35,
        textAlign: 'center',
        fontWeight: strong ? 600 : 400,
        opacity: active ? 1 : 0.82,
      }}
    >
      {text}
    </button>
  )
}

const navBtn: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--ink-border)',
  borderRadius: 4,
  background: 'var(--ink-bg)',
  color: 'var(--ink-text)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
}
