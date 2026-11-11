/**
 * Minimal YAML frontmatter support (flat `key: value` lines) and the document title (first `# heading`).
 */
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Length of the frontmatter block at the start of `text` (including its trailing newline); 0 when there is none. */
export function frontmatterEnd(text: string): number {
  return FRONT.exec(text)?.[0].length ?? 0
}

/** Split into the frontmatter block (possibly '') and the rest. */
export function splitFrontmatter(text: string): { front: string; body: string } {
  const n = frontmatterEnd(text)
  return { front: text.slice(0, n), body: text.slice(n) }
}

const keyLine = (key: string): RegExp => new RegExp(`^${key}\\s*:`)

/** The value of `key` in the frontmatter (quotes stripped), or null. */
export function parseKey(text: string, key: string): string | null {
  const m = FRONT.exec(text)
  if (!m) return null
  const re = keyLine(key)
  for (const line of m[1].split(/\r?\n/)) {
    if (re.test(line)) return line.slice(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '') || null
  }
  return null
}

/** Return `text` with frontmatter `key` set (or removed when null); everything else is left untouched. */
export function applyKey(text: string, key: string, value: string | null): string {
  const m = FRONT.exec(text)
  if (!m) return value ? `---\n${key}: ${value}\n---\n${text}` : text
  const lines = m[1].split(/\r?\n/)
  const re = keyLine(key)
  const idx = lines.findIndex((l) => re.test(l))
  if (value) {
    if (idx >= 0) lines[idx] = `${key}: ${value}`
    else lines.push(`${key}: ${value}`)
  } else if (idx >= 0) {
    lines.splice(idx, 1)
  }
  const rest = text.slice(m[0].length)
  return lines.some((l) => l.trim() !== '') ? `---\n${lines.join('\n')}\n---\n${rest}` : rest
}

/** The `due` date (`YYYY-MM-DD`) of a document, or null. */
export function parseDue(text: string): string | null {
  const v = parseKey(text, 'due')
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

/** Return `text` with its `due` set (or removed when null). */
export function applyDue(text: string, due: string | null): string {
  return applyKey(text, 'due', due)
}

export const isDueString = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

const H1 = /^#[ \t]+(\S.*?)[ \t]*#*[ \t]*$/

/** The title of a document: its first `# heading` (below the frontmatter), or null. */
export function parseTitle(text: string): string | null {
  for (const line of splitFrontmatter(text).body.split(/\r?\n/)) {
    const m = H1.exec(line)
    if (m) return m[1]
  }
  return null
}

/** Return `text` with its title set: the first `# heading` is replaced, or one is inserted at the top of the body. */
export function applyTitle(text: string, title: string): string {
  const { front, body } = splitFrontmatter(text)
  const lines = body.split('\n')
  const idx = lines.findIndex((l) => H1.test(l.replace(/\r$/, '')))
  if (idx < 0) return `${front}# ${title}\n\n${body}`
  lines[idx] = `# ${title}${lines[idx].endsWith('\r') ? '\r' : ''}`
  return front + lines.join('\n')
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (s: string): boolean => UUID.test(s)
