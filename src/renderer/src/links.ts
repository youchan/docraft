import type { TreeEntry } from '../../shared/api'

/**
 * Wiki links: `[[ページ名]]`, `[[ページ名|表示名]]`, `[[フォルダ/ページ名]]`.
 *
 * A link is resolved by file name (without `.md`), case-insensitively, anywhere under the
 * documents folder. A path (`[[sub/設計]]`) matches the end of a file's path relative to the folder.
 * When several files match, the one closest to the current file wins.
 */
export interface LinkSuggestion {
  /** Text to put inside `[[…]]`: the file name, or its path when the name is not unique. */
  name: string
  /** Folder of the file below the documents folder ('' at the top); for a TODO, its kind. */
  folder: string
  /** Text to insert instead of `name` (e.g. `todo:UUID`). */
  insert?: string
}

export interface LinkIndex {
  /** Files whose name (or path) starts with `query`, for `[[` completion. */
  search(query: string, limit?: number): LinkSuggestion[]
  /** Absolute path of the file `name` points to, or null when there is none. */
  resolve(name: string, fromPath: string | null): string | null
}

interface Candidate {
  path: string
  /** Path relative to the folder, without extension, normalized for comparison. */
  rel: string
  /** Directory part of `rel`. */
  dir: string
  base: string
  /** Same as `rel` / `base` with the original letter case. */
  relShown: string
  baseShown: string
}

const EXT = /\.(md|markdown)$/i

/** macOS may hand back decomposed (NFD) names; compare in NFC, ignoring case. */
function norm(s: string): string {
  return s.normalize('NFC').toLowerCase()
}

function slashed(p: string): string {
  return p.replace(/\\/g, '/')
}

/** Split `[[name|label]]` contents. */
export function parseWikiLink(inner: string): { name: string; label: string | null } {
  const bar = inner.indexOf('|')
  if (bar < 0) return { name: inner.trim(), label: null }
  return { name: inner.slice(0, bar).trim(), label: inner.slice(bar + 1) }
}

export function buildLinkIndex(root: string, tree: TreeEntry[]): LinkIndex {
  const rootPrefix = slashed(root).replace(/\/+$/, '') + '/'
  const normRoot = norm(rootPrefix)
  const byBase = new Map<string, Candidate[]>()
  const all: Candidate[] = []

  const walk = (entries: TreeEntry[]): void => {
    for (const e of entries) {
      if (e.children) {
        walk(e.children)
        continue
      }
      const full = slashed(e.id)
      const relShown = (full.startsWith(rootPrefix) ? full.slice(rootPrefix.length) : full).replace(EXT, '')
      const rel = norm(relShown)
      const slash = rel.lastIndexOf('/')
      const cand: Candidate = {
        path: e.id,
        rel,
        dir: slash >= 0 ? rel.slice(0, slash) : '',
        base: slash >= 0 ? rel.slice(slash + 1) : rel,
        relShown,
        baseShown: relShown.slice(relShown.lastIndexOf('/') + 1)
      }
      all.push(cand)
      const list = byBase.get(cand.base)
      if (list) list.push(cand)
      else byBase.set(cand.base, [cand])
    }
  }
  walk(tree)

  return {
    search(query, limit = 50) {
      const q = norm(slashed(query.trim()).replace(/^\/+/, ''))
      return all
        .filter((c) => c.base.startsWith(q) || c.rel.startsWith(q))
        .sort((a, b) => a.base.localeCompare(b.base, 'ja', { numeric: true }) || a.rel.localeCompare(b.rel))
        .slice(0, limit)
        .map((c) => ({
          // A bare name is enough when it resolves to this very file; otherwise use the path.
          name: byBase.get(c.base)?.length === 1 ? c.baseShown : c.relShown,
          folder: c.relShown.includes('/') ? c.relShown.slice(0, c.relShown.lastIndexOf('/')) : ''
        }))
    },
    resolve(name, fromPath) {
      const target = norm(slashed(name.trim()).replace(/^\/+/, '').replace(EXT, ''))
      if (!target) return null

      const candidates = target.includes('/')
        ? all.filter((c) => c.rel === target || c.rel.endsWith('/' + target))
        : (byBase.get(target) ?? [])
      if (candidates.length === 0) return null
      if (candidates.length === 1) return candidates[0].path

      // Prefer the file in the same folder as the current one, then the shallowest, then by path.
      let fromDir = ''
      if (fromPath) {
        const f = norm(slashed(fromPath))
        const r = f.startsWith(normRoot) ? f.slice(normRoot.length) : ''
        fromDir = r.includes('/') ? r.slice(0, r.lastIndexOf('/')) : ''
      }
      const score = (c: Candidate): number => (c.dir === fromDir ? 0 : 1)
      const depth = (c: Candidate): number => c.rel.split('/').length
      return [...candidates].sort(
        (a, b) => score(a) - score(b) || depth(a) - depth(b) || a.rel.localeCompare(b.rel)
      )[0].path
    }
  }
}
