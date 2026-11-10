import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Editor, type EditorHandle } from './Editor'
import { FileTree } from './FileTree'
import { readmeText } from './welcome'
import { SubtaskBar, TodoList } from './Todo'
import { buildLinkIndex } from './links'
import type { MenuCommand, TodoItem, TreeEntry } from '../../shared/api'

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

  // ---- Window title -------------------------------------------------------
  const name = currentPath ? baseName(currentPath) : mode === 'readme' ? 'README' : 'Docraft'
  useEffect(() => {
    document.title = `${dirty ? '● ' : ''}${name} — Docraft`
  }, [name, dirty])

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

  const onDocChange = useCallback(() => {
    setDirty(true)
    clearAutosaveTimer()
    autosaveTimer.current = setTimeout(() => {
      flushSave().catch((err) => console.error('autosave failed', err))
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
  const inTodo = !!(todoPrefix && currentPath && currentPath.startsWith(todoPrefix) && currentPath.toLowerCase().endsWith('.md'))
  const report = (err: unknown): void => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`)

  const refreshTodos = useCallback(async () => {
    if (!folderRootRef.current) return
    setTodos(await api.listTodos())
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
  }, [currentPath, inTodo, refreshSubtasks])

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

  const renameTodo = useCallback(
    async (path: string, title: string) => {
      await flushSave()
      const next = await api.renameTodo(path, title)
      if (next === path) return
      const moved = { [path]: next, [path.replace(/\.md$/i, '')]: next.replace(/\.md$/i, '') }
      const cur = currentPathRef.current
      if (cur) {
        const mapped = remapPath(cur, moved)
        if (mapped !== cur) {
          currentPathRef.current = mapped
          setCurrentPath(mapped)
        }
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

  // ---- Wiki links ([[name]]) ------------------------------------------------
  const linkIndex = useMemo(() => (folder ? buildLinkIndex(folder.root, folder.tree) : null), [folder])
  const resolveLink = useCallback(
    (name: string) => linkIndex?.resolve(name, currentPath) ?? null,
    [linkIndex, currentPath]
  )
  const onOpenLink = useCallback(
    (name: string) => {
      const target = linkIndex?.resolve(name, currentPathRef.current)
      if (target) void openPath(target).catch((err) => alert(`エラー: ${err instanceof Error ? err.message : String(err)}`))
    },
    [linkIndex, openPath]
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
              <TodoList
                items={todos}
                activePath={currentPath}
                onOpen={(p) => void openPath(p).catch(report)}
                onCreate={(t) => void createTodo(null, t).catch(report)}
                onComplete={(p) => void completeTodo(p).catch(report)}
                onRename={(p, t) => void renameTodo(p, t).catch(report)}
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
        {inTodo && currentPath && (
          <SubtaskBar
            title={baseName(currentPath).replace(/\.md$/i, '')}
            items={subtasks}
            onOpen={(p) => void openPath(p).catch(report)}
            onCreate={(t) => void createTodo(currentPath, t).catch(report)}
            onComplete={(p) => void completeTodo(p).catch(report)}
            onRename={(p, t) => void renameTodo(p, t).catch(report)}
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
        />
        </div>
      </div>
    </>
  )
}
