import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { autocompletion, closeBrackets, closeBracketsKeymap, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { livePreview, refreshLinks } from './editor/livePreview'
import { frontmatterStyle, movePastFrontmatter, replaceWholeDoc } from './editor/frontmatter'
import { tables } from './editor/tables'
import type { LinkSuggestion } from './links'
import { docraftHighlight } from './editor/highlight'

export interface EditorHandle {
  getDoc(): string
  /** Replace the whole document (resets undo history). Does not fire onDocChange. */
  setDoc(content: string, opts?: { readOnly?: boolean }): void
  /** Replace the whole text with a minimal edit (keeps cursor and undo history). Fires onDocChange. */
  replaceDoc(content: string): void
  focus(): void
}

interface Props {
  initialDoc: string
  /** Directory used to resolve relative image paths. */
  baseDir: string | null
  onDocChange: () => void
  /** Path of the file `[[name]]` points to, or null. Changing identity redraws the links. */
  resolveLink: (name: string) => string | null
  onOpenLink: (name: string) => void
  /** Files for `[[` completion (name prefix match). */
  searchLinks: (query: string) => LinkSuggestion[]
  /** Title and state of the TODO with this UUID (for `[[todo:UUID]]`), or null. */
  todoInfo: (uuid: string) => { title: string; completed: boolean } | null
  /** Hide the editor (no document open). */
  hidden?: boolean
}

interface Hooks {
  getBaseDir: () => string | null
  onChange: () => void
  isLinkResolved: (name: string) => boolean
  openLink: (name: string) => void
  searchLinks: (query: string) => LinkSuggestion[]
  todoInfo: (uuid: string) => { title: string; completed: boolean } | null
  openUrl: (url: string) => void
}

/** `[[` completion: documents whose name starts with what has been typed; picking one inserts `name]]`. */
function wikiLinkSource(hooks: Hooks) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const m = ctx.matchBefore(/\[\[[^\]\n|]*/)
    if (!m) return null
    const from = m.from + 2
    const options = hooks.searchLinks(ctx.state.sliceDoc(from, ctx.pos)).map((s) => ({
      label: s.name,
      detail: s.folder,
      type: 'text',
      apply: (view: EditorView, _c: unknown, f: number, t: number): void => {
        // closeBrackets has usually already added the `]]`; do not duplicate it.
        const text = s.insert ?? s.name
        const hasClose = view.state.sliceDoc(t, t + 2) === ']]'
        view.dispatch({
          changes: { from: f, to: t, insert: text + (hasClose ? '' : ']]') },
          selection: { anchor: f + text.length + 2 },
          userEvent: 'input.complete'
        })
      }
    }))
    return { from, options, filter: false }
  }
}

function createState(doc: string, hooks: Hooks, readOnly: boolean): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      indentOnInput(),
      bracketMatching(),
      // Typing an opening bracket inserts the closing one after the caret.
      closeBrackets(),
      autocompletion({ override: [wikiLinkSource(hooks)], icons: false }),
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '「', '『', '（', '【'] } }]),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(docraftHighlight),
      EditorView.lineWrapping,
      livePreview({
        baseDir: hooks.getBaseDir,
        isLinkResolved: hooks.isLinkResolved,
        openLink: hooks.openLink,
        todoInfo: hooks.todoInfo,
        openUrl: hooks.openUrl
      }),
      tables(),
      frontmatterStyle(),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) hooks.onChange()
      })
    ]
  })
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialDoc, baseDir, onDocChange, resolveLink, onOpenLink, searchLinks, todoInfo, hidden }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest props, readable from CodeMirror callbacks without recreating the editor.
  const baseDirRef = useRef(baseDir)
  const onChangeRef = useRef(onDocChange)
  const resolveLinkRef = useRef(resolveLink)
  const onOpenLinkRef = useRef(onOpenLink)
  const searchLinksRef = useRef(searchLinks)
  const todoInfoRef = useRef(todoInfo)
  baseDirRef.current = baseDir
  onChangeRef.current = onDocChange
  resolveLinkRef.current = resolveLink
  onOpenLinkRef.current = onOpenLink
  searchLinksRef.current = searchLinks
  todoInfoRef.current = todoInfo

  const make = (doc: string, readOnly = false): EditorState =>
    createState(
      doc,
      {
      getBaseDir: () => baseDirRef.current,
      onChange: () => onChangeRef.current(),
      isLinkResolved: (name) => resolveLinkRef.current(name) !== null,
      openLink: (name) => onOpenLinkRef.current(name),
      searchLinks: (q) => searchLinksRef.current(q),
      todoInfo: (uuid) => todoInfoRef.current(uuid),
      openUrl: (url) => void window.docraft.openExternal(url).catch(() => undefined)
      },
      readOnly
    )

  // Redraw wiki links when the set of files (or the current file) changes.
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLinks.of(null) })
  }, [resolveLink])

  useEffect(() => {
    // The editor is created once; documents are swapped through the imperative handle.
    const view = new EditorView({ state: make(initialDoc), parent: hostRef.current! })
    viewRef.current = view
    view.focus()
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useImperativeHandle(ref, () => ({
    getDoc: () => viewRef.current?.state.doc.toString() ?? '',
    setDoc: (content, opts) => {
      const view = viewRef.current
      if (!view) return
      view.setState(make(content, opts?.readOnly ?? false))
      if (!opts?.readOnly) {
        movePastFrontmatter(view)
        view.focus()
      }
    },
    replaceDoc: (content) => {
      const view = viewRef.current
      if (!view) return
      replaceWholeDoc(view, content)
      movePastFrontmatter(view)
    },
    focus: () => viewRef.current?.focus()
  }))

  return <div id="editor" ref={hostRef} style={hidden ? { display: 'none' } : undefined} />
})
