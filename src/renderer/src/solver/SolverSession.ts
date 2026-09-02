import SolverWorker from './solver.worker?worker'
import type { SolverRequest, SolverResponse, FrameMetrics } from './protocol'

/**
 * THE boundary between the app and the solver.
 *
 * This is the ONLY file in the app that mentions `Worker`. That is deliberate: if the
 * module-worker path fails under the packaged file:// origin, the fix is to change
 * `?worker` to `?worker&inline` on the import above -- one line, one file.
 *
 * A plain class. Not a hook, not a component. The frame path never calls setState:
 * it writes two fields and returns, and the canvas rAF loop reads them. Touching React
 * state here would schedule 60 renders/sec of a tree containing the canvas, which is
 * the exact failure mode this whole design exists to avoid.
 */
export class SolverSession {
  private worker: Worker
  private progressListeners = new Set<(m: FrameMetrics) => void>()
  private lifecycleListeners = new Set<(r: SolverResponse) => void>()
  private lastProgressAt = 0
  /** The frame whose buffers we still own, owed back to the worker on the next frame. */
  private spent: Float32Array | null = null

  /** Mutable, plain, read by the rAF loop. NOT React state. */
  latestFrame: { density: Float32Array; metrics: FrameMetrics } | null = null
  fieldDirty = false

  /** Throttle for the low-frequency UI progress readout, in ms. */
  progressIntervalMs = 100

  constructor() {
    this.worker = new SolverWorker()
    this.worker.onmessage = (e: MessageEvent<SolverResponse>) => this.onMessage(e.data)
    this.worker.onerror = (e) => {
      for (const l of this.lifecycleListeners) {
        l({ type: 'error', where: 'worker', message: e.message })
      }
    }
  }

  private onMessage(msg: SolverResponse): void {
    if (msg.type === 'frame') {
      // 1. Return the PREVIOUS frame's buffer for reuse. Without this ping-pong,
      //    a fresh Float32Array per iteration is ~0.7 MB/s of garbage and a GC
      //    pause every few seconds, visible as animation jank.
      if (this.spent) {
        this.send({ type: 'recycle', density: this.spent }, [this.spent.buffer])
        this.spent = null
      }
      // 2. Hand off the new frame and return immediately. No setState.
      const { density, ...metrics } = msg
      this.spent = density
      this.latestFrame = { density, metrics }
      this.fieldDirty = true

      // 3. Throttled, low-frequency progress -- for the UI readout only.
      const now = performance.now()
      if (now - this.lastProgressAt >= this.progressIntervalMs) {
        this.lastProgressAt = now
        for (const l of this.progressListeners) l(metrics)
      }
      return
    }
    // ready / done / error / smokeResult are rare; these MAY touch the store.
    for (const l of this.lifecycleListeners) l(msg)
  }

  private send(msg: SolverRequest, transfer?: Transferable[]): void {
    if (transfer) this.worker.postMessage(msg, transfer)
    else this.worker.postMessage(msg)
  }

  onProgress(fn: (m: FrameMetrics) => void): () => void {
    this.progressListeners.add(fn)
    return () => this.progressListeners.delete(fn)
  }

  onLifecycle(fn: (r: SolverResponse) => void): () => void {
    this.lifecycleListeners.add(fn)
    return () => this.lifecycleListeners.delete(fn)
  }

  step(n: number): void {
    this.send({ type: 'step', n })
  }

  abort(): void {
    this.send({ type: 'abort' })
  }

  /**
   * Verifies the worker path end to end AND that the transfer was genuinely zero-copy
   * rather than a silent structured-clone copy. Resolves with the assertion result.
   * Run this against a PACKAGED build, not just `npm run dev` -- dev serves over
   * http://localhost and will pass even when the file:// build fails.
   */
  smokeTest(n = 1024): Promise<{ transferred: boolean; sum: number; expected: number }> {
    const probe = new Float32Array(n)
    let expected = 0
    for (let i = 0; i < n; i++) {
      probe[i] = i * 0.5
      expected += i * 0.5
    }
    return new Promise((resolve, reject) => {
      const off = this.onLifecycle((msg) => {
        if (msg.type === 'smokeResult') {
          off()
          resolve({ transferred: probe.byteLength === 0, sum: msg.sum, expected })
        } else if (msg.type === 'error' && msg.where === 'worker') {
          off()
          reject(new Error(msg.message))
        }
      })
      this.send({ type: 'smokeTest', probe }, [probe.buffer])
    })
  }

  dispose(): void {
    this.worker.terminate()
    this.progressListeners.clear()
    this.lifecycleListeners.clear()
    this.latestFrame = null
    this.spent = null
  }
}

/**
 * Module-level singleton. React 18 StrictMode double-mounts effects in dev, and a
 * per-effect session would give you two workers interleaving into one `latestFrame` --
 * which presents as a doubled iteration rate and looks exactly like a solver bug.
 */
let singleton: SolverSession | null = null
export function getSolverSession(): SolverSession {
  if (!singleton) singleton = new SolverSession()
  return singleton
}
