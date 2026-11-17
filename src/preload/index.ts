import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DocraftApi, MenuCommand } from '../shared/api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: DocraftApi = {
  platform: process.platform,
  openFile: () => invoke('file:open'),
  readFile: (path) => invoke('file:read', path),
  saveFile: (path, content) => invoke('file:save', path, content),
  loadWorkspace: () => invoke('workspace:load'),
  readTree: (root) => invoke('folder:tree', root),
  createEntry: (parent, name) => invoke('entry:create', parent, name),
  renameEntry: (path, newName) => invoke('entry:rename', path, newName),
  moveEntries: (paths, destParent) => invoke('entry:move', paths, destParent),
  showContextMenu: (kind, targetName) => invoke('menu:context', kind, targetName),
  revealEntry: (path) => invoke('entry:reveal', path),
  trashEntries: (paths) => invoke('entry:trash', paths),
  listDaily: () => invoke('daily:list'),
  openDaily: (date) => invoke('daily:open', date),
  listAllTodos: () => invoke('todo:index'),
  listTodos: () => invoke('todo:list'),
  listSubtasks: (todoPath) => invoke('todo:subtasks', todoPath),
  createTodo: (parent, title) => invoke('todo:create', parent, title),
  setTodoDue: (todoPath, due) => invoke('todo:setDue', todoPath, due),
  completeTodo: (todoPath) => invoke('todo:complete', todoPath),
  restoreTodo: (completedPath) => invoke('todo:restore', completedPath),
  renameTodo: (todoPath, newName) => invoke('todo:rename', todoPath, newName),
  trashTodo: (todoPath) => invoke('todo:trash', todoPath),
  openExternal: (url) => invoke('link:external', url),
  onBeforeClose: (handler) => {
    ipcRenderer.on('app:before-close', () => {
      void handler().finally(() => ipcRenderer.send('app:close-ready'))
    })
  },
  setDirty: (dirty) => ipcRenderer.send('state:dirty', dirty),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand): void => cb(cmd)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  }
}

contextBridge.exposeInMainWorld('docraft', api)
