import { app, BrowserWindow, dialog, ipcMain, Menu, session, type MenuItemConstructorOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MenuCommand, OpenedFile } from '../shared/api'

const isMac = process.platform === 'darwin'
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

/** Per-window state kept in main: unsaved flag and the file paths the user granted via dialogs. */
interface WindowState {
  dirty: boolean
  grantedPaths: Set<string>
}
const windowStates = new WeakMap<Electron.WebContents, WindowState>()

function stateOf(wc: Electron.WebContents): WindowState {
  let s = windowStates.get(wc)
  if (!s) {
    s = { dirty: false, grantedPaths: new Set() }
    windowStates.set(wc, s)
  }
  return s
}

// ---------------------------------------------------------------------------
// Offline lockdown: block every network request except local resources.
// ---------------------------------------------------------------------------
function lockDownNetwork(): void {
  const devOrigin = devServerUrl ? new URL(devServerUrl).origin : null
  const devWsOrigin = devOrigin?.replace(/^http/, 'ws') ?? null
  const allowedProtocols = new Set(['file:', 'devtools:', 'data:', 'blob:', 'chrome-extension:'])

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    let allowed = false
    try {
      const url = new URL(details.url)
      if (allowedProtocols.has(url.protocol)) allowed = true
      else if (devOrigin && (url.origin === devOrigin || url.origin === devWsOrigin)) allowed = true
    } catch {
      allowed = false
    }
    if (!allowed) console.warn('[offline] blocked:', details.url)
    callback({ cancel: !allowed })
  })

  // Deny camera/mic/notifications/geolocation/etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    minWidth: 480,
    minHeight: 320,
    show: false,
    title: 'Docraft',
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false
    }
  })

  win.once('ready-to-show', () => win.show())

  // No navigation away from the app and no new windows.
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  // Confirm before closing with unsaved changes.
  win.on('close', (e) => {
    if (!stateOf(win.webContents).dirty) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['保存せずに閉じる', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '保存されていない変更があります。',
      detail: '閉じると変更は失われます。'
    })
    if (choice !== 0) e.preventDefault()
  })

  if (devServerUrl) win.loadURL(devServerUrl)
  else win.loadFile(join(__dirname, '../renderer/index.html'))

  return win
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
const mdFilters = [
  { name: 'Markdown', extensions: ['md', 'markdown', 'txt'] },
  { name: 'All Files', extensions: ['*'] }
]

function registerIpc(): void {
  ipcMain.handle('file:open', async (e): Promise<OpenedFile | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: mdFilters }
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (res.canceled || res.filePaths.length === 0) return null
    const path = res.filePaths[0]
    const content = await readFile(path, 'utf8')
    stateOf(e.sender).grantedPaths.add(path)
    return { path, content }
  })

  ipcMain.handle('file:save', async (e, path: unknown, content: unknown): Promise<string | null> => {
    if (typeof content !== 'string') throw new Error('invalid content')
    const st = stateOf(e.sender)
    let target = typeof path === 'string' && st.grantedPaths.has(path) ? path : null
    if (!target) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts: Electron.SaveDialogOptions = { filters: mdFilters, defaultPath: 'Untitled.md' }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      target = res.filePath
      st.grantedPaths.add(target)
    }
    await writeFile(target, content, 'utf8')
    return target
  })

  ipcMain.handle('confirm:discard', async (e): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['変更を破棄', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: '保存されていない変更があります。破棄しますか?'
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    return res.response === 0
  })

  ipcMain.on('state:dirty', (e, dirty: unknown) => {
    stateOf(e.sender).dirty = dirty === true
  })
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------
function send(cmd: MenuCommand): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (win) win.webContents.send('menu', cmd)
  else if (cmd === 'new' || cmd === 'open') createWindow()
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'ファイル',
      submenu: [
        { label: '新規', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: '開く…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: '名前を付けて保存…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('saveAs') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  lockDownNetwork()
  registerIpc()
  buildMenu()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (!isMac) app.quit()
})
