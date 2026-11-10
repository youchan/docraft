import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { access, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { ContextAction, MenuCommand, OpenedFile, TodoItem, TreeEntry, WorkspaceInfo } from '../shared/api'

const isMac = process.platform === 'darwin'
const devServerUrl = process.env['ELECTRON_RENDERER_URL']

/**
 * Per-window state kept in main: unsaved flag, the file paths the user granted via dialogs,
 * and the folder (workspace) the user opened. The renderer can only touch paths inside these.
 */
interface WindowState {
  dirty: boolean
  grantedPaths: Set<string>
  root: string | null
  /** Set while the window waits for the renderer to flush (autosave) before closing. */
  finishClose: (() => void) | null
}
const windowStates = new WeakMap<Electron.WebContents, WindowState>()

function stateOf(wc: Electron.WebContents): WindowState {
  let s = windowStates.get(wc)
  if (!s) {
    s = { dirty: false, grantedPaths: new Set(), root: null, finishClose: null }
    windowStates.set(wc, s)
  }
  return s
}

/** True when `p` is strictly inside the window's opened folder. */
function isInsideRoot(st: WindowState, p: string): boolean {
  if (!st.root) return false
  const abs = resolve(p)
  return abs.startsWith(st.root + sep)
}

function assertAllowed(st: WindowState, p: unknown): string {
  if (typeof p !== 'string' || !p) throw new Error('invalid path')
  const abs = resolve(p)
  if (!isInsideRoot(st, abs) && !st.grantedPaths.has(abs)) throw new Error('path not allowed')
  return abs
}

function assertInsideRoot(st: WindowState, p: unknown): string {
  if (typeof p !== 'string' || !p) throw new Error('invalid path')
  const abs = resolve(p)
  if (!isInsideRoot(st, abs)) throw new Error('path not allowed')
  return abs
}

function assertValidName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('invalid name')
  const n = name.trim()
  if (!n || n === '.' || n === '..' || /[\\/]/.test(n)) throw new Error('invalid name')
  return n
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** `base` + ext, or `base 2`, `base 3`… until it does not exist in `dir`. */
async function uniqueName(dir: string, base: string, ext: string): Promise<string> {
  let i = 1
  let name = `${base}${ext}`
  while (await exists(join(dir, name))) name = `${base} ${++i}${ext}`
  return name
}

// ---------------------------------------------------------------------------
// Folder tree
// ---------------------------------------------------------------------------
const MD_EXTS = new Set(['.md', '.markdown'])
const IGNORED_DIRS = new Set(['node_modules'])

/** Scan a folder: directories (always) and Markdown files. Dot-entries and symlinks are skipped. */
async function scanTree(dir: string): Promise<TreeEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const dirs: TreeEntry[] = []
  const files: TreeEntry[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue
      dirs.push({ id: full, name: e.name, children: await scanTree(full).catch(() => []) })
    } else if (e.isFile() && MD_EXTS.has(extname(e.name).toLowerCase())) {
      files.push({ id: full, name: e.name })
    }
  }
  const byName = (a: TreeEntry, b: TreeEntry): number => a.name.localeCompare(b.name, 'ja', { numeric: true })
  return [...dirs.sort(byName), ...files.sort(byName)]
}

// ---------------------------------------------------------------------------
// TODOs: <root>/.todo/<title>.md, subtasks in <root>/.todo/<title>/<subtask>.md
// ---------------------------------------------------------------------------
const TODO_DIR = '.todo'
const COMPLETED_DIR = '.completed'
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000

function todoRoot(st: WindowState): string {
  if (!st.root) throw new Error('documents folder is not set')
  return join(st.root, TODO_DIR)
}

/** A path of a TODO file: inside `.todo` and a Markdown file. */
function assertTodoPath(st: WindowState, p: unknown): string {
  const abs = assertInsideRoot(st, p)
  if (!abs.startsWith(todoRoot(st) + sep) || extname(abs).toLowerCase() !== '.md') throw new Error('not a TODO')
  if (abs.startsWith(join(todoRoot(st), COMPLETED_DIR) + sep)) throw new Error('not a TODO')
  return abs
}

/** A TODO title: a valid file name without `.md`, and not hidden (so it cannot clash with `.completed`). */
function assertTodoName(title: unknown): string {
  const name = assertValidName(title).replace(/\.md$/i, '').trim()
  if (!name || name.startsWith('.')) throw new Error('invalid name')
  return name
}

/** Number of subtasks below a TODO, at any depth. */
async function countSubtasks(todoPath: string): Promise<number> {
  let n = 0
  for (const c of await listMarkdown(subtaskDir(todoPath))) n += 1 + (await countSubtasks(c.id))
  return n
}

/**
 * Move a TODO and all of its subtasks to `.completed/<uuid>.md`, each with `# <path below .todo>`
 * on top. The file is rewritten, so its mtime is the completion time (used for the 30-day purge).
 */
async function completeTodoTree(st: WindowState, file: string): Promise<void> {
  const base = todoRoot(st)
  const completedDir = join(base, COMPLETED_DIR)
  await mkdir(completedDir, { recursive: true })
  const walk = async (f: string): Promise<void> => {
    for (const c of await listMarkdown(subtaskDir(f))) await walk(c.id)
    const title = relative(base, f).slice(0, -extname(f).length).split(sep).join('/')
    const body = await readFile(f, 'utf8')
    await writeFile(join(completedDir, `${randomUUID()}.md`), `# ${title}\n\n${body}`, { encoding: 'utf8', flag: 'wx' })
    await unlink(f)
    await rmdir(subtaskDir(f)).catch(() => undefined) // only succeeds when empty
  }
  await walk(file)
}

/** Delete completed TODOs that were completed more than 30 days ago. Runs once at startup. */
let completedPurged = false
async function purgeCompleted(root: string): Promise<void> {
  const dir = join(root, TODO_DIR, COMPLETED_DIR)
  const now = Date.now()
  for (const item of await listMarkdown(dir)) {
    try {
      if (now - (await stat(item.id)).mtimeMs > COMPLETED_TTL_MS) await unlink(item.id)
    } catch {
      // ignore files that vanish or cannot be removed
    }
  }
}

/** The folder that holds a TODO's subtasks: same path without `.md`. */
function subtaskDir(todoPath: string): string {
  return join(dirname(todoPath), basename(todoPath, extname(todoPath)))
}

async function listMarkdown(dir: string): Promise<TodoItem[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  return entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && MD_EXTS.has(extname(e.name).toLowerCase()))
    .map((e) => ({ id: join(dir, e.name), name: basename(e.name, extname(e.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja', { numeric: true }))
}

// ---------------------------------------------------------------------------
// Config: ~/.docraft/config.toml  ->  documents_folder = ~/docs/docraft
// ---------------------------------------------------------------------------
const configDir = join(homedir(), '.docraft')
const configPath = join(configDir, 'config.toml')

/**
 * Minimal `key = value` reader for the one setting we need. Deliberately lenient:
 * values may be quoted ("…" / '…') or bare (`documents_folder=~/docs/docraft`).
 */
function parseConfig(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    const q = val[0]
    if (q === '"' || q === "'") {
      const end = val.indexOf(q, 1)
      val = end > 0 ? val.slice(1, end) : val.slice(1)
    } else {
      val = val.replace(/\s+#.*$/, '').trim()
    }
    out[key] = val
  }
  return out
}

function expandPath(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return isAbsolute(p) ? resolve(p) : resolve(configDir, p)
}

/** Read the config and, if it names a valid documents folder, grant it to this window and scan it. */
async function loadWorkspace(st: WindowState): Promise<WorkspaceInfo> {
  const base = { configPath, configuredPath: null as string | null }
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch {
    return { ...base, folder: null, problem: 'no-config' }
  }
  const configured = parseConfig(text)['documents_folder']
  if (!configured) return { ...base, folder: null, problem: 'not-set' }

  const root = expandPath(configured)
  const info = { ...base, configuredPath: root }
  try {
    if (!(await stat(root)).isDirectory()) return { ...info, folder: null, problem: 'not-found' }
    st.root = root
    if (!completedPurged) {
      completedPurged = true
      void purgeCompleted(root).catch(() => undefined)
    }
    return { ...info, folder: { root, tree: await scanTree(root) }, problem: null }
  } catch {
    return { ...info, folder: null, problem: 'not-found' }
  }
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

  // Unsaved changes are autosaved: ask the renderer to flush, then close (with a timeout as a safety net).
  win.on('close', (e) => {
    const st = stateOf(win.webContents)
    if (!st.dirty) return
    e.preventDefault()
    if (st.finishClose) return
    const timer = setTimeout(() => st.finishClose?.(), 3000)
    st.finishClose = () => {
      clearTimeout(timer)
      st.finishClose = null
      st.dirty = false
      if (!win.isDestroyed()) win.close()
    }
    win.webContents.send('app:before-close')
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
    stateOf(e.sender).grantedPaths.add(resolve(path))
    return { path, content }
  })

  ipcMain.handle('file:read', async (e, path: unknown): Promise<string> => {
    return readFile(assertAllowed(stateOf(e.sender), path), 'utf8')
  })

  ipcMain.handle('file:save', async (e, path: unknown, content: unknown): Promise<string | null> => {
    if (typeof content !== 'string') throw new Error('invalid content')
    const st = stateOf(e.sender)
    let target: string | null = null
    if (typeof path === 'string') {
      const abs = resolve(path)
      if (st.grantedPaths.has(abs) || isInsideRoot(st, abs)) target = abs
    }
    if (!target) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts: Electron.SaveDialogOptions = { filters: mdFilters, defaultPath: 'Untitled.md' }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return null
      target = resolve(res.filePath)
      st.grantedPaths.add(target)
    }
    await writeFile(target, content, 'utf8')
    return target
  })

  // ---- Workspace / tree ----------------------------------------------------
  ipcMain.handle('workspace:load', (e): Promise<WorkspaceInfo> => loadWorkspace(stateOf(e.sender)))

  ipcMain.handle('folder:tree', async (e, root: unknown): Promise<TreeEntry[]> => {
    const st = stateOf(e.sender)
    if (typeof root !== 'string' || !st.root || resolve(root) !== st.root) throw new Error('path not allowed')
    return scanTree(st.root)
  })

  ipcMain.handle('entry:create', async (e, parent: unknown, kind: unknown): Promise<string> => {
    const st = stateOf(e.sender)
    const dir = typeof parent === 'string' && st.root && resolve(parent) === st.root ? st.root : assertInsideRoot(st, parent)
    if (!(await stat(dir)).isDirectory()) throw new Error('parent is not a folder')
    if (kind === 'folder') {
      const target = join(dir, await uniqueName(dir, 'New Folder', ''))
      await mkdir(target)
      return target
    }
    const target = join(dir, await uniqueName(dir, 'Untitled', '.md'))
    await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    return target
  })

  ipcMain.handle('entry:rename', async (e, path: unknown, newName: unknown): Promise<string> => {
    const st = stateOf(e.sender)
    const src = assertInsideRoot(st, path)
    let name = assertValidName(newName)
    if ((await stat(src)).isFile() && !extname(name)) name += '.md'
    const dest = join(dirname(src), name)
    if (dest === src) return src
    if (await exists(dest)) throw new Error(`「${name}」はすでに存在します。`)
    await rename(src, dest)
    return dest
  })

  ipcMain.handle('entry:move', async (e, paths: unknown, destDir: unknown): Promise<Record<string, string>> => {
    const st = stateOf(e.sender)
    if (!Array.isArray(paths)) throw new Error('invalid paths')
    const dest = typeof destDir === 'string' && st.root && resolve(destDir) === st.root ? st.root : assertInsideRoot(st, destDir)
    const moved: Record<string, string> = {}
    for (const p of paths) {
      const src = assertInsideRoot(st, p)
      if (dest === src || dest.startsWith(src + sep)) throw new Error('フォルダを自分自身の中には移動できません。')
      const target = join(dest, basename(src))
      if (target === src) continue
      if (await exists(target)) throw new Error(`「${basename(src)}」は移動先にすでに存在します。`)
      await rename(src, target)
      moved[src] = target
    }
    return moved
  })

  ipcMain.handle('entry:reveal', (e, path: unknown): void => {
    shell.showItemInFolder(assertInsideRoot(stateOf(e.sender), path))
  })

  ipcMain.handle('menu:context', (e, kind: unknown, targetFolder: unknown): Promise<ContextAction | null> => {
    const k = kind === 'file' || kind === 'folder' ? kind : 'root'
    const where = typeof targetFolder === 'string' ? targetFolder : ''
    return new Promise((done) => {
      const pick = (a: ContextAction) => () => done(a)
      const template: MenuItemConstructorOptions[] = [
        { label: `「${where}」に新規ファイル`, click: pick('newFile') },
        { label: `「${where}」に新規フォルダ`, click: pick('newFolder') }
      ]
      if (k !== 'root') {
        template.push(
          { type: 'separator' },
          { label: '名前を変更', click: pick('rename') },
          { label: isMac ? 'Finder で表示' : 'エクスプローラーで表示', click: pick('reveal') },
          { type: 'separator' },
          { label: 'ゴミ箱に移動', click: pick('trash') }
        )
      }
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      // The callback fires when the menu closes; resolve(null) after the click handler had its chance.
      Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => done(null), 100) })
    })
  })

  ipcMain.handle('entry:trash', async (e, paths: unknown): Promise<boolean> => {
    const st = stateOf(e.sender)
    if (!Array.isArray(paths) || paths.length === 0) return false
    const targets = paths.map((p) => assertInsideRoot(st, p))
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['ゴミ箱に移動', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message:
        targets.length === 1 ? `「${basename(targets[0])}」をゴミ箱に移動しますか?` : `${targets.length} 件をゴミ箱に移動しますか?`
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (res.response !== 0) return false
    for (const t of targets) await shell.trashItem(t)
    return true
  })

  // ---- TODOs -----------------------------------------------------------------
  ipcMain.handle('todo:list', (e): Promise<TodoItem[]> => {
    const st = stateOf(e.sender)
    return st.root ? listMarkdown(todoRoot(st)) : Promise.resolve([])
  })

  ipcMain.handle('todo:subtasks', (e, todoPath: unknown): Promise<TodoItem[]> => {
    return listMarkdown(subtaskDir(assertTodoPath(stateOf(e.sender), todoPath)))
  })

  ipcMain.handle('todo:create', async (e, parent: unknown, title: unknown): Promise<string> => {
    const st = stateOf(e.sender)
    const dir = parent === null ? todoRoot(st) : subtaskDir(assertTodoPath(st, parent))
    const name = assertTodoName(title)
    const target = join(dir, `${name}.md`)
    if (await exists(target)) throw new Error(`「${name}」はすでに存在します。`)
    await mkdir(dir, { recursive: true })
    await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    return target
  })

  ipcMain.handle('todo:complete', async (e, todoPath: unknown): Promise<boolean> => {
    const st = stateOf(e.sender)
    const file = assertTodoPath(st, todoPath)
    const n = await countSubtasks(file)
    if (n > 0) {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts: Electron.MessageBoxOptions = {
        type: 'question',
        buttons: ['サブタスクも完了する', 'キャンセル'],
        defaultId: 1,
        cancelId: 1,
        message: `「${basename(file, extname(file))}」には未完了のサブタスクが ${n} 件あります。`,
        detail: 'サブタスクも完了してよいですか?'
      }
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response !== 0) return false
    }
    await completeTodoTree(st, file)
    return true
  })

  ipcMain.handle('todo:rename', async (e, todoPath: unknown, newName: unknown): Promise<string> => {
    const file = assertTodoPath(stateOf(e.sender), todoPath)
    const name = assertTodoName(newName)
    const dest = join(dirname(file), `${name}.md`)
    if (dest === file) return file
    const dir = subtaskDir(file)
    const destDir = join(dirname(file), name)
    const caseOnly = dest.toLowerCase() === file.toLowerCase()
    if (!caseOnly && ((await exists(dest)) || (await exists(destDir)))) throw new Error(`「${name}」はすでに存在します。`)
    await rename(file, dest)
    if (await exists(dir)) await rename(dir, destDir)
    return dest
  })

  ipcMain.handle('todo:trash', async (e, todoPath: unknown): Promise<boolean> => {
    const st = stateOf(e.sender)
    const file = assertTodoPath(st, todoPath)
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts: Electron.MessageBoxOptions = {
      type: 'warning',
      buttons: ['ゴミ箱に移動', 'キャンセル'],
      defaultId: 1,
      cancelId: 1,
      message: `TODO「${basename(file, extname(file))}」をゴミ箱に移動しますか?`,
      detail: 'サブタスクもまとめて移動されます。'
    }
    const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (res.response !== 0) return false
    const dir = subtaskDir(file)
    if (await exists(file)) await shell.trashItem(file)
    if (await exists(dir)) await shell.trashItem(dir)
    return true
  })

  ipcMain.handle('link:external', async (_e, url: unknown): Promise<void> => {
    if (typeof url !== 'string') throw new Error('invalid url')
    const u = new URL(url.trim())
    if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) throw new Error('unsupported protocol')
    await shell.openExternal(u.toString())
  })

  ipcMain.on('app:close-ready', (e) => {
    stateOf(e.sender).finishClose?.()
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
  else if (cmd === 'open') createWindow()
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'ファイル',
      submenu: [
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
