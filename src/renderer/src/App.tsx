import { useEffect } from 'react'
import LeftPanel from './components/LeftPanel'
import MosaicCanvas from './components/MosaicCanvas'
import Toolbar from './components/Toolbar'
import Splash from './components/Splash'
import Quiz from './components/Quiz'
import { useStore } from './state/store'
import { startDraftAutosave } from './state/draft'
import { QUIZ_LENGTH } from './domain/quiz'

export default function App(): JSX.Element {
  const mode = useStore((s) => s.mode)

  useEffect(() => startDraftAutosave(), [])

  /**
   * The studio is kept MOUNTED behind the splash and the quiz rather than unmounted.
   *
   * MosaicCanvas owns the rAF loop, the renderers and the solver session in a single
   * mount-once effect, so unmounting it would tear all of that down and lose an
   * in-flight run every time the user stepped back to the quiz. Hiding it costs
   * essentially nothing, because its loop only does work when a dirty flag is set.
   */
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {mode === 'quiz' && <QuizBar />}
      {mode === 'studio' && <Toolbar />}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          style={{
            display: mode === 'studio' ? 'flex' : 'none',
            height: '100%',
            minHeight: 0,
          }}
        >
          <LeftPanel />
          <div style={{ flex: 1, minWidth: 0 }}>
            <MosaicCanvas />
          </div>
        </div>

        {mode === 'splash' && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--ink-bg)' }}>
            <Splash />
          </div>
        )}
        {mode === 'quiz' && (
          <div style={{ position: 'absolute', inset: 0, background: 'var(--ink-bg)' }}>
            <Quiz />
          </div>
        )}
      </div>
    </div>
  )
}

/** A minimal bar during the quiz: identity, an exit, and nothing to fiddle with. */
function QuizBar(): JSX.Element {
  const setMode = useStore((s) => s.setMode)
  const answered = useStore((s) => s.answers.length)
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
      <button
        onClick={() => setMode('splash')}
        style={{
          background: 'none',
          border: 'none',
          padding: 0,
          color: 'var(--ink-text-dim)',
          cursor: 'pointer',
          font: 'inherit',
        }}
      >
        &larr; Cultural Mosaic
      </button>
      <span style={{ flex: 1 }} />
      <span style={{ color: 'var(--ink-text-dim)' }}>
        {answered} of {QUIZ_LENGTH} answered &middot; saved automatically
      </span>
    </div>
  )
}
