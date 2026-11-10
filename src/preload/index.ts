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
  createEntry: (parent, kind) => invoke('entry:create', parent, kind),
  renameEntry: (path, newName) => invoke('entry:rename', path, newName),
  moveEntries: (paths, destDir) => invoke('entry:move', paths, destDir),
  showContextMenu: (kind, targetFolder) => invoke('menu:context', kind, targetFolder),
  revealEntry: (path) => invoke('entry:reveal', path),
  trashEntries: (paths) => invoke('entry:trash', paths),
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
