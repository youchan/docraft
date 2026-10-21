import './styles.css'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { livePreview } from './editor/livePreview'
import { docraftHighlight } from './editor/highlight'
import { welcomeText } from './welcome'
import type { MenuCommand } from '../../shared/api'

const api = window.docraft
document.body.classList.add(`platform-${api.platform}`)

// ---------------------------------------------------------------------------
// Document state
// ---------------------------------------------------------------------------
let currentPath: string | null = null
let dirty = false

const nameEl = document.getElementById('doc-name')!
const dotEl = document.getElementById('dirty-dot')!

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

function dirName(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(0, i) : ''
}

function refreshTitle(): void {
  const name = currentPath ? baseName(currentPath) : 'Untitled'
  nameEl.textContent = name
  dotEl.hidden = !dirty
  document.title = `${dirty ? '● ' : ''}${name} — Docraft`
}

function setDirty(value: boolean): void {
  if (dirty === value) return
  dirty = value
  api.setDirty(value)
  refreshTitle()
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(docraftHighlight),
      EditorView.lineWrapping,
      livePreview({ baseDir: () => (currentPath ? dirName(currentPath) : null) }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setDirty(true)
      })
    ]
  })
}

const view = new EditorView({
  state: createState(welcomeText),
  parent: document.getElementById('editor')!
})
view.focus()

function loadDocument(path: string | null, content: string): void {
  currentPath = path
  view.setState(createState(content))
  setDirty(false)
  refreshTitle()
  view.focus()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
async function confirmIfDirty(): Promise<boolean> {
  return !dirty || (await api.confirmDiscard())
}

const commands: Record<MenuCommand, () => Promise<void>> = {
  async new() {
    if (await confirmIfDirty()) loadDocument(null, '')
  },
  async open() {
    if (!(await confirmIfDirty())) return
    const file = await api.openFile()
    if (file) loadDocument(file.path, file.content)
  },
  async save() {
    const saved = await api.saveFile(currentPath, view.state.doc.toString())
    if (saved) {
      currentPath = saved
      setDirty(false)
      refreshTitle()
    }
  },
  async saveAs() {
    const saved = await api.saveFile(null, view.state.doc.toString())
    if (saved) {
      currentPath = saved
      setDirty(false)
      refreshTitle()
    }
  }
}

api.onMenu((cmd) => {
  commands[cmd]().catch((err) => {
    console.error(err)
    alert(`エラー: ${err instanceof Error ? err.message : String(err)}`)
  })
})

refreshTitle()
