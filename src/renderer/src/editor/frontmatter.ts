import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { frontmatterEnd } from '../../../shared/frontmatter'

/** Replace the whole text with a minimal edit (keeps the cursor and the undo history). */
export function replaceWholeDoc(view: EditorView, content: string): void {
  const old = view.state.doc.toString()
  let a = 0
  while (a < old.length && a < content.length && old[a] === content[a]) a++
  let b = 0
  while (b < old.length - a && b < content.length - a && old[old.length - 1 - b] === content[content.length - 1 - b]) b++
  if (a === old.length && a === content.length) return
  view.dispatch({ changes: { from: a, to: old.length - b, insert: content.slice(a, content.length - b) } })
}

const headText = (state: EditorState): string => state.doc.sliceString(0, Math.min(state.doc.length, 2000))

/**
 * Where the collapsed block ends: before the closing `---` line's newline, so the body keeps its own
 * line. Null when there is no frontmatter, or it is not followed by a line break.
 */
function blockEnd(state: EditorState): { to: number; start: number } | null {
  const start = frontmatterEnd(headText(state))
  if (start === 0) return null
  const nl = state.doc.sliceString(Math.max(0, start - 2), start) === '\r\n' ? 2 : 1
  const to = start - nl
  if (to <= 0 || state.doc.sliceString(to, start).trim() !== '') return null
  return { to, start }
}

/**
 * The caret must not rest at position 0 of a document with frontmatter: there the block is shown
 * expanded. Move it to the start of the body (used right after a document is loaded).
 */
export function movePastFrontmatter(view: EditorView): void {
  const sel = view.state.selection.main
  const b = blockEnd(view.state)
  if (b && sel.empty && sel.head === 0) view.dispatch({ selection: { anchor: Math.min(b.start, view.state.doc.length) } })
}

/** The collapsed frontmatter: one muted line; clicking it moves the caret in, which expands it. */
class FrontmatterWidget extends WidgetType {
  constructor(readonly summary: string) {
    super()
  }
  eq(other: FrontmatterWidget): boolean {
    return other.summary === this.summary
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-front-collapsed'
    el.title = 'クリックで展開'
    el.textContent = `▸ メタデータ${this.summary ? `  ${this.summary}` : ''}`
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      view.dispatch({ selection: { anchor: view.posAtDOM(el) } })
      view.focus()
    })
    return el
  }
  ignoreEvent(): boolean {
    return true
  }
}

function build(state: EditorState): DecorationSet {
  const b = blockEnd(state)
  const end = frontmatterEnd(headText(state))
  if (end === 0) return Decoration.none

  // Collapsed unless the caret is inside the block.
  if (b && !state.selection.ranges.some((r) => r.from <= b.to)) {
    const inner = state.doc.sliceString(0, b.to).split(/\r?\n/).slice(1, -1)
    const summary = inner.map((l) => l.trim()).filter(Boolean).join(' · ')
    return Decoration.set([
      Decoration.replace({ widget: new FrontmatterWidget(summary.length > 80 ? summary.slice(0, 80) + '…' : summary), block: true }).range(0, b.to)
    ])
  }

  // Expanded: dimmed, small monospace source.
  const decos: Range<Decoration>[] = []
  const last = state.doc.lineAt(Math.max(0, end - 1)).number
  for (let n = 1; n <= last; n++) decos.push(Decoration.line({ class: 'cm-md-front' }).range(state.doc.line(n).from))
  return Decoration.set(decos)
}

/** Frontmatter (`---` … `---`) is collapsed to one line, and shown as dimmed source while the caret is in it. */
export function frontmatterStyle(): Extension {
  return StateField.define<DecorationSet>({
    create: build,
    update: (value, tr) => (tr.docChanged || tr.selection ? build(tr.state) : value),
    provide: (f) => EditorView.decorations.from(f)
  })
}
