import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, dropCursor, highlightSpecialChars, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { livePreview, refreshLinks } from './editor/livePreview'
import { docraftHighlight } from './editor/highlight'

export interface EditorHandle {
  getDoc(): string
  /** Replace the whole document (resets undo history). Does not fire onDocChange. */
  setDoc(content: string, opts?: { readOnly?: boolean }): void
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
  /** Hide the editor (no document open). */
  hidden?: boolean
}

interface Hooks {
  getBaseDir: () => string | null
  onChange: () => void
  isLinkResolved: (name: string) => boolean
  openLink: (name: string) => void
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
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['(', '[', '{', '「', '『', '（', '【'] } }]),
      search({ top: true }),
      highlightSelectionMatches(),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(docraftHighlight),
      EditorView.lineWrapping,
      livePreview({ baseDir: hooks.getBaseDir, isLinkResolved: hooks.isLinkResolved, openLink: hooks.openLink }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) hooks.onChange()
      })
    ]
  })
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ initialDoc, baseDir, onDocChange, resolveLink, onOpenLink, hidden }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // Latest props, readable from CodeMirror callbacks without recreating the editor.
  const baseDirRef = useRef(baseDir)
  const onChangeRef = useRef(onDocChange)
  const resolveLinkRef = useRef(resolveLink)
  const onOpenLinkRef = useRef(onOpenLink)
  baseDirRef.current = baseDir
  onChangeRef.current = onDocChange
  resolveLinkRef.current = resolveLink
  onOpenLinkRef.current = onOpenLink

  const make = (doc: string, readOnly = false): EditorState =>
    createState(
      doc,
      {
      getBaseDir: () => baseDirRef.current,
      onChange: () => onChangeRef.current(),
      isLinkResolved: (name) => resolveLinkRef.current(name) !== null,
      openLink: (name) => onOpenLinkRef.current(name)
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
      if (!opts?.readOnly) view.focus()
    },
    focus: () => viewRef.current?.focus()
  }))

  return <div id="editor" ref={hostRef} style={hidden ? { display: 'none' } : undefined} />
})
