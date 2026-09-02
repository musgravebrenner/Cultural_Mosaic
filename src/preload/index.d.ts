import type { MosaicBridge } from '../shared/ipc-contract'

declare global {
  interface Window {
    mosaic: MosaicBridge
  }
}

export {}
