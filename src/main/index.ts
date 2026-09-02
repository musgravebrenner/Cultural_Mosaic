import { app, shell, BrowserWindow } from 'electron'
import { join } from 'node:path'
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
