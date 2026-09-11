import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpc } from './ipc'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#101014',
    autoHideMenuBar: true,
    title: 'Cultural Mosaic',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, // default, but be explicit
      nodeIntegration: false, // default, but be explicit
      sandbox: true, // the template ships false; our preload only needs contextBridge + ipcRenderer
      webSecurity: true,
      devTools: is.dev,
    },
  })

  // Dev/CI affordance: forward renderer console output to stdout so the startup
  // diagnostics can be asserted from a script instead of by eye. With MOSAIC_DIAG=1
  // the app also exits as soon as the diagnostic line arrives.
  if (is.dev || process.env['MOSAIC_DIAG']) {
    mainWindow.webContents.on('console-message', (_e, _level, message) => {
      process.stdout.write(`[renderer] ${message}
`)
      if (process.env['MOSAIC_DIAG'] && message.startsWith('MOSAIC_DIAG ')) {
        setTimeout(() => app.exit(message.includes('"pass":true') ? 0 : 1), 50)
      }
    })
  }

  // MOSAIC_SHOT=<path>: load the sample profile, wait for a few animation frames, and
  // write a PNG of the window. A development affordance for verifying the render
  // without a human at the keyboard; not referenced by any app code.
  if (process.env['MOSAIC_SHOT']) {
    mainWindow.webContents.once('did-finish-load', () => {
      const win = mainWindow
      if (!win) return
      setTimeout(() => {
        const th = process.env['MOSAIC_THEME']
          ? "window.__mosaic.store.getState().setRender({theme:'"
            + process.env['MOSAIC_THEME'] + "'});"
          : ''
        const labels = process.env['MOSAIC_LABELS']
          ? "window.__mosaic.store.getState().setRender({showAnchorLabels:true"
            + (process.env['MOSAIC_LABELS'] === 'only' ? ",showScaffolding:false" : '')
            + "});"
          : ''
        // MOSAIC_POLE_LABELS: same idea as MOSAIC_LABELS, for the "Answers" toggle
        // (showPoleLabels) instead of the anchor-only one.
        const poleLabels = process.env['MOSAIC_POLE_LABELS']
          ? "window.__mosaic.store.getState().setRender({showPoleLabels:true"
            + (process.env['MOSAIC_POLE_LABELS'] === 'only' ? ",showScaffolding:false" : '')
            + "});"
          : ''
        /**
         * MOSAIC_ANSWERS=<json> replaces loadSample() with an arbitrary answer set, for
         * exercising configurations the shipped Sample profile does not (e.g. an engaged
         * antagonism). JSON array of [pairId, leanIndex, strength] triples.
         */
        const answersJson = process.env['MOSAIC_ANSWERS']
        const customAnswers = answersJson
          ? "window.__mosaic.store.setState({answers:(" + answersJson + ").map(function(t,i){"
            + "return {answerId:'a-'+t[0],pairId:t[0],leanIndex:t[1],strength:t[2],addedAt:i};"
            + "}),dirty:true,tab:'profile',mode:'studio'});"
          : ''
        /**
         * Explicit AND deferred, because the saved draft is read over IPC and applied
         * asynchronously: whenever it lands after this script, it restores the splash and
         * the screenshot captures the wrong screen. Setting the mode from a timer puts it
         * after any such late arrival.
         */
        const studio =
          "setTimeout(function(){window.__mosaic.store.getState().setMode('studio');},500);"
        const vf = process.env['MOSAIC_VF']
          ? "window.__mosaic.store.getState().setSolver({volumeFraction:" + process.env['MOSAIC_VF'] + "});"
          : ''
        // MOSAIC_SCREEN drives the app to a named screen instead of loading the
        // sample: 'splash' leaves it where it starts, 'quiz' begins a fresh run.
        const screen = process.env['MOSAIC_SCREEN']
        if (screen) {
          // 'flow' exercises the whole path: start the quiz, answer a spread of
          // questions the way a user would, then go to the graph and run.
          // 'seed' answers a handful of questions and exits, so a SECOND launch can
          // prove the draft survived a real process restart.
          const seedOnly =
            'var s=window.__mosaic.store.getState();s.startQuiz(true);'
            + 'var o=window.__mosaic.quizOrder;'
            + 'for(var i=0;i<12;i++){s.answerQuiz(o[i],4,2);}true'
          const flow =
            'var s=window.__mosaic.store.getState();s.startQuiz(true);'
            + 'var o=window.__mosaic.quizOrder;'
            + 'for(var i=0;i<40;i++){s.answerQuiz(o[i],(i*3)%7,(i%3)+1);}'
            + "window.__mosaic.store.getState().setMode('studio');"
            + 'setTimeout(function(){window.dispatchEvent(new CustomEvent("mosaic:run",'
            + '{detail:{iterations:140}}));},700); true'
          // `th` on every branch: the quiz and seed screens used to skip it, so
          // MOSAIC_THEME=paper silently produced a dark screenshot of them.
          const nav =
            th
            + (screen === 'seed'
              ? seedOnly
              : screen === 'quiz'
                ? 'window.__mosaic.store.getState().startQuiz(true);'
                  // MOSAIC_QUIZ_INDEX: jump straight to a position (e.g. the anchor
                  // phase, at QUIZ_LENGTH) without clicking through every question.
                  + (process.env['MOSAIC_QUIZ_INDEX']
                    ? 'window.__mosaic.store.getState().setQuizIndex('
                      + process.env['MOSAIC_QUIZ_INDEX'] + '); true'
                    : 'true')
                : screen === 'flow'
                  ? flow
                  : "window.__mosaic.store.getState().setMode('" + screen + "'); true")
          void win.webContents
            .executeJavaScript(nav)
            .then(() => new Promise((r) => setTimeout(r, screen === 'flow' ? 12000 : screen === 'seed' ? 1500 : 700)))
            .then(() => win.webContents.capturePage())
            .then((img) => writeFile(process.env['MOSAIC_SHOT']!, img.toPNG()))
            .then(() => {
              process.stdout.write(`SHOT_OK ${process.env['MOSAIC_SHOT']}
`)
              app.exit(0)
            })
            .catch((err: Error) => {
              process.stdout.write(`SHOT_FAIL ${err.message}
`)
              app.exit(1)
            })
          return
        }

        /**
         * MOSAIC_HOVER=<fx>,<fy> moves the pointer over the field canvas at those
         * fractions of its box and reports what the tooltip says, so canvas hit testing
         * can be checked without a human at the keyboard. Dispatched on the canvas so it
         * bubbles to the wrap, which is where the listener lives.
         */
        const hoverAt = process.env['MOSAIC_HOVER']
        const hover = hoverAt
          ? 'setTimeout(function(){'
            + 'var c=document.querySelector("canvas");var r=c.getBoundingClientRect();'
            + 'var f=("' + hoverAt + '").split(",");'
            + 'c.dispatchEvent(new MouseEvent("mousemove",{clientX:r.left+r.width*(+f[0]),'
            + 'clientY:r.top+r.height*(+f[1]),bubbles:true}));},500);'
          : ''
        /**
         * MOSAIC_CLICK=<text> finds the first <button> whose text contains that string
         * and clicks it -- a development affordance for reaching a collapsed panel (like
         * the "> Solver" toggle) without a human at the keyboard.
         */
        const clickText = process.env['MOSAIC_CLICK']
        const click = clickText
          ? 'setTimeout(function(){'
            + 'var bs=document.querySelectorAll("button");'
            + 'for(var i=0;i<bs.length;i++){if(bs[i].textContent.indexOf("' + clickText + '")>=0)'
            + '{bs[i].click();break;}}},550);'
          : ''
        const loadProfile = customAnswers || "window.__mosaic.store.getState().loadSample();"
        const script = process.env['MOSAIC_RUN']
          ? loadProfile + th + vf + labels + poleLabels + studio + hover + click
            + "setTimeout(function(){window.dispatchEvent(new CustomEvent('mosaic:run',"
            + "{detail:{iterations:" + process.env['MOSAIC_RUN'] + "}}));},600); true"
          : loadProfile + th + vf + labels + poleLabels + studio + hover + click + ' true'
        void win.webContents
          .executeJavaScript(script)
          .then(
            () =>
              new Promise((r) => {
                // MOSAIC_WAIT=<ms> overrides the settle time. A converged run at the
                // default 96 grid needs far longer than the 14s default, and guessing
                // wrong yields a screenshot of iteration 1 that looks like a bug.
                const wait = Number(process.env['MOSAIC_WAIT'] ?? '')
                setTimeout(
                  r,
                  Number.isFinite(wait) && wait > 0 ? wait : process.env['MOSAIC_RUN'] ? 14000 : 1600,
                )
              }),
          )
          .then(async () => {
            if (!process.env['MOSAIC_HOVER']) return
            const tip: string = await win.webContents.executeJavaScript(
              '(function(){var e=document.querySelector("[data-mosaic-tip]");'
                + 'return !e?"missing":e.hidden?"hidden":e.textContent;})()',
            )
            process.stdout.write(`HOVER ${tip}
`)
          })
          .then(() => win.webContents.capturePage())
          .then((img) => writeFile(process.env['MOSAIC_SHOT']!, img.toPNG()))
          .then(() => {
            process.stdout.write(`SHOT_OK ${process.env['MOSAIC_SHOT']}
`)
            app.exit(0)
          })
          .catch((err: Error) => {
            process.stdout.write(`SHOT_FAIL ${err.message}
`)
            app.exit(1)
          })
        // 2500, not 1200: the saved draft is read over IPC and applied asynchronously, so
        // a script that runs before it lands gets silently overwritten -- the app comes
        // back to the splash with the draft's answers and the screenshot shows the wrong
        // screen entirely.
      }, 2500)
    })
  }

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // Two handlers that close the "user clicks a link, your Electron app becomes an
  // unsandboxed browser" hole.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('us.kpb.culturalmosaic') // correct Windows taskbar identity
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  registerIpc(() => mainWindow)
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
