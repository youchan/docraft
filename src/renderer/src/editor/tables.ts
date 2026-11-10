import { syntaxTree } from '@codemirror/language'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

type Align = 'left' | 'center' | 'right' | null

/** Split one table row into cells (`\|` is a literal pipe). */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
    } else if (s[i] === '|') {
      cells.push(cur.trim())
      cur = ''
    } else cur += s[i]
  }
  cells.push(cur.trim())
  return cells
}

function parseAligns(delim: string): Align[] {
  return splitRow(delim).map((c) => {
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    return l && r ? 'center' : r ? 'right' : l ? 'left' : null
  })
}

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\([^)\s]+\))/g

/** Append `text` to `parent` with a few inline Markdown constructs rendered (built with DOM APIs, no HTML parsing). */
function appendInline(parent: HTMLElement, text: string): void {
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    if (i > last) parent.append(text.slice(last, i))
    const tok = m[0]
    if (m[1]) {
      const el = document.createElement('code')
      el.textContent = tok.slice(1, -1)
      parent.append(el)
    } else if (m[2]) {
      const el = document.createElement('strong')
      el.textContent = tok.slice(2, -2)
      parent.append(el)
    } else if (m[3]) {
      const el = document.createElement('em')
      el.textContent = tok.slice(1, -1)
      parent.append(el)
    } else {
      const close = tok.indexOf('](')
      const el = document.createElement('a')
      el.textContent = tok.slice(1, close)
      el.dataset['url'] = tok.slice(close + 2, -1)
      parent.append(el)
    }
    last = i + tok.length
  }
  if (last < text.length) parent.append(text.slice(last))
}

class TableWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: TableWidget): boolean {
    return other.text === this.text
  }
  toDOM(view: EditorView): HTMLElement {
    const lines = this.text.split('\n')
    const aligns = lines.length > 1 ? parseAligns(lines[1]) : []
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-table-wrap'
    const table = document.createElement('table')
    table.className = 'cm-md-table'
    const addRow = (line: string, tag: 'th' | 'td', into: HTMLElement): void => {
      const tr = document.createElement('tr')
      splitRow(line).forEach((cell, i) => {
        const td = document.createElement(tag)
        const a = aligns[i]
        if (a) td.style.textAlign = a
        appendInline(td, cell)
        tr.append(td)
      })
      into.append(tr)
    }
    const thead = document.createElement('thead')
    addRow(lines[0], 'th', thead)
    const tbody = document.createElement('tbody')
    for (const line of lines.slice(2)) if (line.trim()) addRow(line, 'td', tbody)
    table.append(thead, tbody)
    wrap.append(table)

    // Links open the browser; anything else moves the cursor into the table, which shows its source.
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const url = (e.target as HTMLElement).closest<HTMLElement>('[data-url]')?.dataset['url']
      if (url) {
        void window.docraft.openExternal(url).catch(() => undefined)
        return
      }
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } })
      view.focus()
    })
    return wrap
  }
  ignoreEvent(): boolean {
    return true
  }
}

function buildTables(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== 'Table') return
      const { from, to } = ref
      const editing = state.selection.ranges.some((r) => r.from <= to && r.to >= from)
      if (editing) {
        // Show the source in a monospace font so the columns line up while editing.
        for (let n = state.doc.lineAt(from).number, end = state.doc.lineAt(to).number; n <= end; n++) {
          decos.push(Decoration.line({ class: 'cm-md-table-src' }).range(state.doc.line(n).from))
        }
      } else {
        decos.push(Decoration.replace({ widget: new TableWidget(state.doc.sliceString(from, to)), block: true }).range(from, to))
      }
      return false
    }
  })
  return Decoration.set(decos, true)
}

/** Render GFM tables as HTML tables; the one holding the cursor is shown as editable source. */
export function tables(): Extension {
  return StateField.define<DecorationSet>({
    create: buildTables,
    update(value, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildTables(tr.state)
      return value
    },
    provide: (f) => EditorView.decorations.from(f)
  })
}
