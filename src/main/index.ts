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
import { access, cp, mkdir, readdir, readFile, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import { applyKey, applyTitle, applyDue, isDueString, isUuid, parseDue, parseKey, parseTitle, splitFrontmatter } from '../shared/frontmatter'
import type { ContextAction, MenuCommand, OpenedFile, TodoItem, TodoRef, TreeEntry, WorkspaceInfo } from '../shared/api'

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
// TODOs: <root>/.todo/<uuid>.md, subtasks in <root>/.todo/<parent uuid>/<uuid>.md
//
// The key of a TODO is the UUID in its file name; its title is the first `# heading` of the file.
// Completed TODOs keep their UUID: <root>/.todo/.completed/<uuid>.md (`completed:` date, `parent:` uuid).
// ---------------------------------------------------------------------------
const TODO_DIR = '.todo'
const COMPLETED_DIR = '.completed'
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000
const UNTITLED = '無題'

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

/** A TODO title: one non-empty line of text. */
function assertTitle(title: unknown): string {
  if (typeof title !== 'string') throw new Error('invalid title')
  const t = title.replace(/\s+/g, ' ').trim()
  if (!t) throw new Error('invalid title')
  return t
}

/** The folder that holds a TODO's subtasks: same path without `.md`. */
function subtaskDir(todoPath: string): string {
  return join(dirname(todoPath), basename(todoPath, extname(todoPath)))
}

const localYmd = (d = new Date()): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Title (first heading) of a TODO file. */
async function titleOf(file: string): Promise<string> {
  return parseTitle(await readFile(file, 'utf8').catch(() => '')) ?? UNTITLED
}

/** Markdown files directly in `dir`. With `withMeta`, `name` is the title and `due` is read from the file. */
async function listMarkdown(dir: string, withMeta = false): Promise<TodoItem[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const items = await Promise.all(
    entries
      .filter((e) => e.isFile() && !e.name.startsWith('.') && MD_EXTS.has(extname(e.name).toLowerCase()))
      .map(async (e): Promise<TodoItem> => {
        const id = join(dir, e.name)
        if (!withMeta) {
          const base = basename(e.name, extname(e.name))
          return { id, name: base, title: base, due: null }
        }
        const text = await readFile(id, 'utf8').catch(() => '')
        const title = parseTitle(text) ?? UNTITLED
        return { id, name: title, title, due: parseDue(text) }
      })
  )
  return items.sort(byDue)
}

/** Earliest due date first; TODOs without one follow, by title. */
function byDue(a: TodoItem, b: TodoItem): number {
  if (a.due !== b.due) return a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1
  return a.name.localeCompare(b.name, 'ja', { numeric: true })
}

/**
 * Entries of the TODO list: every top-level TODO, plus subtasks (at any depth) that have a due date.
 * A subtask is named by the titles on its way down, e.g. `買い物/牛乳`.
 */
async function listTodoEntries(root: string): Promise<TodoItem[]> {
  const out: TodoItem[] = []
  const walk = async (items: TodoItem[], prefix: string): Promise<void> => {
    for (const t of items) {
      const name = prefix + t.name
      if (prefix === '' || t.due) out.push({ ...t, name })
      await walk(await listMarkdown(subtaskDir(t.id), true), name + '/')
    }
  }
  await walk(await listMarkdown(root, true), '')
  return out.sort(byDue)
}

/** Every TODO, open and completed, for resolving and completing `[[todo:UUID]]` references. */
async function listAllTodos(root: string): Promise<TodoRef[]> {
  const out: TodoRef[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const t of await listMarkdown(dir, true)) {
      out.push({ uuid: basename(t.id, extname(t.id)), id: t.id, title: t.name, completed: false, due: t.due })
      await walk(subtaskDir(t.id))
    }
  }
  const base = join(root, TODO_DIR)
  await walk(base)
  for (const t of await listMarkdown(join(base, COMPLETED_DIR), true)) {
    out.push({ uuid: basename(t.id, extname(t.id)), id: t.id, title: t.name, completed: true, due: t.due })
  }
  return out
}

/** Number of subtasks below a TODO, at any depth. */
async function countSubtasks(todoPath: string): Promise<number> {
  let n = 0
  for (const c of await listMarkdown(subtaskDir(todoPath))) n += 1 + (await countSubtasks(c.id))
  return n
}

/**
 * Move a TODO and all of its subtasks to `.completed/<same uuid>.md`. Each file gets
 * `completed: <today>` (used for the 30-day purge) and, for a subtask, `parent: <parent uuid>`.
 */
async function completeTodoTree(st: WindowState, file: string): Promise<void> {
  const base = todoRoot(st)
  const completedDir = join(base, COMPLETED_DIR)
  await mkdir(completedDir, { recursive: true })
  const walk = async (f: string): Promise<void> => {
    for (const c of await listMarkdown(subtaskDir(f))) await walk(c.id)
    let text = await readFile(f, 'utf8')
    if (parseTitle(text) === null) text = applyTitle(text, UNTITLED)
    text = applyKey(text, 'completed', localYmd())
    if (dirname(f) !== base) text = applyKey(text, 'parent', basename(dirname(f)))
    const uuid = basename(f, extname(f))
    await writeFile(join(completedDir, `${isUuid(uuid) ? uuid : randomUUID()}.md`), text, { encoding: 'utf8', flag: 'wx' })
    await unlink(f)
    await rmdir(subtaskDir(f)).catch(() => undefined) // only succeeds when empty
  }
  await walk(file)
}

/** UUIDs mentioned as `[[todo:UUID]]` anywhere in the documents folder (hidden folders included). */
async function collectTodoRefs(root: string): Promise<Set<string>> {
  const refs = new Set<string>()
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!IGNORED_DIRS.has(e.name) && !e.name.startsWith(`${TODO_DIR}-backup-`)) await walk(full)
      } else if (e.isFile() && MD_EXTS.has(extname(e.name).toLowerCase())) {
        const text = await readFile(full, 'utf8').catch(() => '')
        for (const m of text.matchAll(/\[\[todo:([0-9a-f-]{36})/gi)) refs.add(m[1].toLowerCase())
      }
    }
  }
  await walk(root)
  return refs
}

/**
 * Delete completed TODOs older than 30 days (by their `completed:` date, else the file's mtime),
 * unless some document still refers to them with `[[todo:UUID]]`. Runs once at startup.
 */
async function purgeCompleted(root: string): Promise<void> {
  const dir = join(root, TODO_DIR, COMPLETED_DIR)
  const now = Date.now()
  const expired: string[] = []
  for (const item of await listMarkdown(dir)) {
    try {
      const done = parseKey(await readFile(item.id, 'utf8'), 'completed')
      const at = done && /^\d{4}-\d{2}-\d{2}$/.test(done) ? new Date(`${done}T00:00:00`).getTime() : (await stat(item.id)).mtimeMs
      if (now - at > COMPLETED_TTL_MS) expired.push(item.id)
    } catch {
      // ignore files that vanish
    }
  }
  if (expired.length === 0) return
  const refs = await collectTodoRefs(root)
  for (const f of expired) {
    if (refs.has(basename(f, extname(f)).toLowerCase())) continue
    await unlink(f).catch(() => undefined)
  }
}

/** True when `dir` (below `.todo`) still holds Markdown files whose names are not UUIDs. */
async function hasLegacyTodos(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    if (e.isFile() && MD_EXTS.has(extname(e.name).toLowerCase())) {
      if (!isUuid(basename(e.name, extname(e.name)))) return true
    } else if (e.isDirectory() && (await hasLegacyTodos(join(dir, e.name)))) return true
  }
  return false
}

/** Rename `<title>.md` (and its subtask folder `<title>/`) to UUIDs; the old name becomes the `# title`. */
async function migrateTodoDir(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || !e.isFile() || !MD_EXTS.has(extname(e.name).toLowerCase())) continue
    const oldBase = basename(e.name, extname(e.name))
    if (isUuid(oldBase)) continue
    const id = randomUUID()
    const oldFile = join(dir, e.name)
    const oldSub = join(dir, oldBase)
    if ((await stat(oldSub).catch(() => null))?.isDirectory()) await rename(oldSub, join(dir, id))
    const { front, body } = splitFrontmatter(await readFile(oldFile, 'utf8'))
    await writeFile(join(dir, `${id}.md`), `${front}# ${oldBase}\n\n${body}`, { encoding: 'utf8', flag: 'wx' })
    await unlink(oldFile)
  }
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory() && !e.name.startsWith('.')) await migrateTodoDir(join(dir, e.name))
  }
}

/** One-time conversion of title-named TODO files; a copy of `.todo` is kept next to it first. */
async function migrateTodos(root: string): Promise<void> {
  const dir = join(root, TODO_DIR)
  if (!(await hasLegacyTodos(dir))) return
  const d = new Date()
  const stamp = `${localYmd(d).replace(/-/g, '')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`
  await cp(dir, join(root, `${TODO_DIR}-backup-${stamp}`), { recursive: true })
  await migrateTodoDir(dir)
}

// ---------------------------------------------------------------------------
// Daily documents: <root>/.daily/YYYY/MM/DD.md
// ---------------------------------------------------------------------------
const DAILY_DIR = '.daily'

/** Path of the daily document of `date` (`YYYY-MM-DD`, a real calendar date). */
function dailyFile(st: WindowState, date: unknown): string {
  if (!st.root) throw new Error('documents folder is not set')
  const m = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null
  if (!m) throw new Error('invalid date')
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new Error('invalid date')
  return join(st.root, DAILY_DIR, m[1], m[2], `${m[3]}.md`)
}

async function listDailyDates(root: string): Promise<string[]> {
  const dates: string[] = []
  const base = join(root, DAILY_DIR)
  const names = async (dir: string): Promise<string[]> => readdir(dir).catch(() => [] as string[])
  for (const y of await names(base)) {
    if (!/^\d{4}$/.test(y)) continue
    for (const mo of await names(join(base, y))) {
      if (!/^\d{2}$/.test(mo)) continue
      for (const f of await names(join(base, y, mo))) {
        const d = /^(\d{2})\.md$/.exec(f)
        if (d) dates.push(`${y}-${mo}-${d[1]}`)
      }
    }
  }
  return dates.sort().reverse()
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
let todoMigration: Promise<void> | null = null
let completedPurge: Promise<void> | null = null

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
    // Once per run: convert legacy TODO files (awaited, so the lists see the result), then purge old ones.
    todoMigration ??= migrateTodos(root).catch((err) => console.error('TODO migration failed:', err))
    await todoMigration
    completedPurge ??= todoMigration.then(() => purgeCompleted(root)).catch(() => undefined)
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

  // ---- Daily documents ------------------------------------------------------
  ipcMain.handle('daily:list', (e): Promise<string[]> => {
    const st = stateOf(e.sender)
    return st.root ? listDailyDates(st.root) : Promise.resolve([])
  })

  ipcMain.handle('daily:open', async (e, date: unknown): Promise<string> => {
    const file = dailyFile(stateOf(e.sender), date)
    if (!(await exists(file))) {
      let content = `# ${date as string}\n\n`
      // A new document for today lists the open TODOs that are due today or earlier (as `[[todo:UUID]]`).
      if (date === localYmd()) {
        const due = (await listAllTodos(stateOf(e.sender).root as string))
          .filter((t) => !t.completed && t.due !== null && t.due <= (date as string))
          .sort((a, b) => (a.due as string).localeCompare(b.due as string) || a.title.localeCompare(b.title, 'ja', { numeric: true }))
        if (due.length > 0) content += `## 期限のTODO\n\n${due.map((t) => `- [[todo:${t.uuid}]]`).join('\n')}\n\n`
      }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, content, { encoding: 'utf8', flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err
      })
    }
    return file
  })

  // ---- TODOs -----------------------------------------------------------------
  ipcMain.handle('todo:list', (e): Promise<TodoItem[]> => {
    const st = stateOf(e.sender)
    return st.root ? listTodoEntries(todoRoot(st)) : Promise.resolve([])
  })

  ipcMain.handle('todo:subtasks', (e, todoPath: unknown): Promise<TodoItem[]> => {
    return listMarkdown(subtaskDir(assertTodoPath(stateOf(e.sender), todoPath)), true)
  })

  ipcMain.handle('todo:create', async (e, parent: unknown, title: unknown): Promise<string> => {
    const st = stateOf(e.sender)
    const dir = parent === null ? todoRoot(st) : subtaskDir(assertTodoPath(st, parent))
    const name = assertTitle(title)
    const target = join(dir, `${randomUUID()}.md`) // the UUID is the TODO's key; the title lives in the file
    await mkdir(dir, { recursive: true })
    await writeFile(target, `# ${name}\n\n`, { encoding: 'utf8', flag: 'wx' })
    return target
  })

  ipcMain.handle('todo:setDue', async (e, todoPath: unknown, due: unknown): Promise<void> => {
    const file = assertTodoPath(stateOf(e.sender), todoPath)
    if (due !== null && !isDueString(due)) throw new Error('invalid date')
    await writeFile(file, applyDue(await readFile(file, 'utf8'), due), 'utf8')
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
        message: `「${await titleOf(file)}」には未完了のサブタスクが ${n} 件あります。`,
        detail: 'サブタスクも完了してよいですか?'
      }
      const res = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
      if (res.response !== 0) return false
    }
    await completeTodoTree(st, file)
    return true
  })

  // Renaming only rewrites the title heading: the file (and so the TODO's key) stays where it is.
  ipcMain.handle('todo:rename', async (e, todoPath: unknown, newTitle: unknown): Promise<string> => {
    const file = assertTodoPath(stateOf(e.sender), todoPath)
    await writeFile(file, applyTitle(await readFile(file, 'utf8'), assertTitle(newTitle)), 'utf8')
    return file
  })

  ipcMain.handle('todo:index', (e): Promise<TodoRef[]> => {
    const st = stateOf(e.sender)
    return st.root ? listAllTodos(st.root) : Promise.resolve([])
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
      message: `TODO「${await titleOf(file)}」をゴミ箱に移動しますか?`,
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
