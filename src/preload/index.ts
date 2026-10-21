import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { DocraftApi, MenuCommand, OpenedFile } from '../shared/api'

const api: DocraftApi = {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke('file:open') as Promise<OpenedFile | null>,
  saveFile: (path, content) => ipcRenderer.invoke('file:save', path, content) as Promise<string | null>,
  confirmDiscard: () => ipcRenderer.invoke('confirm:discard') as Promise<boolean>,
  setDirty: (dirty) => ipcRenderer.send('state:dirty', dirty),
  onMenu: (cb) => {
    const listener = (_e: IpcRendererEvent, cmd: MenuCommand): void => cb(cmd)
    ipcRenderer.on('menu', listener)
    return () => ipcRenderer.removeListener('menu', listener)
  }
}

contextBridge.exposeInMainWorld('docraft', api)
