import { useState } from 'react'
import type { TodoItem } from '../../shared/api'

/** Inline title input (new or rename). Enter adds, Escape/blur cancels. */
function AddInput({
  placeholder,
  initial = '',
  onSubmit,
  onCancel
}: {
  placeholder: string
  initial?: string
  onSubmit: (t: string) => void
  onCancel: () => void
}) {
  return (
    <input
      className="todo-input"
      autoFocus
      defaultValue={initial}
      onFocus={(e) => e.currentTarget.select()}
      placeholder={placeholder}
      onBlur={onCancel}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return
        if (e.key === 'Escape') onCancel()
        else if (e.key === 'Enter') {
          const t = e.currentTarget.value.trim()
          if (t) onSubmit(t)
          else onCancel()
        }
      }}
    />
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

/** Flat list of top-level TODOs, shown above the file tree. */
export function TodoList({
  items,
  activePath,
  onOpen,
  onCreate,
  onComplete,
  onRename,
  onTrash
}: {
  items: TodoItem[]
  activePath: string | null
  onOpen: (path: string) => void
  onCreate: (title: string) => void
  onComplete: (path: string) => void
  onRename: (path: string, title: string) => void
  onTrash: (path: string) => void
}) {
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div id="todo-list">
      <div className="sidebar-head">
        <span className="sidebar-title">TODO</span>
        <button className="icon-btn" title="TODOを追加" onClick={() => setAdding(true)}>
          <PlusIcon />
        </button>
      </div>
      {adding && (
        <AddInput
          placeholder="TODOのタイトル"
          onCancel={() => setAdding(false)}
          onSubmit={(t) => {
            setAdding(false)
            onCreate(t)
          }}
        />
      )}
      <div className="todo-items">
        {items.map((t) =>
          renaming === t.id ? (
            <AddInput
              key={t.id}
              placeholder="TODOのタイトル"
              initial={t.name}
              onCancel={() => setRenaming(null)}
              onSubmit={(title) => {
                setRenaming(null)
                if (title !== t.name) onRename(t.id, title)
              }}
            />
          ) : (
            <div
              key={t.id}
              className={`todo-row${t.id === activePath ? ' active' : ''}`}
              onClick={() => onOpen(t.id)}
              onDoubleClick={() => setRenaming(t.id)}
              title="ダブルクリックで名前を変更"
            >
              <span className="todo-name">{t.name}</span>
              <button
                className="icon-btn todo-act"
                title="完了にする"
                onClick={(e) => {
                  e.stopPropagation()
                  onComplete(t.id)
                }}
              >
                ✓
              </button>
              <button
                className="icon-btn todo-act"
                title="ゴミ箱に移動"
                onClick={(e) => {
                  e.stopPropagation()
                  onTrash(t.id)
                }}
              >
                ×
              </button>
            </div>
          )
        )}
        {items.length === 0 && !adding && <div className="todo-empty">TODOはありません</div>}
      </div>
    </div>
  )
}

/** Subtasks of the open TODO, shown above the editor. */
export function SubtaskBar({
  title,
  items,
  onOpen,
  onCreate,
  onComplete,
  onRename,
  onOpenParent
}: {
  title: string
  items: TodoItem[]
  onOpen: (path: string) => void
  onCreate: (title: string) => void
  onComplete: (path: string) => void
  onRename: (path: string, title: string) => void
  /** Present when the open TODO is itself a subtask. */
  onOpenParent: (() => void) | null
}) {
  const [adding, setAdding] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  return (
    <div id="subtask-bar">
      <div className="subtask-head">
        {onOpenParent && (
          <button className="subtask-parent" title="親のTODOを開く" onClick={onOpenParent}>
            ↑
          </button>
        )}
        <span className="subtask-title">{title} のサブタスク</span>
        <button className="icon-btn" title="サブタスクを追加" onClick={() => setAdding(true)}>
          <PlusIcon />
        </button>
      </div>
      <div className="subtask-items">
        {items.map((t) =>
          renaming === t.id ? (
            <AddInput
              key={t.id}
              placeholder="サブタスクのタイトル"
              initial={t.name}
              onCancel={() => setRenaming(null)}
              onSubmit={(title) => {
                setRenaming(null)
                if (title !== t.name) onRename(t.id, title)
              }}
            />
          ) : (
            <span key={t.id} className="subtask-chip" title="ダブルクリックで名前を変更">
              <button className="subtask-name" onClick={() => onOpen(t.id)} onDoubleClick={() => setRenaming(t.id)}>
                {t.name}
              </button>
              <button className="subtask-done" title="完了にする" onClick={() => onComplete(t.id)}>
                ✓
              </button>
            </span>
          )
        )}
        {items.length === 0 && !adding && <span className="todo-empty">なし</span>}
        {adding && (
          <AddInput
            placeholder="サブタスクのタイトル"
            onCancel={() => setAdding(false)}
            onSubmit={(t) => {
              setAdding(false)
              onCreate(t)
            }}
          />
        )}
      </div>
    </div>
  )
}
