import { useEffect, useState } from 'react'
import { toYmd, today } from './dueFormat'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function parseYmd(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/** `11/09(月)` */
function label(date: string): string {
  const d = parseYmd(date)
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}(${WEEKDAYS[d.getDay()]})`
}

function DocIcon() {
  return (
    <svg className="daily-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5v-12A.5.5 0 0 1 4 1.5Z" />
      <path d="M6 8.5h4M6 11h4" />
    </svg>
  )
}

/** Sidebar section: today and the last three earlier days that have a daily document, plus a calendar link. */
export function DailyList({
  dates,
  activeDate,
  onOpen,
  onOpenCalendar
}: {
  /** Dates with a document, newest first. */
  dates: string[]
  activeDate: string | null
  onOpen: (date: string) => void
  onOpenCalendar: () => void
}) {
  const now = today()
  const recent = dates.filter((d) => d < now).slice(0, 3)
  return (
    <div id="daily-list">
      <div className="sidebar-head">
        <span className="sidebar-title">デイリー</span>
      </div>
      <div className="todo-items">
        {[now, ...recent].map((d) => (
          <div key={d} className={`todo-row${d === activeDate ? ' active' : ''}`} onClick={() => onOpen(d)}>
            <span className="todo-name">{d === now ? `今日  ${label(d)}` : label(d)}</span>
          </div>
        ))}
        <div className="todo-row daily-calendar-link" onClick={onOpenCalendar}>
          <span className="todo-name">カレンダー…</span>
        </div>
      </div>
    </div>
  )
}

/** Month calendar; days that have a document show a document icon. Clicking a day opens (or creates) its document. */
export function Calendar({
  dates,
  activeDate,
  onOpen,
  onClose
}: {
  dates: string[]
  activeDate: string | null
  onOpen: (date: string) => void
  onClose: () => void
}) {
  const [month, setMonth] = useState(() => {
    const d = activeDate ? parseYmd(activeDate) : new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const has = new Set(dates)
  const now = today()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const cells: (Date | null)[] = Array.from({ length: first.getDay() }, () => null)
  for (let d = 1; d <= new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate(); d++) {
    cells.push(new Date(month.getFullYear(), month.getMonth(), d))
  }
  while (cells.length % 7 !== 0) cells.push(null)

  const move = (delta: number): void => setMonth(new Date(month.getFullYear(), month.getMonth() + delta, 1))

  return (
    <div id="calendar-overlay">
      <div className="calendar">
        <div className="calendar-head">
          <button className="icon-btn" title="前の月" onClick={() => move(-1)}>
            ‹
          </button>
          <span className="calendar-title">
            {month.getFullYear()}年{month.getMonth() + 1}月
          </span>
          <button className="icon-btn" title="次の月" onClick={() => move(1)}>
            ›
          </button>
          <button className="calendar-today" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>
            今日
          </button>
          <span className="subtask-spacer" />
          <button className="icon-btn" title="閉じる (Esc)" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="calendar-grid">
          {WEEKDAYS.map((w, i) => (
            <div key={w} className={`calendar-dow${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}`}>
              {w}
            </div>
          ))}
          {cells.map((c, i) => {
            if (!c) return <div key={i} className="calendar-cell empty" />
            const ymd = toYmd(c)
            const cls = ['calendar-cell', ymd === now ? 'today' : '', ymd === activeDate ? 'active' : '', has.has(ymd) ? 'has-doc' : '']
            return (
              <button key={i} className={cls.filter(Boolean).join(' ')} onClick={() => onOpen(ymd)} title={has.has(ymd) ? '開く' : '作成して開く'}>
                <span className="calendar-day">{c.getDate()}</span>
                {has.has(ymd) && <DocIcon />}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
