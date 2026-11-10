import { syntaxTree } from '@codemirror/language'
import { StateEffect, type EditorState, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate
} from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'

/**
 * Obsidian-style live preview.
 *
 * Lines that contain the cursor/selection show raw Markdown; every other line
 * hides the syntax marks and renders headings, lists, task boxes, images, etc.
 * Multi-line constructs (fenced code) switch as a whole block.
 */

export interface LivePreviewOptions {
  /** Directory of the current file, used to resolve relative image paths. */
  baseDir: () => string | null
  /** Whether `[[name]]` points to an existing file. */
  isLinkResolved: (name: string) => boolean
  /** Open the file `[[name]]` points to. */
  openLink: (name: string) => void
}

/** Dispatch to force the decorations (e.g. wiki-link states) to be rebuilt. */
export const refreshLinks = StateEffect.define<null>()

// ---------------------------------------------------------------------------
// Widgets
// ---------------------------------------------------------------------------
class BulletWidget extends WidgetType {
  eq(): boolean {
    return true
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-md-bullet'
    el.textContent = '•'
    return el
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.className = 'cm-md-checkbox'
    box.checked = this.checked
    box.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const pos = view.posAtDOM(box) // start of "[ ]"
      const inner = view.state.sliceDoc(pos + 1, pos + 2)
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: inner === ' ' ? 'x' : ' ' } })
    })
    return box
  }
  ignoreEvent(): boolean {
    return false
  }
}

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string
  ) {
    super()
  }
  eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-md-image'
    const img = document.createElement('img')
    img.src = this.src
    img.alt = this.alt
    img.addEventListener('load', () => view.requestMeasure())
    img.addEventListener('error', () => {
      wrap.textContent = `🖼 ${this.alt || this.src}`
      wrap.classList.add('cm-md-image-missing')
    })
    wrap.appendChild(img)
    return wrap
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const hideMark = Decoration.replace({})
const lineDeco = (cls: string): Decoration => Decoration.line({ class: cls })
const markDeco = (cls: string): Decoration => Decoration.mark({ class: cls })

/** Line numbers touched by any selection range. */
function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) lines.add(n)
  }
  return lines
}

/** Split `[[name|label]]` contents. */
function splitWiki(inner: string): { name: string; labelFrom: number } {
  const bar = inner.indexOf('|')
  return bar < 0 ? { name: inner.trim(), labelFrom: 0 } : { name: inner.slice(0, bar).trim(), labelFrom: bar + 1 }
}

function resolveImageSrc(url: string, baseDir: string | null): string {
  if (/^(data:|blob:|file:|https?:)/i.test(url)) return url
  const toFileUrl = (p: string): string => 'file://' + encodeURI(p.replace(/\\/g, '/'))
  if (url.startsWith('/')) return toFileUrl(url)
  if (baseDir) return toFileUrl(`${baseDir}/${decodeURI(url)}`)
  return url
}

// ---------------------------------------------------------------------------
// Decoration builder
// ---------------------------------------------------------------------------
function buildDecorations(view: EditorView, opts: LivePreviewOptions): DecorationSet {
  const { state } = view
  const doc = state.doc
  const active = activeLines(state)
  const decos: Range<Decoration>[] = []

  const lineOf = (pos: number): number => doc.lineAt(pos).number
  const isActive = (from: number, to: number): boolean => {
    for (let n = lineOf(from), end = lineOf(to); n <= end; n++) if (active.has(n)) return true
    return false
  }
  const hide = (from: number, to: number): void => {
    if (from < to) decos.push(hideMark.range(from, to))
  }
  /** Hide a mark plus a single following space, e.g. "## " or "> ". */
  const hideWithSpace = (node: SyntaxNode): void => {
    const end = doc.sliceString(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
    hide(node.from, end)
  }

  const ranges = view.visibleRanges
  if (ranges.length === 0) return Decoration.none
  const from = ranges[0].from
  const to = ranges[ranges.length - 1].to

  syntaxTree(state).iterate({
    from,
    to,
    enter: (ref) => {
      const node = ref.node
      const name = node.name

      // ---- Headings -------------------------------------------------------
      const h = /^ATXHeading(\d)$/.exec(name)
      if (h) {
        decos.push(lineDeco(`cm-md-h cm-md-h${h[1]}`).range(doc.lineAt(node.from).from))
        if (!isActive(node.from, node.to)) {
          const mark = node.getChild('HeaderMark')
          if (mark && mark.from === node.from) hideWithSpace(mark)
        }
        return
      }

      switch (name) {
        // ---- Inline marks -------------------------------------------------
        case 'EmphasisMark':
        case 'StrikethroughMark':
          if (!isActive(node.from, node.to)) hide(node.from, node.to)
          return

        case 'InlineCode':
          decos.push(markDeco('cm-md-inline-code').range(node.from, node.to))
          if (!isActive(node.from, node.to)) {
            for (const m of node.getChildren('CodeMark')) hide(m.from, m.to)
          }
          return false

        case 'Link': {
          const marks = node.getChildren('LinkMark')

          // Wiki link: the parser sees `[[x]]` as a Link `[x]` wrapped in one more `[` and `]`.
          if (
            marks.length === 2 &&
            node.from > 0 &&
            doc.sliceString(node.from - 1, node.from) === '[' &&
            doc.sliceString(node.to, node.to + 1) === ']' &&
            doc.sliceString(node.to + 1, node.to + 2) !== '('
          ) {
            const inner = doc.sliceString(marks[0].to, marks[1].from)
            const { name, labelFrom } = splitWiki(inner)
            if (name) {
              const outerFrom = node.from - 1
              const outerTo = node.to + 1
              const active = isActive(outerFrom, outerTo)
              const resolved = opts.isLinkResolved(name)
              const cls = `cm-md-wikilink${resolved ? '' : ' cm-md-wikilink-missing'}${active ? '' : ' cm-md-wikilink-rendered'}`
              const textFrom = active ? outerFrom : marks[0].to + labelFrom
              const textTo = active ? outerTo : marks[1].from
              if (textFrom < textTo) {
                decos.push(Decoration.mark({ class: cls, attributes: { 'data-wikilink': name } }).range(textFrom, textTo))
              }
              if (!active) {
                hide(outerFrom, marks[0].to + labelFrom) // "[[" and "name|"
                hide(marks[1].from, outerTo) // "]]"
              }
              return false
            }
          }

          if (marks.length >= 2) {
            decos.push(markDeco('cm-md-link').range(marks[0].to, marks[1].from))
            if (!isActive(node.from, node.to)) {
              hide(marks[0].from, marks[0].to) // "["
              hide(marks[1].from, node.to) // "](url)"
            }
          }
          return
        }

        case 'Image': {
          if (isActive(node.from, node.to)) return false
          const marks = node.getChildren('LinkMark')
          const urlNode = node.getChild('URL')
          if (marks.length >= 2 && urlNode) {
            const alt = doc.sliceString(marks[0].to, marks[1].from)
            const src = resolveImageSrc(doc.sliceString(urlNode.from, urlNode.to), opts.baseDir())
            decos.push(Decoration.replace({ widget: new ImageWidget(src, alt) }).range(node.from, node.to))
          }
          return false
        }

        // ---- Blockquote ---------------------------------------------------
        case 'Blockquote':
          for (let n = lineOf(node.from), end = lineOf(node.to); n <= end; n++) {
            decos.push(lineDeco('cm-md-quote').range(doc.line(n).from))
          }
          return
        case 'QuoteMark':
          if (!isActive(node.from, node.to)) hideWithSpace(node)
          return

        // ---- Lists & tasks ------------------------------------------------
        case 'ListMark': {
          const item = node.parent
          const list = item?.parent
          if (!item || !list || isActive(node.from, node.to)) return
          if (list.name === 'BulletList') {
            const task = item.getChild('Task')
            if (task) hideWithSpace(node) // checkbox replaces the bullet
            else decos.push(Decoration.replace({ widget: new BulletWidget() }).range(node.from, node.to))
          }
          return
        }
        case 'Task': {
          const marker = node.getChild('TaskMarker')
          if (!marker) return
          const checked = /x/i.test(doc.sliceString(marker.from, marker.to))
          if (checked) {
            const text = doc.sliceString(marker.to, node.to)
            const start = marker.to + (text.length - text.trimStart().length)
            if (start < node.to) decos.push(markDeco('cm-md-task-done').range(start, node.to))
          }
          if (!isActive(node.from, node.to)) {
            decos.push(Decoration.replace({ widget: new CheckboxWidget(checked) }).range(marker.from, marker.to))
          }
          return false
        }

        // ---- Horizontal rule ----------------------------------------------
        case 'HorizontalRule':
          if (!isActive(node.from, node.to)) {
            decos.push(lineDeco('cm-md-hr').range(doc.lineAt(node.from).from))
            hide(node.from, node.to)
          }
          return false

        // ---- Fenced code (switches as a whole block) -----------------------
        case 'FencedCode': {
          const first = lineOf(node.from)
          const last = lineOf(node.to)
          const blockActive = isActive(node.from, node.to)
          for (let n = first; n <= last; n++) {
            let cls = 'cm-md-codeblock'
            if (n === first) cls += ' cm-md-codeblock-begin'
            if (n === last) cls += ' cm-md-codeblock-end'
            decos.push(lineDeco(cls).range(doc.line(n).from))
          }
          if (!blockActive) {
            const firstLine = doc.line(first)
            const info = node.getChild('CodeInfo')
            hide(firstLine.from, firstLine.to)
            if (info) {
              decos.push(
                Decoration.widget({ widget: new CodeLangWidget(doc.sliceString(info.from, info.to)), side: 1 }).range(
                  firstLine.to
                )
              )
            }
            const lastLine = doc.line(last)
            if (last !== first && /^\s*(```|~~~)/.test(lastLine.text)) hide(lastLine.from, lastLine.to)
          }
          return false
        }
      }
      return
    }
  })

  return Decoration.set(decos, true)
}

class CodeLangWidget extends WidgetType {
  constructor(readonly lang: string) {
    super()
  }
  eq(other: CodeLangWidget): boolean {
    return other.lang === this.lang
  }
  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-md-code-lang'
    el.textContent = this.lang
    return el
  }
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export function livePreview(opts: LivePreviewOptions): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, opts)
      }
      update(u: ViewUpdate): void {
        if (
          u.docChanged ||
          u.viewportChanged ||
          u.selectionSet ||
          u.focusChanged ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          u.transactions.some((tr) => tr.effects.some((e) => e.is(refreshLinks)))
        ) {
          this.decorations = buildDecorations(u.view, opts)
        }
      }
    },
    {
      decorations: (v) => v.decorations,
      eventHandlers: {
        // A rendered wiki link opens on click; a raw one (cursor on its line) needs Cmd/Ctrl+click.
        mousedown(e) {
          const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-wikilink]')
          const name = el?.dataset['wikilink']
          if (!el || !name || e.button !== 0) return
          if (!el.classList.contains('cm-md-wikilink-rendered') && !(e.metaKey || e.ctrlKey)) return
          e.preventDefault()
          opts.openLink(name)
        }
      }
    }
  )
}
