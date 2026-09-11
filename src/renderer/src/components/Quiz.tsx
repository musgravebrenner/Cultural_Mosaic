import { useCallback, useEffect, useMemo } from 'react'
import { useStore } from '../state/store'
import {
  ANCHOR_LENGTH,
  ANCHOR_ORDER,
  FACET_PREAMBLE,
  QUIZ_CHOICES,
  QUIZ_LENGTH,
  QUIZ_ORDER,
  anchorAt,
  choiceIndexOf,
  pairAt,
} from '../domain/quiz'
import { CATEGORY_LABEL, FACET_LABEL } from '../domain/taxonomy'
import { categoryCss, useThemeColors } from '../render/useThemeColors'
import { LEAN_CENTER, LEAN_NOTCHES, STRENGTH_LABELS } from '../domain/types'
import type { AnchorAnswer, AnchorPair, LeanIndex, TileAnswer, WordPair } from '../domain/types'

const TOTAL_STEPS = QUIZ_LENGTH + ANCHOR_LENGTH

/**
 * One question at a time, in two phases.
 *
 * Phase one walks the 21 regular orientation questions -- every one mandatory, since
 * the scale itself has an honest "none of this" position (dead centre, Dormant) for
 * anyone it genuinely doesn't apply to. Phase two walks the anchor questions -- hard
 * facts, each skippable, because a fact can genuinely not exist yet for a given person
 * in a way an orientation never quite can.
 */
export default function Quiz(): JSX.Element {
  const index = useStore((s) => s.quizIndex)
  const setQuizIndex = useStore((s) => s.setQuizIndex)
  const setMode = useStore((s) => s.setMode)
  const answers = useStore((s) => s.answers)
  const anchorAnswers = useStore((s) => s.anchorAnswers)
  const answerQuiz = useStore((s) => s.answerQuiz)
  const answerAnchor = useStore((s) => s.answerAnchor)
  const skipAnchor = useStore((s) => s.skipAnchor)

  const CAT_CSS = categoryCss(useThemeColors())

  const isAnchorPhase = index >= QUIZ_LENGTH
  const pair = isAnchorPhase ? undefined : pairAt(index)
  const anchor = isAnchorPhase ? anchorAt(index - QUIZ_LENGTH) : undefined

  const answeredIds = useMemo(() => new Set(answers.map((a) => a.pairId)), [answers])
  const anchoredIds = useMemo(() => new Set(anchorAnswers.map((a) => a.anchorId)), [anchorAnswers])

  const current = pair ? answers.find((a) => a.pairId === pair.id) : undefined
  const currentAnchor = anchor ? anchorAnswers.find((a) => a.anchorId === anchor.id) : undefined

  const lean = current?.leanIndex ?? LEAN_CENTER
  // -1 when the answer was made in the studio with a lean/strength pair this scale
  // cannot express -- no longer reachable now that strength is always derived from
  // lean, but choiceIndexOf stays a plain lookup rather than assuming that.
  const choiceIndex = current ? choiceIndexOf(current.leanIndex, current.strength) : -1

  const advance = useCallback(() => {
    if (index >= TOTAL_STEPS - 1) setMode('studio')
    else setQuizIndex(index + 1)
  }, [index, setMode, setQuizIndex])

  const commit = useCallback(
    (l: LeanIndex) => {
      if (pair) answerQuiz(pair.id, l)
    },
    [pair, answerQuiz],
  )

  // Keyboard: 1-7 picks a regular position and moves on (regular phase only), arrows
  // navigate, Enter advances, S skips an anchor (anchor phase only), Escape leaves for
  // the studio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      const k = e.key.toLowerCase()
      if (!isAnchorPhase && k >= '1' && k <= '7') {
        const c = QUIZ_CHOICES[Number(k) - 1]
        if (c) {
          commit(c.leanIndex)
          advance()
        }
        e.preventDefault()
      } else if (k === 'arrowright' || k === 'enter') {
        advance()
        e.preventDefault()
      } else if (k === 'arrowleft') {
        setQuizIndex(index - 1)
        e.preventDefault()
      } else if (isAnchorPhase && k === 's') {
        if (anchor) skipAnchor(anchor.id)
        advance()
        e.preventDefault()
      } else if (k === 'escape') {
        setMode('studio')
        e.preventDefault()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commit, advance, index, anchor, isAnchorPhase, setQuizIndex, setMode, skipAnchor])

  if (!pair && !anchor) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%' }}>
        <button onClick={() => setMode('studio')} style={navBtn}>
          Go to the graph
        </button>
      </div>
    )
  }

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
          of the run: the three mandatory category blocks, then a visually quieter tail
          of optional anchors. */}
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
                      ? 'var(--text)'
                      : done
                        ? CAT_CSS[p?.category ?? 'associative']
                        : 'var(--border)',
                  opacity: i === index ? 1 : done ? 0.85 : 0.55,
                }}
              />
            )
          })}
          <span style={{ width: 6 }} />
          {ANCHOR_ORDER.map((id, i) => {
            const globalIndex = QUIZ_LENGTH + i
            const a = anchorAt(i)
            const done = anchoredIds.has(id)
            return (
              <span
                key={id}
                title={`Anchor: ${a?.prompt ?? ''} (optional)`}
                style={{
                  flex: 1,
                  borderRadius: 1,
                  background:
                    globalIndex === index
                      ? 'var(--text)'
                      : done
                        ? CAT_CSS[a?.category ?? 'associative']
                        : 'var(--border)',
                  opacity: globalIndex === index ? 1 : done ? 0.7 : 0.35,
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
            color: 'var(--text-dim)',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 8,
                background: CAT_CSS[(pair ?? anchor)!.category],
              }}
            />
            {CATEGORY_LABEL[(pair ?? anchor)!.category]} ·{' '}
            {pair
              ? pair.facet === 'custom'
                ? 'Custom'
                : FACET_LABEL[pair.facet]
              : FACET_LABEL[anchor!.facet]}
            {isAnchorPhase ? ' · optional' : ''}
          </span>
          <span>
            {isAnchorPhase
              ? `anchor ${index - QUIZ_LENGTH + 1} / ${ANCHOR_LENGTH}`
              : `${index + 1} / ${QUIZ_LENGTH}`}
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
        {pair ? (
          <RegularQuestion
            pair={pair}
            current={current}
            choiceIndex={choiceIndex}
            lean={lean}
            categoryColor={CAT_CSS[pair.category]}
            onCommit={(l) => {
              commit(l)
              advance()
            }}
          />
        ) : (
          <AnchorQuestion
            anchor={anchor!}
            current={currentAnchor}
            categoryColor={CAT_CSS[anchor!.category]}
            onPick={(optionId) => {
              answerAnchor(anchor!.id, optionId)
              advance()
            }}
            onSkip={() => {
              skipAnchor(anchor!.id)
              advance()
            }}
          />
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 26 }}>
          <button onClick={() => setQuizIndex(index - 1)} disabled={index === 0} style={navBtn}>
            ← Back
          </button>
          <span style={{ flex: 1 }} />
          <button onClick={() => setMode('studio')} style={navBtn}>
            Go to the graph
          </button>
          <button onClick={advance} style={{ ...navBtn, fontWeight: 600, minWidth: 96 }}>
            {index >= TOTAL_STEPS - 1 ? 'Finish →' : 'Next →'}
          </button>
        </div>

        <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 12, textAlign: 'center' }}>
          {isAnchorPhase
            ? 'keys: S skip · ← → move · Enter next · Esc to graph'
            : 'keys: 1–7 answer · ← → move · Enter next · Esc to graph'}
        </div>
      </div>
    </div>
  )
}

/**
 * ONE row. Position decides which statement, and how far out decides how much it
 * matters -- see QUIZ_CHOICES for why strength is now derived from lean rather than a
 * second control. No skip here: every regular question resolves to some notch, and
 * dead centre is the honest "none of this" position.
 */
function RegularQuestion({
  pair,
  current,
  choiceIndex,
  lean,
  categoryColor,
  onCommit,
}: {
  pair: WordPair
  current: TileAnswer | undefined
  choiceIndex: number
  lean: number
  categoryColor: string
  onCommit: (l: LeanIndex) => void
}): JSX.Element {
  const preamble = FACET_PREAMBLE[String(pair.facet)]
  const leanValue = LEAN_NOTCHES[lean as LeanIndex] ?? 0

  return (
    <>
      {preamble && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-dim)',
            lineHeight: 1.5,
            marginBottom: 18,
            paddingLeft: 11,
            borderLeft: `2px solid ${categoryColor}`,
          }}
        >
          {preamble}
        </div>
      )}

      {/* The two statements sit directly above their own half of the row, so which end
          means which is read off the layout instead of having to be remembered. */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 10 }}>
        <div
          style={{
            flex: 1,
            fontSize: 14,
            lineHeight: 1.4,
            color: 'var(--text)',
            fontWeight: leanValue < -0.01 ? 600 : 400,
          }}
        >
          {pair.poleA}
        </div>
        <div
          style={{
            flex: 1,
            fontSize: 14,
            lineHeight: 1.4,
            textAlign: 'right',
            color: 'var(--text)',
            fontWeight: leanValue > 0.01 ? 600 : 400,
          }}
        >
          {pair.poleB}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 3 }}>
        {QUIZ_CHOICES.map((c, i) => {
          const selected = current !== undefined && i === choiceIndex
          return (
            <button
              key={i}
              onClick={() => onCommit(c.leanIndex)}
              title={`${i + 1}. ${
                c.side === 0 ? 'Equally both' : `${c.degree} — ${c.side < 0 ? pair.poleA : pair.poleB}`
              } (recorded as ${STRENGTH_LABELS[c.strength]})`}
              style={{
                flex: c.side === 0 ? 0.8 : 1,
                padding: '10px 2px',
                border: `1px solid ${selected ? categoryColor : 'var(--border)'}`,
                borderRadius: 4,
                background: selected ? categoryColor : 'transparent',
                color: selected ? '#fff' : 'var(--text-dim)',
                fontWeight: selected ? 600 : 400,
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 11,
                whiteSpace: 'nowrap',
              }}
            >
              {c.degree}
            </button>
          )
        })}
      </div>

      {/* What was actually recorded, so a derived value is never a hidden one. */}
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-dim)',
          marginTop: 8,
          minHeight: 14,
          lineHeight: 1.4,
        }}
      >
        {current
          ? `Recorded as ${STRENGTH_LABELS[current.strength]}${
              current.leanIndex === LEAN_CENTER ? ' — held equally, and dormant' : ''
            }.`
          : 'Pick one. A click answers the question and moves on.'}
      </div>
    </>
  )
}

/**
 * A fact, not a spectrum: N option buttons (two for most anchors, more for birth
 * decade), full width, one click both answers and advances. Skippable, unlike a
 * regular question -- a fact can genuinely not apply yet.
 */
function AnchorQuestion({
  anchor,
  current,
  categoryColor,
  onPick,
  onSkip,
}: {
  anchor: AnchorPair
  current: AnchorAnswer | undefined
  categoryColor: string
  onPick: (optionId: string) => void
  onSkip: () => void
}): JSX.Element {
  return (
    <>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-dim)',
          lineHeight: 1.5,
          marginBottom: 18,
          paddingLeft: 11,
          borderLeft: `2px solid ${categoryColor}`,
        }}
      >
        A fact, not an opinion — pick the one that applies, or skip if it doesn't apply
        to you yet. Either way costs the mosaic nothing but this one rim anchor.
      </div>

      <div style={{ fontSize: 15, lineHeight: 1.4, color: 'var(--text)', marginBottom: 14 }}>
        {anchor.prompt}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {anchor.options.map((o) => {
          const selected = current?.optionId === o.id
          return (
            <button
              key={o.id}
              onClick={() => onPick(o.id)}
              style={{
                flex: '1 1 40%',
                padding: '12px 10px',
                border: `1px solid ${selected ? categoryColor : 'var(--border)'}`,
                borderRadius: 4,
                background: selected ? categoryColor : 'transparent',
                color: selected ? '#fff' : 'var(--text)',
                fontWeight: selected ? 600 : 400,
                cursor: 'pointer',
                font: 'inherit',
                fontSize: 12,
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>

      <button
        onClick={onSkip}
        style={{
          marginTop: 14,
          alignSelf: 'flex-start',
          padding: '6px 10px',
          border: '1px dashed var(--border)',
          borderRadius: 4,
          background: 'transparent',
          color: 'var(--text-dim)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 11,
        }}
        title="Skips this anchor entirely (S)"
      >
        Doesn&apos;t apply to me
      </button>
    </>
  )
}

const navBtn: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--border)',
  borderRadius: 4,
  background: 'var(--bg)',
  color: 'var(--text)',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
}
