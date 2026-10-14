import { apiMode } from '../api/http/config'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "Today": the design's fixed day in mock mode (the mock data is written around it), the real local day in API mode. */
export const todayFor = (api: boolean, now: Date = new Date()) =>
  api ? `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}` : '2026-10-10'

/** The app's "today", fixed when the page loads. ponytail: a tab left open past midnight keeps yesterday until reloaded. */
export const TODAY = todayFor(apiMode)

export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-10-09" → "09 Oct 2026" */
export const fmt = (iso: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return `${d} ${MON[+m - 1]} ${y}`
}

/** "2026-10-09" → "9 Oct" */
export const short = (iso: string) => {
  if (!iso) return 'No date'
  const [, m, d] = iso.split('-')
  return `${+d} ${MON[+m - 1]}`
}

/** True for a "YYYY-MM-DD" string that is a real calendar date. */
export const isIso = (iso: unknown): iso is string => {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false
  return !isNaN(new Date(iso + 'T12:00:00Z').getTime())
}

/** Whole days from b to a. Returns 0 when either date is empty or invalid. */
export const diff = (a: string, b: string) => {
  if (!isIso(a) || !isIso(b)) return 0
  return Math.round((new Date(a + 'T12:00:00Z').getTime() - new Date(b + 'T12:00:00Z').getTime()) / 864e5)
}

/** Adds n days to a date. Returns '' when the date is empty or invalid, so callers can show "—". */
export const addDays = (iso: string, n: number) => {
  if (!isIso(iso) || !Number.isFinite(n)) return ''
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

/** "5 Oct – 18 Oct" */
export const range = (a: string, b: string) => `${short(a)} – ${short(b)}`

export const weeks = (start: string, end: string) => {
  const n = diff(end, start) + 1
  return n <= 7 ? '1 week' : Math.round(n / 7) + ' weeks'
}

/** "10 Oct 2026" for the real current date (used for upload dates). */
export const todayLabel = () => {
  const d = new Date()
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()}`
}

export const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`
