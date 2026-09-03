import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { loadDraft, readDraftSummary, clearDraft } from '../state/draft'
import type { DraftSummary } from '../state/draft'
import { QUIZ_LENGTH } from '../domain/quiz'
import { LIBRARY } from '../domain/library'
import { parseProfile } from '../domain/validate'
import { CATEGORIES, CATEGORY_LABEL } from '../domain/taxonomy'
import { categoryCss, useThemeColors } from '../render/useThemeColors'


/**
 * The entry screen.
 *
 * Its job is to make the two real starting points obvious -- answer the questions, or go
 * straight to the graph -- and to make Resume trustworthy by saying exactly how far
 * through you are before you commit to it.
 */
export default function Splash(): JSX.Element {
  const startQuiz = useStore((s) => s.startQuiz)
  const setMode = useStore((s) => s.setMode)
  const loadSample = useStore((s) => s.loadSample)
  const answersInMemory = useStore((s) => s.answers.length)

  const CAT_CSS = categoryCss(useThemeColors())

  const [draft, setDraft] = useState<DraftSummary | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // The draft lives in a file, so reading it is async. Re-read on mount so one written
  // by a previous session is picked up.
  useEffect(() => {
    let alive = true
    void readDraftSummary().then((d) => {
      if (alive) setDraft(d)
    })
    return () => {
      alive = false
    }
  }, [])

  const counts = useMemo(() => {
    const c = { demographic: 0, geographic: 0, associative: 0 }
    for (const p of LIBRARY) c[p.category]++
    return c
  }, [])

  const resumable = draft !== null && draft.answered > 0
  const inProgress = answersInMemory > 0

  const onResume = (): void => {
    if (inProgress) {
      startQuiz(false)
      return
    }
    void loadDraft().then((ok) => {
      if (ok) startQuiz(false)
      else setNotice('That draft could not be read, so it has been skipped.')
    })
  }

  const onOpen = async (): Promise<void> => {
    const res = await window.mosaic.openProfile()
    if (res.canceled) return
    if (res.error || res.contents === undefined) {
      setNotice(res.error ?? 'Could not read that file.')
      return
    }
    try {
      const parsed = parseProfile(JSON.parse(res.contents))
      if (!parsed.ok) {
        setNotice(parsed.errors.join(' '))
        return
      }
      useStore.getState().loadProfile(parsed.profile)
    } catch {
      setNotice('That file is not valid JSON.')
    }
  }

  return (
    <div
      style={{
        height: '100%',
        display: 'grid',
        placeItems: 'center',
        padding: 24,
        overflowY: 'auto',
      }}
    >
      <div style={{ width: 560, maxWidth: '100%' }}>
        <h1 style={{ margin: 0, fontSize: 30, fontWeight: 500, letterSpacing: -0.4 }}>
          Cultural Mosaic
        </h1>
        <p
          style={{
            margin: '10px 0 4px',
            color: 'var(--text-dim)',
            lineHeight: 1.6,
            fontSize: 13,
          }}
        >
          {QUIZ_LENGTH} paired questions about what shaped you. Each answer deposits colour
          and material into a structure, and a topology optimizer then erodes everything
          that is not load-bearing. Where your identities agree, the structure holds; where
          they contend, it opens into void.
        </p>

        <div
          style={{
            display: 'flex',
            gap: 14,
            margin: '14px 0 22px',
            fontSize: 11,
            color: 'var(--text-dim)',
          }}
        >
          {CATEGORIES.map((c) => (
            <span key={c} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{ width: 8, height: 8, borderRadius: 8, background: CAT_CSS[c] }}
              />
              {CATEGORY_LABEL[c]} · {counts[c]}
            </span>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 10 }}>
          <Card
            title={inProgress || resumable ? 'Continue answering' : 'Start answering'}
            detail={
              inProgress
                ? `${answersInMemory} of ${QUIZ_LENGTH} answered in this session.`
                : resumable
                  ? `${draft!.answered} of ${QUIZ_LENGTH} answered, saved ${when(draft!.savedAt)}.`
                  : `One question at a time, through all ${QUIZ_LENGTH}. You can stop at any point.`
            }
            primary
            onClick={inProgress || resumable ? onResume : () => startQuiz(true)}
          />

          {(inProgress || resumable) && (
            <Card
              title="Start over"
              detail="Discard the answers and begin the questions from the top."
              onClick={() => {
                void clearDraft()
                setDraft(null)
                startQuiz(true)
              }}
            />
          )}

          <Card
            title="Go to the graph"
            detail={
              inProgress || resumable
                ? 'Skip ahead to the mosaic and edit answers directly.'
                : 'Open the studio with nothing answered yet, and browse the library.'
            }
            onClick={() => {
              if (!inProgress && resumable) {
                // loadProfile already lands in the studio.
                void loadDraft()
              } else {
                setMode('studio')
              }
            }}
          />

          <div style={{ display: 'flex', gap: 10 }}>
            <Card
              title="Open a profile…"
              detail="Load a saved .mosaic.json"
              onClick={() => void onOpen()}
              compact
            />
            <Card
              title="Load the sample"
              detail="A worked example of 16 answers"
              onClick={loadSample}
              compact
            />
          </div>
        </div>

        {notice && (
          <div style={{ marginTop: 14, fontSize: 11, color: 'var(--warn)' }}>{notice}</div>
        )}

        <p
          style={{
            marginTop: 26,
            fontSize: 10,
            color: 'var(--text-dim)',
            lineHeight: 1.6,
          }}
        >
          Every pair is a spectrum between two ways of being, not a category you belong to.
          Both poles are meant to be inhabitable, and nothing you answer leaves this
          machine.
        </p>
      </div>
    </div>
  )
}

function when(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'earlier'
  const mins = Math.round((Date.now() - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

function Card({
  title,
  detail,
  onClick,
  primary,
  compact,
}: {
  title: string
  detail: string
  onClick: () => void
  primary?: boolean
  compact?: boolean
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        textAlign: 'left',
        padding: compact ? '10px 12px' : '13px 15px',
        border: `1px solid ${primary ? 'var(--text-dim)' : 'var(--border)'}`,
        borderRadius: 'var(--radius)',
        background: primary ? 'var(--panel)' : 'transparent',
        color: 'var(--text)',
        cursor: 'pointer',
        font: 'inherit',
        display: 'grid',
        gap: 3,
      }}
    >
      <span style={{ fontWeight: primary ? 600 : 500, fontSize: compact ? 12 : 13 }}>
        {title}
      </span>
      <span style={{ color: 'var(--text-dim)', fontSize: 11, lineHeight: 1.45 }}>
        {detail}
      </span>
    </button>
  )
}
