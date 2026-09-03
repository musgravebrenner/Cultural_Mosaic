import { createRoot } from 'react-dom/client'
import { StrictMode } from 'react'
import App from './App'
import './styles/theme.css'
import { useStore } from './state/store'
import { QUIZ_ORDER } from './domain/quiz'

/**
 * Inspection hook. Exposes the document store on `window.__mosaic` so the app can be
 * driven from DevTools, and so the MOSAIC_SHOT startup path can load a profile and
 * capture a screenshot without a human at the keyboard.
 *
 * Attached unconditionally rather than gated on a build flag, because a preview build
 * IS a production build and the gate simply stripped it. That is acceptable here: the
 * renderer loads only local files, under a strict CSP, with contextIsolation on and no
 * remote content anywhere in the app -- so there is no actor who could reach this that
 * could not already run arbitrary script in the renderer. It exposes no filesystem or
 * IPC capability beyond what the page already has.
 */
;(window as unknown as { __mosaic?: unknown }).__mosaic = { store: useStore, quizOrder: QUIZ_ORDER }

/**
 * Theme -> <html data-theme>. Outside React on purpose.
 *
 * <html> rather than <body> because `color-scheme` on the ROOT element is what sets the
 * used colour scheme for the viewport, so the root scrollbar follows only the root.
 *
 * Outside React because App sits above MosaicCanvas, and this app's architecture depends
 * on nothing above MosaicCanvas subscribing to store slices. The store's vanilla
 * subscribe is the first-class path for exactly this. It also runs BEFORE the first
 * render, so a draft restored with theme 'paper' never flashes dark chrome.
 */
function applyTheme(t: 'ink' | 'paper'): void {
  document.documentElement.dataset['theme'] = t
}
applyTheme(useStore.getState().render.theme)
useStore.subscribe((s, prev) => {
  if (s.render.theme !== prev.render.theme) applyTheme(s.render.theme)
})

const el = document.getElementById('root')
if (!el) throw new Error('#root missing from index.html')

createRoot(el).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
