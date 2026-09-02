/// <reference lib="webworker" />
import type { SolverRequest, SolverResponse } from './protocol'

declare const self: DedicatedWorkerGlobalScope

function post(msg: SolverResponse, transfer?: Transferable[]): void {
  if (transfer) self.postMessage(msg, transfer)
  else self.postMessage(msg)
}

self.onmessage = (e: MessageEvent<SolverRequest>): void => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'smokeTest': {
        // Touch every element so a silent structured-clone copy would still be
        // observable, then reply. The *caller* asserts probe.byteLength === 0.
        let sum = 0
        const p = msg.probe
        for (let i = 0; i < p.length; i++) sum += p[i]
        post({ type: 'smokeResult', sum, length: p.length })
        return
      }
      case 'init':
      case 'step':
      case 'abort':
      case 'recycle':
        post({ type: 'error', where: msg.type, message: 'kernel not implemented yet (step 7)' })
        return
    }
  } catch (err) {
    post({ type: 'error', where: msg.type, message: (err as Error).message })
  }
}
