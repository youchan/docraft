import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { Tree, type NodeApi, type NodeRendererProps, type TreeApi } from 'react-arborist'
import type { ContextAction, TreeEntry } from '../../shared/api'

const api = window.docraft

interface Props {
  root: string
  data: TreeEntry[]
  activePath: string | null
  onOpenFile: (path: string) => void
  /** Re-scan the folder and update `data`. */
  onRefresh: () => Promise<void>
  /** Entries were renamed or moved on disk (old path -> new path). */
  onPathsMoved: (moved: Record<string, string>) => void
  /** Entries were moved to the trash. */
  onPathsTrashed: (paths: string[]) => void
}

type TreeNode = NodeApi<TreeEntry>

function folderName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

function useElementHeight<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setHeight(Math.floor(entry.contentRect.height)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, height]
}

async function guard<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch (err) {
    const msg = err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err)
    alert(`エラー: ${msg}`)
    return undefined
  }
}

/**
 * Row renderers must be a stable component: react-arborist treats the `children` function as a
 * component type, so an inline arrow would remount every row (and drop the rename input) on each render.
 * Dynamic values reach the rows through this context instead.
 */
interface RowContextValue {
  activePath: string | null
  openContextMenu: (node: TreeNode) => void
}
const RowContext = createContext<RowContextValue>({ activePath: null, openContextMenu: () => undefined })

export function FileTree({ root, data, activePath, onOpenFile, onRefresh, onPathsMoved, onPathsTrashed }: Props) {
  const treeRef = useRef<TreeApi<TreeEntry> | null>(null)
  const [wrapRef, height] = useElementHeight<HTMLDivElement>()
  /** A just-created entry: once it shows up in `data`, reveal it and start renaming. */
  const pendingReveal = useRef<string | null>(null)

  // Pick up changes made outside the app when the window regains focus.
  useEffect(() => {
    const onFocus = (): void => void onRefresh().catch(() => undefined)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [onRefresh])

  useEffect(() => {
    const id = pendingReveal.current
    const tree = treeRef.current
    if (!id || !tree || !tree.get(id)) return
    pendingReveal.current = null
    tree.openParents(id)
    // Let the opened parents render, then select, scroll to and rename the new entry.
    requestAnimationFrame(() => {
      tree.select(id)
      tree.scrollTo(id)
      void tree.edit(id)
    })
  }, [data])

  const create = (parent: string, kind: 'file' | 'folder'): void => {
    void guard(async () => {
      pendingReveal.current = await api.createEntry(parent, kind)
      await onRefresh()
    })
  }

  const trash = (ids: string[]): void => {
    void guard(async () => {
      if (await api.trashEntries(ids)) {
        onPathsTrashed(ids)
        await onRefresh()
      }
    })
  }

  /** Right-click menu. `node` = null means the empty area (the documents folder itself). */
  const openContextMenu = (node: TreeNode | null): void => {
    const tree = treeRef.current
    if (node) tree?.select(node.id)
    const parentPath = !node ? root : node.isInternal ? node.id : node.parent && !node.parent.isRoot ? node.parent.id : root
    const kind = !node ? 'root' : node.isInternal ? 'folder' : 'file'
    void guard(async () => {
      const action: ContextAction | null = await api.showContextMenu(kind, folderName(parentPath))
      if (!action) return
      switch (action) {
        case 'newFile':
          return create(parentPath, 'file')
        case 'newFolder':
          return create(parentPath, 'folder')
        case 'rename':
          if (node) void tree?.edit(node)
          return
        case 'reveal':
          if (node) await api.revealEntry(node.id)
          return
        case 'trash':
          if (node) trash([node.id])
      }
    })
  }

  return (
    <aside id="sidebar">
      <div
        className="sidebar-head"
        onContextMenu={(e) => {
          e.preventDefault()
          openContextMenu(null)
        }}
      >
        <span className="sidebar-title" title={root}>
          {folderName(root)}
        </span>
        <button className="icon-btn" title="ルートに新規ファイル" onClick={() => create(root, 'file')}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12A.5.5 0 0 1 4 1.5Z M8.5 7v4 M6.5 9h4" />
          </svg>
        </button>
        <button className="icon-btn" title="ルートに新規フォルダ" onClick={() => create(root, 'folder')}>
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M1.5 4a.5.5 0 0 1 .5-.5h3.6l1.4 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5Z M8 7.5v3.5 M6.25 9.25h3.5" />
          </svg>
        </button>
      </div>
      <div
        className="sidebar-tree"
        ref={wrapRef}
        onContextMenu={(e) => {
          // Rows handle their own menu and stop propagation; this is the empty area.
          e.preventDefault()
          openContextMenu(null)
        }}
        onKeyDown={(e) => {
          if ((e.target as HTMLElement).closest('input')) return
          const node = treeRef.current?.focusedNode
          if (!node) return
          // Backspace (delete) and Enter (rename) are handled by react-arborist; add F2 and the Delete key.
          if (e.key === 'F2') void treeRef.current?.edit(node)
          else if (e.key === 'Delete') trash([node.id])
        }}
      >
        <RowContext.Provider value={{ activePath, openContextMenu }}>
          {height > 0 && (
            <Tree<TreeEntry>
              ref={treeRef}
              data={data}
              width="100%"
              height={height}
              rowHeight={26}
              indent={16}
              padding={6}
              openByDefault={false}
              disableMultiSelection
              onActivate={(node) => {
                if (node.isLeaf) onOpenFile(node.id)
              }}
              onRename={({ id, name }) =>
                void guard(async () => {
                  const newPath = await api.renameEntry(id, name)
                  onPathsMoved({ [id]: newPath })
                  await onRefresh()
                })
              }
              onMove={({ dragIds, parentId }) =>
                void guard(async () => {
                  const moved = await api.moveEntries(dragIds, parentId ?? root)
                  onPathsMoved(moved)
                  await onRefresh()
                })
              }
              onDelete={({ ids }) => trash(ids)}
            >
              {Row}
            </Tree>
          )}
        </RowContext.Provider>
      </div>
    </aside>
  )
}

function Row({ node, style, dragHandle }: NodeRendererProps<TreeEntry>) {
  const { activePath, openContextMenu } = useContext(RowContext)
  const cls = [
    'tree-row',
    node.isSelected ? 'selected' : '',
    node.id === activePath ? 'active' : '',
    node.state.isDragging ? 'dragging' : '',
    node.state.willReceiveDrop ? 'drop-target' : ''
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <div
      ref={dragHandle}
      style={style}
      className={cls}
      onClick={() => node.isInternal && node.toggle()}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        openContextMenu(node)
      }}
    >
      <span className="chev">{node.isInternal ? (node.isOpen ? '▾' : '▸') : ''}</span>
      <NodeIcon node={node} />
      {node.isEditing ? <RenameInput node={node} /> : <span className="tree-name">{node.data.name}</span>}
    </div>
  )
}

function NodeIcon({ node }: { node: TreeNode }) {
  return node.isInternal ? (
    <svg className="tree-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1.5 4a.5.5 0 0 1 .5-.5h3.6l1.4 1.5H14a.5.5 0 0 1 .5.5v7a.5.5 0 0 1-.5.5H2a.5.5 0 0 1-.5-.5Z" />
    </svg>
  ) : (
    <svg className="tree-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12A.5.5 0 0 1 4 1.5Z" />
    </svg>
  )
}

function RenameInput({ node }: { node: TreeNode }) {
  return (
    <input
      className="tree-rename"
      autoFocus
      defaultValue={node.data.name}
      onFocus={(e) => {
        // Select the name without its extension.
        const v = e.currentTarget.value
        const dot = v.lastIndexOf('.')
        e.currentTarget.setSelectionRange(0, node.isLeaf && dot > 0 ? dot : v.length)
      }}
      onBlur={() => node.reset()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') node.reset()
        else if (e.key === 'Enter' && !e.nativeEvent.isComposing) node.submit(e.currentTarget.value)
        e.stopPropagation()
      }}
    />
  )
}
