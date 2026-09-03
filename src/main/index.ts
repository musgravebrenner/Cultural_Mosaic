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
          const nav =
            screen === 'seed'
              ? seedOnly
              : screen === 'quiz'
              ? 'window.__mosaic.store.getState().startQuiz(true); true'
              : screen === 'flow'
                ? flow
                : "window.__mosaic.store.getState().setMode('" + screen + "'); true"
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

        const script = process.env['MOSAIC_RUN']
          ? "window.__mosaic.store.getState().loadSample();" + vf
            + "setTimeout(function(){window.dispatchEvent(new CustomEvent('mosaic:run',"
            + "{detail:{iterations:" + process.env['MOSAIC_RUN'] + "}}));},600); true"
          : 'window.__mosaic.store.getState().loadSample(); true'
        void win.webContents
          .executeJavaScript(script)
          .then(
            () =>
              new Promise((r) => {
                setTimeout(r, process.env['MOSAIC_RUN'] ? 14000 : 900)
              }),
          )
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
      }, 1200)
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
