import { describe, it, expect, beforeEach } from 'vitest'
import { useStore } from './store'
import { QUIZ_LENGTH, QUIZ_ORDER } from '../domain/quiz'
import { LIBRARY_BY_ID } from '../domain/library'
import type { LeanIndex } from '../domain/types'

/**
 * The quiz is the on-ramp for the whole app, so its navigation is worth pinning down:
 * a Resume that lands in the wrong place, or a Skip that leaves a stale answer behind,
 * would quietly corrupt the profile the artwork is built from.
 */

function reset(): void {
  useStore.setState({
    mode: 'splash',
    quizIndex: 0,
    answers: [],
    anchorAnswers: [],
    customPairs: [],
    dirty: false,
  })
}

describe('quiz navigation', () => {
  beforeEach(reset)

  it('starts fresh from the first question and discards prior answers', () => {
    const s = useStore.getState()
    s.answerQuiz(QUIZ_ORDER[5]!, 6)
    expect(useStore.getState().answers).toHaveLength(1)

    useStore.getState().startQuiz(true)
    const after = useStore.getState()
    expect(after.mode).toBe('quiz')
    expect(after.quizIndex).toBe(0)
    expect(after.answers).toHaveLength(0)
  })

  it('resumes at the first GAP, not past the answer count', () => {
    // Someone who skipped question two must be taken back to it.
    const s = useStore.getState()
    s.answerQuiz(QUIZ_ORDER[0]!, 6)
    s.answerQuiz(QUIZ_ORDER[2]!, 6)
    s.answerQuiz(QUIZ_ORDER[3]!, 6)

    useStore.getState().startQuiz(false)
    expect(useStore.getState().quizIndex).toBe(1)
  })

  it('resumes at the start of the anchor phase once every regular question is answered', () => {
    const s = useStore.getState()
    for (const id of QUIZ_ORDER) s.answerQuiz(id, 3)
    useStore.getState().startQuiz(false)
    expect(useStore.getState().quizIndex).toBe(QUIZ_LENGTH)
  })

  it('clamps the index to the quiz range', () => {
    const s = useStore.getState()
    s.setQuizIndex(-10)
    expect(useStore.getState().quizIndex).toBe(0)
    s.setQuizIndex(10_000)
    expect(useStore.getState().quizIndex).toBeGreaterThanOrEqual(QUIZ_LENGTH)
  })
})

describe('answering', () => {
  beforeEach(reset)

  it('derives strength from how far the lean sits from centre', () => {
    useStore.getState().answerQuiz(QUIZ_ORDER[0]!, 5)
    const a = useStore.getState().answers[0]!
    expect(a.leanIndex).toBe(5)
    expect(a.strength).toBe(2)
    expect(a.pairId).toBe(QUIZ_ORDER[0]!)
  })

  it('updates in place rather than accumulating duplicates', () => {
    const s = useStore.getState()
    const id = QUIZ_ORDER[0]!
    s.answerQuiz(id, 1)
    s.answerQuiz(id, 6)
    const answers = useStore.getState().answers
    expect(answers).toHaveLength(1)
    expect(answers[0]!.leanIndex).toBe(6)
    expect(answers[0]!.strength).toBe(3)
  })

  it('keeps the original answerId when revising, so the tile identity is stable', () => {
    const s = useStore.getState()
    const id = QUIZ_ORDER[0]!
    s.answerQuiz(id, 1)
    const first = useStore.getState().answers[0]!.answerId
    s.answerQuiz(id, 6)
    expect(useStore.getState().answers[0]!.answerId).toBe(first)
  })

  /**
   * Skip REMOVES the answer rather than storing a sentinel. Unanswered (absent from
   * `answers`) is a different state from Dormant (present, strength 0, contributes
   * nothing but can be toggled back).
   */
  it('skip removes a prior answer entirely', () => {
    const s = useStore.getState()
    const id = QUIZ_ORDER[0]!
    s.answerQuiz(id, 6)
    s.skipQuiz(id)
    expect(useStore.getState().answers).toHaveLength(0)
  })

  it('dead centre is Dormant -- distinct from skipped', () => {
    const s = useStore.getState()
    const id = QUIZ_ORDER[0]!
    s.answerQuiz(id, 3)
    const answers = useStore.getState().answers
    expect(answers).toHaveLength(1)
    expect(answers[0]!.strength).toBe(0)
  })

  it('marks the document dirty on every mutation', () => {
    expect(useStore.getState().dirty).toBe(false)
    useStore.getState().answerQuiz(QUIZ_ORDER[0]!, 3)
    expect(useStore.getState().dirty).toBe(true)
  })
})

describe('a quiz run produces a usable profile', () => {
  beforeEach(reset)

  it('builds answers the placement pipeline can consume', () => {
    const s = useStore.getState()
    s.startQuiz(true)
    // Walk the first 20 questions with varied leans.
    for (let i = 0; i < 20; i++) {
      s.answerQuiz(QUIZ_ORDER[i]!, ((i * 2) % 7) as LeanIndex)
    }
    const st = useStore.getState()
    expect(st.answers).toHaveLength(20)
    // Every referenced pair resolves, which is what placeAnswers requires.
    for (const a of st.answers) {
      expect(LIBRARY_BY_ID.has(a.pairId), a.pairId).toBe(true)
      expect(a.leanIndex).toBeGreaterThanOrEqual(0)
      expect(a.leanIndex).toBeLessThanOrEqual(6)
    }
    const pairs = st.allPairs()
    for (const a of st.answers) expect(pairs.has(a.pairId)).toBe(true)
  })

  it('snapshots exactly the referenced pairs when saved', () => {
    const s = useStore.getState()
    for (let i = 0; i < 5; i++) s.answerQuiz(QUIZ_ORDER[i]!, 4)
    const profile = useStore.getState().toProfile('1.0.0')
    expect(profile.pairs).toHaveLength(5)
    expect(profile.pairs.map((p) => p.id).sort()).toEqual(QUIZ_ORDER.slice(0, 5).slice().sort())
    expect(profile.kind).toBe('cultural-mosaic-profile')
  })

  it('lands in the studio when a profile is loaded or the sample is used', () => {
    useStore.getState().loadSample()
    expect(useStore.getState().mode).toBe('studio')
    expect(useStore.getState().answers.length).toBeGreaterThan(10)
  })
})

describe('mode switching', () => {
  beforeEach(reset)

  it('starts on the splash', () => {
    expect(useStore.getState().mode).toBe('splash')
  })

  it('moves between all three modes', () => {
    const s = useStore.getState()
    for (const m of ['quiz', 'studio', 'splash'] as const) {
      s.setMode(m)
      expect(useStore.getState().mode).toBe(m)
    }
  })
})
