import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor, type EditorHandle } from './Editor'
import { FileTree } from './FileTree'
import { readmeText } from './welcome'
import { Calendar, DailyList } from './Daily'
import { today } from './dueFormat'
import { SubtaskBar, TodoList } from './Todo'
import { applyDue, applyTitle, parseDue, parseTitle } from '../../shared/frontmatter'
import { buildLinkIndex, type LinkSuggestion } from './links'
import type { MenuCommand, TodoItem, TodoRef, TreeEntry } from '../../shared/api'

const api = window.docraft

/** Idle time after the last edit before the file is saved automatically. */
const AUTOSAVE_DELAY_MS = 2000

const SIDEBAR_MIN = 160
const SIDEBAR_MAX = 520
const SIDEBAR_DEFAULT = 260

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}

function loadSidebarWidth(): number {
  try {
    const n = Number(localStorage.getItem('sidebarWidth'))
    if (n >= SIDEBAR_MIN && n <= SIDEBAR_MAX) return n
  } catch {
    // ignore
  }
  return SIDEBAR_DEFAULT
}

/** Map `path` through a set of renames/moves (a moved folder also moves everything below it). */
function remapPath(path: string, moved: Record<string, string>): string {
  for (const [from, to] of Object.entries(moved)) {
    if (path === from) return to
    if (path.startsWith(from + '/') || path.startsWith(from + '\\')) return to + path.slice(from.length)
  }
  return path
}

export function App() {
  const editorRef = useRef<EditorHandle>(null)

  const [folder, setFolder] = useState<{ root: string; tree: TreeEntry[] } | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  // 'none': nothing open · 'readme': read-only guide (never saved) · 'file': an editable file on disk
  const [mode, setMode] = useState<'none' | 'readme' | 'file'>('none')
  const [openDue, setOpenDue] = useState<string | null>(null) // due date of the open file
  const [openTitle, setOpenTitle] = useState<string | null>(null) // first heading of the open file
  const [dirty, setDirtyState] = useState(false)
  const [sidebarWidth, setSidebarWidth] = useState(loadSidebarWidth)

  // Mirrors of state for use inside long-lived callbacks (menu commands).
  const currentPathRef = useRef(currentPath)
  const dirtyRef = useRef(dirty)
  const folderRootRef = useRef<string | null>(null)
  currentPathRef.current = currentPath
  dirtyRef.current = dirty
  folderRootRef.current = folder?.root ?? null

  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clearAutosaveTimer = useCallback(() => {
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current)
    autosaveTimer.current = null
  }, [])

  const setDirty = useCallback((value: boolean) => {
    if (dirtyRef.current === value) return
    dirtyRef.current = value
    setDirtyState(value)
    api.setDirty(value)
  }, [])

  // ---- Folder -------------------------------------------------------------
  // The documents folder comes from ~/.docraft/config.toml. Without one, show the in-app README.
  useEffect(() => {
    let cancelled = false
    void api.loadWorkspace().then((info) => {
      if (cancelled) return
      if (info.folder) setFolder({ root: info.folder.root, tree: info.folder.tree })
      else if (!dirtyRef.current && !currentPathRef.current) {
        editorRef.current?.setDoc(readmeText(info), { readOnly: true })
        setMode('readme')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshTree = useCallback(async () => {
    const root = folderRootRef.current
    if (!root) return
    const tree = await api.readTree(root)
    setFolder((f) => (f && f.root === root ? { root, tree } : f))
  }, [])

  // ---- Documents ----------------------------------------------------------
  const loadDocument = useCallback(
    (path: string | null, content: string) => {
      currentPathRef.current = path
      setCurrentPath(path)
      setMode('file')
      setOpenDue(parseDue(content))
      setOpenTitle(parseTitle(content))
      editorRef.current?.setDoc(content)
      clearAutosaveTimer()
      setDirty(false)
    },
    [setDirty, clearAutosaveTimer]
  )

  /**
   * Write pending changes to the current file. Documents without a path (Untitled) are not
   * autosaved, since that would require a save dialog.
   */
  const flushSave = useCallback(async (): Promise<void> => {
    clearAutosaveTimer()
    const path = currentPathRef.current
    if (!dirtyRef.current || !path) return
    const text = editorRef.current?.getDoc() ?? ''
    await api.saveFile(path, text)
    // Typing may have continued during the write; only clear the flag if nothing changed.
    if (currentPathRef.current === path && editorRef.current?.getDoc() === text) setDirty(false)
  }, [clearAutosaveTimer, setDirty])

  /** Close the editor: no document is open afterwards. */
  const closeDocument = useCallback(() => {
    clearAutosaveTimer()
    currentPathRef.current = null
    setCurrentPath(null)
    setMode('none')
    setOpenDue(null)
    setOpenTitle(null)
    editorRef.current?.setDoc('')
    setDirty(false)
  }, [clearAutosaveTimer, setDirty])

  const confirmIfDirty = useCallback(async (): Promise<boolean> => {
    try {
      await flushSave()
      return true
    } catch (err) {
      alert(`保存できませんでした: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }, [flushSave])

  // Set later (TODO section): refresh the TODO lists after a save, since the file may have changed its due date.
  const afterAutosaveRef = useRef<() => void>(() => undefined)

  const onDocChange = useCallback(() => {
    setDirty(true)
    const text = editorRef.current?.getDoc() ?? ''
    setOpenDue(parseDue(text))
    setOpenTitle(parseTitle(text))
    clearAutosaveTimer()
    autosaveTimer.current = setTimeout(() => {
      flushSave()
        .then(() => afterAutosaveRef.current())
        .catch((err) => console.error('autosave failed', err))
    }, AUTOSAVE_DELAY_MS)
  }, [setDirty, clearAutosaveTimer, flushSave])

  const flushSaveRef = useRef(flushSave)
  flushSaveRef.current = flushSave
  useEffect(() => {
    api.onBeforeClose(() => flushSaveRef.current().catch((err) => console.error('save on close failed', err)))
  }, [])

  const openPath = useCallback(
    async (path: string) => {
      if (path === currentPathRef.current) return
      if (!(await confirmIfDirty())) return
      loadDocument(path, await api.readFile(path))
    },
    [confirmIfDirty, loadDocument]
  )

  const save = useCallback(async (asNew: boolean) => {
    if (!currentPathRef.current) return // nothing open (or the read-only README)
    const saved = await api.saveFile(asNew ? null : currentPathRef.current, editorRef.current?.getDoc() ?? '')
    if (saved) {
      currentPathRef.current = saved
      setCurrentPath(saved)
      setDirty(false)
      void refreshTree().catch(() => undefined)
    }
  }, [refreshTree, setDirty])

  const commands: Record<MenuCommand, () => Promise<void>> = {
    async open() {
      if (!(await confirmIfDirty())) return
      const file = await api.openFile()
      if (file) loadDocument(file.path, file.content)
    },
    save: () => save(false),
    saveAs: () => save(true)
  }
  const commandsRef = useRef(commands)
  commandsRef.current = commands

  useEffect(
    () =>
      api.onMenu((cmd) => {
        commandsRef.current[cmd]().catch((err) => {
          console.error(err)
          alert(`エラー: ${err instanceof Error ? err.message : String(err)}`)
        })
      }),
    []
  )

  // ---- TODOs (<root>/.todo) ---------------------------------------------------
  const [todos, setTodos] = useState<TodoItem[]>([])
  const [subtasks, setSubtasks] = useState<TodoItem[]>([])
  const root = folder?.root ?? null
  const todoPrefix = root ? `${root}${root.includes('\\') ? '\\' : '/'}.todo${root.includes('\\') ? '\\' : '/'}` : null
  const completedPrefix = todoPrefix ? `${todoPrefix}.completed${todoPrefix.endsWith('\\') ? '\\' : '/'}` : null
  const inTodoDir = !!(todoPrefix && currentPath && currentPath.startsWith(todoPrefix) && currentPath.toLowerCase().endsWith('.md'))
  const inCompleted = !!(completedPrefix && currentPath?.startsWith(completedPrefix))
  const inTodo = inTodoDir && !inCompleted // an open (not completed) TODO or subtask

  // ---- Window title: TODOs are named by their title (their file name is a UUID) ----
  const name = inTodoDir ? (openTitle ?? '無題') : currentPath ? baseName(currentPath) : mode === 'readme' ? 'README' : 'Docraft'
  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${name} — Docraft`
  }, [name, dirty])

  const report = (err: unknown): void => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`)

  const [todoRefs, setTodoRefs] = useState<TodoRef[]>([])
  const refreshTodos = useCallback(async () => {
    if (!folderRootRef.current) return
    const [list, refs] = await Promise.all([api.listTodos(), api.listAllTodos()])
    setTodos(list)
    setTodoRefs(refs)
  }, [])

  const refreshSubtasks = useCallback(async () => {
    const cur = currentPathRef.current
    setSubtasks(cur && inTodoRef.current ? await api.listSubtasks(cur) : [])
  }, [])
  const inTodoRef = useRef(inTodo)
  inTodoRef.current = inTodo

  useEffect(() => {
    void refreshTodos().catch(() => undefined)
    // Pick up files added or removed outside the app.
    const onFocus = (): void => {
      void refreshTodos().catch(() => undefined)
      void refreshSubtasks().catch(() => undefined)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [root, refreshTodos, refreshSubtasks])

  useEffect(() => {
    void refreshSubtasks().catch(() => setSubtasks([]))
    void refreshTodos().catch(() => undefined)
  }, [currentPath, inTodo, refreshSubtasks, refreshTodos])

  afterAutosaveRef.current = () => {
    if (!inTodoRef.current) return
    void refreshTodos().catch(() => undefined)
    void refreshSubtasks().catch(() => undefined)
  }

  const setTodoDue = useCallback(
    async (path: string, due: string | null) => {
      if (path === currentPathRef.current && editorRef.current) {
        // Open in the editor: edit the text there (autosave writes it) so nothing is overwritten.
        editorRef.current.replaceDoc(applyDue(editorRef.current.getDoc(), due))
        await flushSave()
      } else {
        await api.setTodoDue(path, due)
      }
      await Promise.all([refreshTodos(), refreshSubtasks()])
    },
    [flushSave, refreshTodos, refreshSubtasks]
  )

  const createTodo = useCallback(
    async (parent: string | null, title: string) => {
      const path = await api.createTodo(parent, title)
      await Promise.all([refreshTodos(), refreshSubtasks()])
      await openPath(path)
    },
    [refreshTodos, refreshSubtasks, openPath]
  )

  /** True when the open document is `path` or lives in its subtask folder. */
  const isOpenWithin = (path: string): boolean => {
    const cur = currentPathRef.current
    const dir = path.replace(/\.md$/i, '')
    return !!cur && (cur === path || cur.startsWith(dir + '/') || cur.startsWith(dir + '\\'))
  }

  const completeTodo = useCallback(
    async (path: string) => {
      await flushSave() // pending edits must reach the file before it is moved
      if (!(await api.completeTodo(path))) return
      if (isOpenWithin(path)) closeDocument()
      await Promise.all([refreshTodos(), refreshSubtasks()])
    },
    [flushSave, closeDocument, refreshTodos, refreshSubtasks]
  )

  /** Rename = change the title heading. The file keeps its UUID name, so references stay valid. */
  const renameTodo = useCallback(
    async (path: string, title: string) => {
      await flushSave()
      if (path === currentPathRef.current && editorRef.current) {
        // Open in the editor: edit the text there (autosave writes it) so nothing is overwritten.
        editorRef.current.replaceDoc(applyTitle(editorRef.current.getDoc(), title))
        await flushSave()
      } else {
        await api.renameTodo(path, title)
      }
      await Promise.all([refreshTodos(), refreshSubtasks()])
    },
    [flushSave, refreshTodos, refreshSubtasks]
  )

  const trashTodo = useCallback(
    async (path: string) => {
      await flushSave()
      if (!(await api.trashTodo(path))) return
      const dir = path.replace(/\.md$/i, '')
      const cur = currentPathRef.current
      if (cur && (cur === path || cur.startsWith(dir + '/') || cur.startsWith(dir + '\\'))) closeDocument()
      await Promise.all([refreshTodos(), refreshSubtasks()])
    },
    [flushSave, closeDocument, refreshTodos, refreshSubtasks]
  )

  // ---- Daily documents (<root>/.daily/YYYY/MM/DD.md) -----------------------------
  const [dailyDates, setDailyDates] = useState<string[]>([])
  const [calendarOpen, setCalendarOpen] = useState(false)

  const refreshDaily = useCallback(async () => {
    if (!folderRootRef.current) return
    setDailyDates(await api.listDaily())
  }, [])

  useEffect(() => {
    void refreshDaily().catch(() => undefined)
    window.addEventListener('focus', refreshDaily as () => void)
    return () => window.removeEventListener('focus', refreshDaily as () => void)
  }, [root, refreshDaily])

  // Opening any document (e.g. from the sidebar) dismisses the calendar.
  useEffect(() => setCalendarOpen(false), [currentPath])

  const openDay = useCallback(
    async (date: string) => {
      const path = await api.openDaily(date) // creates the document when it does not exist yet
      await openPath(path)
      setCalendarOpen(false)
      await refreshDaily()
    },
    [openPath, refreshDaily]
  )

  // The date of the open document when it is a daily document.
  const activeDate = (() => {
    const m = currentPath ? /[\\/]\.daily[\\/](\d{4})[\\/](\d{2})[\\/](\d{2})\.md$/.exec(currentPath) : null
    return m && root && currentPath?.startsWith(root) ? `${m[1]}-${m[2]}-${m[3]}` : null
  })()

  // ---- Wiki links ([[name]]) ------------------------------------------------
  const linkIndex = useMemo(() => (folder ? buildLinkIndex(folder.root, folder.tree) : null), [folder])
  // `[[todo:UUID]]` points at a TODO by its key; everything else is a document name.
  const todoByUuid = useMemo(() => new Map(todoRefs.map((r) => [r.uuid.toLowerCase(), r])), [todoRefs])
  const todoOf = useCallback(
    (name: string): TodoRef | null => {
      const m = /^todo:\s*([0-9a-f-]{36})$/i.exec(name.trim())
      return m ? (todoByUuid.get(m[1].toLowerCase()) ?? null) : null
    },
    [todoByUuid]
  )
  // `[[YYYY-MM-DD]]` points at that day's daily document (created on open when missing).
  const dailyLinkDate = useCallback((name: string): string | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name.trim())
    if (!m) return null
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dt = new Date(y, mo - 1, d)
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d ? name.trim() : null
  }, [])
  const resolveLink = useCallback(
    (name: string) => {
      if (/^todo:/i.test(name.trim())) return todoOf(name)?.id ?? null
      const date = dailyLinkDate(name)
      if (date && root) return `${root.replace(/[\\/]+$/, '')}/.daily/${date.slice(0, 4)}/${date.slice(5, 7)}/${date.slice(8, 10)}.md`
      return linkIndex?.resolve(name, currentPath) ?? null
    },
    [linkIndex, currentPath, todoOf, dailyLinkDate, root]
  )
  const todoInfo = useCallback(
    (uuid: string) => {
      const r = todoByUuid.get(uuid.toLowerCase())
      return r ? { title: r.title, completed: r.completed } : null
    },
    [todoByUuid]
  )
  const searchLinks = useCallback(
    (q: string): LinkSuggestion[] => {
      const norm = (t: string): string => t.normalize('NFC').toLowerCase()
      const todoOnly = /^todo:/i.test(q.trim())
      const query = norm(todoOnly ? q.trim().slice(5).trim() : q.trim())
      const todos = todoRefs
        .filter((r) => norm(r.title).startsWith(query))
        .sort((a, b) => Number(a.completed) - Number(b.completed) || a.title.localeCompare(b.title, 'ja', { numeric: true }))
        .map((r) => ({ name: r.title, folder: r.completed ? 'TODO(完了)' : 'TODO', insert: `todo:${r.uuid}` }))
      return (todoOnly ? todos : [...(linkIndex?.search(q) ?? []), ...todos]).slice(0, 50)
    },
    [linkIndex, todoRefs]
  )
  const onOpenLink = useCallback(
    (name: string) => {
      const date = dailyLinkDate(name)
      if (date) {
        void openDay(date).catch((err) => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`))
        return
      }
      const target = resolveLink(name)
      if (target) void openPath(target).catch((err) => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`))
    },
    [resolveLink, openPath, dailyLinkDate, openDay]
  )

  // ---- Tree callbacks -----------------------------------------------------
  const onPathsMoved = useCallback((moved: Record<string, string>) => {
    const cur = currentPathRef.current
    if (!cur) return
    const next = remapPath(cur, moved)
    if (next !== cur) {
      currentPathRef.current = next
      setCurrentPath(next)
    }
  }, [])

  const onPathsTrashed = useCallback(
    (paths: string[]) => {
      const cur = currentPathRef.current
      if (!cur) return
      const gone = paths.some((p) => cur === p || cur.startsWith(p + '/') || cur.startsWith(p + '\\'))
      if (gone) {
        // The file is in the trash: close the editor.
        closeDocument()
      }
    },
    [closeDocument]
  )

  // ---- Sidebar resize -----------------------------------------------------
  const startResize = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    let w = startW
    const move = (ev: PointerEvent): void => {
      w = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startW + ev.clientX - startX))
      setSidebarWidth(w)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      try {
        localStorage.setItem('sidebarWidth', String(w))
      } catch {
        // ignore
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <>
      <header id="titlebar">
        <span id="doc-name">{name}</span>
        {dirty && <span id="dirty-dot">●</span>}
      </header>
      <div id="body">
        {folder && (
          <>
            <div id="sidebar-wrap" style={{ width: sidebarWidth }}>
              <DailyList
                dates={dailyDates}
                activeDate={activeDate}
                onOpen={(d) => void openDay(d).catch(report)}
                onOpenCalendar={() => setCalendarOpen(true)}
              />
              <TodoList
                items={todos}
                activePath={currentPath}
                onOpen={(p) => void openPath(p).catch(report)}
                onCreate={(t) => void createTodo(null, t).catch(report)}
                onComplete={(p) => void completeTodo(p).catch(report)}
                onRename={(p, t) => void renameTodo(p, t).catch(report)}
                onSetDue={(p, d) => void setTodoDue(p, d).catch(report)}
                onTrash={(p) => void trashTodo(p).catch(report)}
              />
              <FileTree
                root={folder.root}
                data={folder.tree}
                activePath={currentPath}
                onOpenFile={(p) => void openPath(p).catch((err) => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`))}
                onRefresh={refreshTree}
                onPathsMoved={onPathsMoved}
                onPathsTrashed={onPathsTrashed}
              />
            </div>
            <div id="sidebar-resizer" onPointerDown={startResize} />
          </>
        )}
        <div id="editor-col">
        {calendarOpen && (
          <Calendar
            dates={dailyDates}
            activeDate={activeDate ?? today()}
            onOpen={(d) => void openDay(d).catch(report)}
            onClose={() => setCalendarOpen(false)}
          />
        )}
        {inTodo && currentPath && (
          <SubtaskBar
            title={openTitle ?? '無題'}
            items={subtasks}
            onOpen={(p) => void openPath(p).catch(report)}
            onCreate={(t) => void createTodo(currentPath, t).catch(report)}
            onComplete={(p) => void completeTodo(p).catch(report)}
            onRename={(p, t) => void renameTodo(p, t).catch(report)}
            onSetDue={(p, d) => void setTodoDue(p, d).catch(report)}
            due={openDue}
            onCompleteSelf={() => void completeTodo(currentPath).catch(report)}
            onSetOwnDue={(d) => void setTodoDue(currentPath, d).catch(report)}
            onOpenParent={
              dirName(currentPath) !== todoPrefix?.slice(0, -1)
                ? () => void openPath(dirName(currentPath) + '.md').catch(report)
                : null
            }
          />
        )}
        {mode === 'none' && <div id="empty-state">ファイルを選択してください</div>}
        <Editor
          ref={editorRef}
          initialDoc=""
          baseDir={currentPath ? dirName(currentPath) : null}
          hidden={mode === 'none'}
          onDocChange={onDocChange}
          resolveLink={resolveLink}
          onOpenLink={onOpenLink}
          searchLinks={searchLinks}
          todoInfo={todoInfo}
        />
        </div>
      </div>
    </>
  )
}
