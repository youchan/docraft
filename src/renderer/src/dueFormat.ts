const pad = (n: number): string => String(n).padStart(2, '0')
export const toYmd = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const today = (): string => toYmd(new Date())
export const isOverdue = (due: string): boolean => due < today()

const RELATIVE = ['今日', '明日', '明後日']
/** 今日 / 明日 / 明後日 for the next three days; otherwise `MM/DD` within the current year and `YYYY-MM-DD` beyond. */
export function shortDate(due: string): string {
  for (let i = 0; i < RELATIVE.length; i++) {
    const d = new Date()
    d.setDate(d.getDate() + i)
    if (toYmd(d) === due) return RELATIVE[i]
  }
  return due.startsWith(today().slice(0, 4)) ? `${due.slice(5, 7)}/${due.slice(8)}` : due
}
