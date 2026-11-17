import { syntaxTree } from '@codemirror/language'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

type Mermaid = typeof import('mermaid').default

let mermaidPromise: Promise<Mermaid> | null = null
let counter = 0
const svgCache = new Map<string, string>()

const isDark = (): boolean => window.matchMedia('(prefers-color-scheme: dark)').matches

/** Load mermaid lazily (it is large) and initialize it once. */
function loadMermaid(): Promise<Mermaid> {
  mermaidPromise ??= import('mermaid').then(({ default: m }) => {
    m.initialize({ startOnLoad: false, securityLevel: 'strict' })
    return m
  })
  return mermaidPromise
}

interface View2D {
  scale: number
  x: number
  y: number
}
/** Zoom/pan per diagram source, so it survives switching to the source and back. */
const viewStates = new Map<string, View2D>()
const MIN_SCALE = 0.25
const MAX_SCALE = 8

class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super()
  }
  eq(other: MermaidWidget): boolean {
    return other.code === this.code
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-md-mermaid'
    const stage = document.createElement('div')
    stage.className = 'cm-md-mermaid-stage'
    wrap.append(stage)

    const st: View2D = viewStates.get(this.code) ?? { scale: 1, x: 0, y: 0 }
    const apply = (): void => {
      stage.style.transform = `translate(${st.x}px, ${st.y}px) scale(${st.scale})`
      viewStates.set(this.code, { ...st })
      label.textContent = `${Math.round(st.scale * 100)}%`
    }
    /** Zoom to `next`, keeping the point (px, py) of the viewport fixed. */
    const zoomAt = (next: number, px: number, py: number): void => {
      const s2 = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))
      const k = s2 / st.scale
      st.x = px - (px - st.x) * k
      st.y = py - (py - st.y) * k
      st.scale = s2
      apply()
    }
    const center = (): [number, number] => [wrap.clientWidth / 2, wrap.clientHeight / 2]

    // Zoom controls (shown on hover)
    const controls = document.createElement('div')
    controls.className = 'cm-md-mermaid-controls'
    const label = document.createElement('span')
    const btn = (text: string, title: string, fn: () => void): HTMLElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.title = title
      b.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.button === 0) fn()
      })
      return b
    }
    controls.append(
      btn('−', '縮小', () => zoomAt(st.scale / 1.25, ...center())),
      label,
      btn('+', '拡大', () => zoomAt(st.scale * 1.25, ...center())),
      btn('⟲', 'リセット', () => {
        st.scale = 1
        st.x = 0
        st.y = 0
        apply()
      })
    )
    wrap.append(controls)

    // Ctrl/⌘ + wheel (or trackpad pinch) zooms around the pointer.
    wrap.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return
        e.preventDefault()
        const r = wrap.getBoundingClientRect()
        zoomAt(st.scale * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top)
      },
      { passive: false }
    )

    // Drag pans; a click without movement moves the cursor into the block (shows the source).
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      const sx = e.clientX
      const sy = e.clientY
      const ox = st.x
      const oy = st.y
      let moved = false
      const onMove = (m: MouseEvent): void => {
        if (!moved && Math.hypot(m.clientX - sx, m.clientY - sy) < 4) return
        moved = true
        wrap.classList.add('cm-md-mermaid-panning')
        st.x = ox + m.clientX - sx
        st.y = oy + m.clientY - sy
        apply()
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        wrap.classList.remove('cm-md-mermaid-panning')
        if (moved) return
        view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } })
        view.focus()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })

    apply()
    const dark = isDark()
    const key = `${dark ? 'd' : 'l'}:${this.code}`
    const cached = svgCache.get(key)
    if (cached) stage.innerHTML = cached
    else {
      stage.textContent = '…'
      const id = `docraft-mermaid-${counter++}`
      void loadMermaid()
        .then(async (m) => {
          m.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
          const { svg } = await m.render(id, this.code)
          svgCache.set(key, svg)
          stage.innerHTML = svg
          view.requestMeasure()
        })
        .catch((err: unknown) => {
          wrap.classList.add('cm-md-mermaid-error')
          stage.textContent = `Mermaid: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`
          // mermaid leaves its error graphic in <body> when parsing fails
          document.getElementById(`d${id}`)?.remove()
          view.requestMeasure()
        })
    }
    return wrap
  }
  get estimatedHeight(): number {
    return 200
  }
  ignoreEvent(): boolean {
    return true
  }
}

function buildMermaid(state: EditorState): DecorationSet {
  const decos: Range<Decoration>[] = []
  syntaxTree(state).iterate({
    enter: (ref) => {
      if (ref.name !== 'FencedCode') return
      const info = ref.node.getChild('CodeInfo')
      if (!info || state.doc.sliceString(info.from, info.to).trim().toLowerCase() !== 'mermaid') return false
      const { from, to } = ref
      if (state.selection.ranges.some((r) => r.from <= to && r.to >= from)) return false
      const text = ref.node.getChild('CodeText')
      const code = text ? state.doc.sliceString(text.from, text.to) : ''
      if (!code.trim()) return false
      decos.push(Decoration.replace({ widget: new MermaidWidget(code), block: true }).range(from, to))
      return false
    }
  })
  return Decoration.set(decos, true)
}

/** Render ```mermaid blocks as diagrams; the block holding the cursor is shown as source. */
export function mermaidBlocks(): Extension {
  return StateField.define<DecorationSet>({
    create: buildMermaid,
    update(value, tr) {
      if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return buildMermaid(tr.state)
      return value
    },
    provide: (f) => EditorView.decorations.from(f)
  })
}
