import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [react()],
    worker: {
      format: 'es',
      // MUST be a function in Vite 5+, not an array.
      plugins: () => [],
    },
    build: {
      target: 'chrome126',
      rollupOptions: { output: { manualChunks: undefined } },
    },
  },
})
