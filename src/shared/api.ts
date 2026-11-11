/** Commands sent from the application menu (main) to the renderer. */
export type MenuCommand = 'open' | 'save' | 'saveAs'

export interface OpenedFile {
  path: string
  content: string
}

/**
 * A node of the folder tree. `id` is the absolute path.
 * Folders have `children` (possibly empty); files do not.
 */
export interface TreeEntry {
  id: string
  name: string
  children?: TreeEntry[]
}

export interface OpenedFolder {
  root: string
  tree: TreeEntry[]
}

/** A TODO (a Markdown file under `<documents_folder>/.todo`). `id` is the absolute path. */
export interface TodoItem {
  id: string
  /** Title = file name without `.md`. Subtasks in the TODO list are shown by their path, e.g. `買い物/牛乳`. */
  name: string
  /** The TODO's own title (`name` may be a `親/子` path when a subtask is listed with its parents). */
  title: string
  /** Due date `YYYY-MM-DD` from the file's frontmatter (`due:`), or null. */
  due: string | null
}

/** A TODO as the target of a `[[todo:UUID]]` reference. */
export interface TodoRef {
  /** The key: the file name without `.md`. Stays the same when the TODO is renamed or completed. */
  uuid: string
  /** Absolute path of the file (in `.todo`, or in `.todo/.completed` once completed). */
  id: string
  title: string
  completed: boolean
  due: string | null
}

/** What the user picked in the file tree's context menu. */
export type ContextAction = 'newFile' | 'newFolder' | 'rename' | 'reveal' | 'trash'

/** Result of reading ~/.docraft/config.toml. */
export interface WorkspaceInfo {
  /** Absolute path of the config file (shown in the in-app guide). */
  configPath: string
  /** The documents folder and its tree; null when it could not be used. */
  folder: OpenedFolder | null
  /** Why `folder` is null. */
  problem: null | 'no-config' | 'not-set' | 'not-found'
  /** Resolved `documents_folder` value, when one was configured. */
  configuredPath: string | null
}

/** API exposed to the renderer as `window.docraft` via contextBridge. */
export interface DocraftApi {
  platform: string
  /** Show an open dialog. Resolves null when cancelled. */
  openFile(): Promise<OpenedFile | null>
  /** Read a file inside a granted folder (or one previously granted by a dialog). */
  readFile(path: string): Promise<string>
  /**
   * Save content. With path = null (or a path not previously granted)
   * a save dialog is shown. Resolves the saved path, or null when cancelled.
   */
  saveFile(path: string | null, content: string): Promise<string | null>

  /** Read ~/.docraft/config.toml and scan the configured documents folder. */
  loadWorkspace(): Promise<WorkspaceInfo>
  /** Re-scan the granted folder. */
  readTree(root: string): Promise<TreeEntry[]>
  /** Create an empty Markdown file or folder in `parent`. Resolves the new path. */
  createEntry(parent: string, kind: 'file' | 'folder'): Promise<string>
  /** Rename an entry (a file without extension gets `.md`). Resolves the new path. */
  renameEntry(path: string, newName: string): Promise<string>
  /** Move entries into `destDir`. Resolves old path -> new path pairs. */
  moveEntries(paths: string[], destDir: string): Promise<Record<string, string>>
  /**
   * Pop up the native context menu for a tree row (or the empty area = 'root').
   * `targetFolder` is the name of the folder new items would be created in (shown in the menu).
   * Resolves the chosen action, or null when dismissed.
   */
  showContextMenu(kind: 'root' | 'folder' | 'file', targetFolder: string): Promise<ContextAction | null>
  /** Show an entry in the system file manager (Finder). */
  revealEntry(path: string): Promise<void>
  /** Ask for confirmation, then move entries to the trash. Resolves false when cancelled. */
  trashEntries(paths: string[]): Promise<boolean>

  /** Dates (`YYYY-MM-DD`, newest first) that have a daily document `.daily/YYYY/MM/DD.md`. */
  listDaily(): Promise<string[]>
  /** Resolve the daily document of `date` (`YYYY-MM-DD`), creating it when missing. Resolves its path. */
  openDaily(date: string): Promise<string>
  /** Every TODO, open and completed (the targets of `[[todo:UUID]]`). */
  listAllTodos(): Promise<TodoRef[]>
  /** Top-level TODOs (`.todo/<title>.md`) plus subtasks, at any depth, that have a due date. */
  listTodos(): Promise<TodoItem[]>
  /** Subtasks of a TODO: the `.md` files in the folder next to it with the same name. */
  listSubtasks(todoPath: string): Promise<TodoItem[]>
  /** Create a TODO (parent = null) or a subtask of `parent`. Resolves the new file's path. */
  createTodo(parent: string | null, title: string): Promise<string>
  /** Set (or clear with null) the due date of a TODO that is not open in the editor. */
  setTodoDue(todoPath: string, due: string | null): Promise<void>
  /**
   * Complete a TODO or subtask: move it to `.todo/.completed/<same uuid>.md` (with `completed:` and, for a
   * subtask, `parent:` in its frontmatter). When it has subtasks the user is asked first, and they are
   * completed as well. Resolves false when cancelled.
   */
  completeTodo(todoPath: string): Promise<boolean>
  /** Change the title (first heading) of a TODO or subtask; the file itself is not renamed. Resolves its path. */
  renameTodo(todoPath: string, newName: string): Promise<string>
  /** Ask for confirmation, then move a TODO (and its subtask folder) to the trash. Resolves false when cancelled. */
  trashTodo(todoPath: string): Promise<boolean>

  /** Open an http(s) or mailto link in the system browser. */
  openExternal(url: string): Promise<void>

  /** Called when the window is about to close; the handler should save pending changes. */
  onBeforeClose(handler: () => Promise<void>): void
  /** Tell main whether the document has unsaved changes (used on window close). */
  setDirty(dirty: boolean): void
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onMenu(cb: (cmd: MenuCommand) => void): () => void
}
