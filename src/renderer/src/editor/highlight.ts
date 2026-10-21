import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

/**
 * Inline Markdown styling + code-block token colors.
 * Colors reference CSS variables so light/dark themes come from styles.css.
 */
export const docraftHighlight = HighlightStyle.define([
  // Markdown
  { tag: t.heading, fontWeight: '700' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.processingInstruction, color: 'var(--muted)' }, // # * _ ` > etc.
  { tag: t.quote, color: 'var(--quote-fg)' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.contentSeparator, color: 'var(--muted)' },

  // Code blocks
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--tok-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--tok-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tok-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tok-function)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tok-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--tok-property)' },
  { tag: [t.tagName], color: 'var(--tok-keyword)' },
  { tag: [t.meta], color: 'var(--muted)' }
])
