import { useState } from 'react'
import { AddInput, PlusIcon } from './Todo'
import type { TreeEntry } from '../../shared/api'

/** Child pages of the open page, shown above the editor (like the subtask bar of a TODO). */
export function ChildBar({
  title,
  items,
  onOpen,
  onCreate,
  onOpenParent
}: {
  title: string
  items: TreeEntry[]
  onOpen: (path: string) => void
  onCreate: (name: string) => void
  /** Present when the open page is itself a child. */
  onOpenParent: (() => void) | null
}) {
  const [adding, setAdding] = useState(false)
  return (
    <div id="subtask-bar">
      <div className="subtask-head">
        {onOpenParent && (
          <button className="subtask-parent" title="親ページを開く" onClick={onOpenParent}>
            ↑
          </button>
        )}
        <span className="subtask-title">{title} の子ページ</span>
        <span className="subtask-spacer" />
        <button className="icon-btn" title="子ページを追加" onClick={() => setAdding(true)}>
          <PlusIcon />
        </button>
      </div>
      <div className="subtask-items">
        {items.map((c) => (
          <span key={c.id} className="subtask-chip">
            <button className="subtask-name" disabled={c.missing} onClick={() => onOpen(c.id)}>
              {c.name}
            </button>
          </span>
        ))}
        {items.length === 0 && !adding && <span className="todo-empty">なし</span>}
        {adding && (
          <AddInput
            placeholder="子ページの名前"
            onCancel={() => setAdding(false)}
            onSubmit={(n) => {
              setAdding(false)
              onCreate(n)
            }}
          />
        )}
      </div>
    </div>
  )
}
