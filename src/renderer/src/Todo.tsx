import { useState } from 'react'
import { isOverdue, shortDate } from './dueFormat'
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

/** Due date of a TODO: a badge that turns into a date input when clicked (clear the field to remove it). */
function DueBadge({
  due,
  onChange,
  showEmpty = false
}: {
  due: string | null
  onChange: (due: string | null) => void
  /** Keep an unset badge visible ("期限を設定") instead of showing it only on hover. */
  showEmpty?: boolean
}) {
  const [editing, setEditing] = useState(false)
  if (editing) {
    return (
      <input
        type="date"
        className="due-input"
        autoFocus
        defaultValue={due ?? ''}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={() => setEditing(false)}
        onChange={(e) => {
          // A complete date (or an empty field) is a final value; partial typing yields ''.
          onChange(e.currentTarget.value || null)
          if (e.currentTarget.value) setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false)
          e.stopPropagation()
        }}
      />
    )
  }
  const overdue = due !== null && isOverdue(due)
  return (
    <button
      className={`due-badge${due || showEmpty ? '' : ' due-none'}${overdue ? ' due-overdue' : ''}`}
      title={due ? `期限: ${due}(クリックで変更)` : '期限を設定'}
      onClick={(e) => {
        e.stopPropagation()
        setEditing(true)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {showEmpty && (
        <svg className="due-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
          <rect x="2" y="3" width="12" height="11" rx="1.5" />
          <path d="M2 6.5h12M5.5 1.5v3M10.5 1.5v3" />
        </svg>
      )}
      {due ? shortDate(due) : showEmpty ? '期限を設定' : '期限'}
    </button>
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
  onSetDue,
  onTrash
}: {
  items: TodoItem[]
  activePath: string | null
  onOpen: (path: string) => void
  onCreate: (title: string) => void
  onComplete: (path: string) => void
  onRename: (path: string, title: string) => void
  onSetDue: (path: string, due: string | null) => void
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
              initial={t.title}
              onCancel={() => setRenaming(null)}
              onSubmit={(title) => {
                setRenaming(null)
                if (title !== t.title) onRename(t.id, title)
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
              <DueBadge due={t.due} onChange={(d) => onSetDue(t.id, d)} />
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
  onSetDue,
  due,
  onSetOwnDue,
  onOpenParent
}: {
  title: string
  items: TodoItem[]
  onOpen: (path: string) => void
  onCreate: (title: string) => void
  onComplete: (path: string) => void
  onRename: (path: string, title: string) => void
  onSetDue: (path: string, due: string | null) => void
  /** Due date of the open TODO itself, and how to change it. */
  due: string | null
  onSetOwnDue: (due: string | null) => void
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
        <span className="subtask-spacer" />
        <DueBadge due={due} onChange={onSetOwnDue} showEmpty />
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
              <DueBadge due={t.due} onChange={(d) => onSetDue(t.id, d)} />
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
