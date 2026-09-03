/// <reference lib="webworker" />
import type { SolverRequest, SolverResponse } from './protocol'
import { Optimizer } from './kernel/optimizer'

declare const self: DedicatedWorkerGlobalScope

/**
 * Message pump. All the numerics live in ./kernel; this file only owns the protocol,
 * the buffer pool and error fencing.
 */

let opt: Optimizer | null = null
let aborted = false

/**
 * A three-deep buffer pool. Allocating a fresh Float32Array per iteration is roughly
 * 0.7 MB/s of garbage at animation rates, which is a GC pause every few seconds and
 * visible as jank. The main thread transfers each buffer back once it has painted.
 */
const pool: Float32Array[] = []

function takeBuffer(n: number): Float32Array {
  while (pool.length > 0) {
    const b = pool.pop()!
    // A transferred-away buffer detaches to length 0; drop those.
    if (b.length === n) return b
  }
  return new Float32Array(n)
}

function post(msg: SolverResponse, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(msg, transfer)
  else self.postMessage(msg)
}

function emitFrame(o: Optimizer, m: ReturnType<Optimizer['step']>): void {
  const rho = o.density
  const out = takeBuffer(rho.length)
  // Float32 on the wire, Float64 internally: the canvas needs at most eight bits of
  // density precision, so this halves the traffic and costs nothing.
  for (let i = 0; i < rho.length; i++) out[i] = rho[i]!
  post({ type: 'frame', density: out, ...m }, [out.buffer])
}

self.onmessage = (e: MessageEvent<SolverRequest>): void => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'smokeTest': {
        let sum = 0
        const p = msg.probe
        for (let i = 0; i < p.length; i++) sum += p[i]
        post({ type: 'smokeResult', sum, length: p.length })
        return
      }

      case 'init': {
        aborted = false
        pool.length = 0
        opt = new Optimizer({ ...msg.problem, ...msg.config })
        post({
          type: 'ready',
          dofCount: opt.mesh.ndof,
          nDesign: opt.mesh.designList.length,
          nFree: opt.mesh.freeList.length,
        })
        return
      }

      case 'step': {
        if (!opt) {
          post({ type: 'error', where: 'step', message: 'solver not initialised' })
          return
        }
        for (let k = 0; k < msg.n; k++) {
          if (aborted) {
            post({ type: 'done', iteration: opt.iteration, reason: 'aborted' })
            return
          }
          const m = opt.step()
          emitFrame(opt, m)
          if (m.converged) {
            post({ type: 'done', iteration: opt.iteration, reason: 'converged' })
            return
          }
        }
        post({ type: 'done', iteration: opt.iteration, reason: 'iterations' })
        return
      }

      case 'harden': {
        if (!opt) {
          post({ type: 'error', where: 'harden', message: 'solver not initialised' })
          return
        }
        const m = opt.harden(20)
        emitFrame(opt, m)
        post({ type: 'done', iteration: opt.iteration, reason: 'converged' })
        return
      }

      case 'abort': {
        aborted = true
        post({ type: 'paused', iteration: opt?.iteration ?? 0 })
        return
      }

      case 'recycle': {
        if (pool.length < 3) pool.push(msg.density)
        return
      }
    }
  } catch (err) {
    post({ type: 'error', where: msg.type, message: (err as Error).message })
  }
}
