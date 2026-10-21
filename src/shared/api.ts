/** Commands sent from the application menu (main) to the renderer. */
export type MenuCommand = 'new' | 'open' | 'save' | 'saveAs'

export interface OpenedFile {
  path: string
  content: string
}

/** API exposed to the renderer as `window.docraft` via contextBridge. */
export interface DocraftApi {
  platform: string
  /** Show an open dialog. Resolves null when cancelled. */
  openFile(): Promise<OpenedFile | null>
  /**
   * Save content. With path = null (or a path not previously granted by a dialog)
   * a save dialog is shown. Resolves the saved path, or null when cancelled.
   */
  saveFile(path: string | null, content: string): Promise<string | null>
  /** Ask the user whether to discard unsaved changes. */
  confirmDiscard(): Promise<boolean>
  /** Tell main whether the document has unsaved changes (used on window close). */
  setDirty(dirty: boolean): void
  /** Subscribe to menu commands. Returns an unsubscribe function. */
  onMenu(cb: (cmd: MenuCommand) => void): () => void
}
