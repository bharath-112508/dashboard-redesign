import { addDays, diff, MON } from '../../lib/dates'

/** Working hours a weekday is worth for the idle figure. */
export const DAY_HOURS = 8
export const WEEK_HOURS = 40

const pad = (n: number) => String(n).padStart(2, '0')

/** The real current date as YYYY-MM-DD in the browser's time zone. The dashboard uses it for greetings and "today". */
export const todayIso = (now: Date = new Date()): string => `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

/** Day of week of an ISO date: 0 = Monday … 6 = Sunday. */
const monIndex = (iso: string) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7

export const isWeekday = (iso: string) => monIndex(iso) < 5

/** Monday to Sunday of the week that contains `iso`. */
export const weekOf = (iso: string): string[] => {
  const mon = addDays(iso, -monIndex(iso))
  return Array.from({ length: 7 }, (_, i) => addDays(mon, i))
}

/** Every date from the first of the month up to and including `iso`. */
export const monthToDate = (iso: string): string[] => {
  const first = iso.slice(0, 8) + '01'
  const out: string[] = []
  for (let d = first; d <= iso && out.length < 31; d = addDays(d, 1)) out.push(d)
  return out
}

/** Hours to a short label: 26.75 → "26h 45m", 2 → "2h", 0 → "0m". */
export const hm = (hours: number): string => {
  const m = Math.round(hours * 60)
  if (!m) return '0m'
  const H = Math.floor(m / 60)
  const M = m % 60
  return (H ? H + 'h' : '') + (H && M ? ' ' : '') + (M ? M + 'm' : '')
}

/** Whole percentage of part over whole, 0 when the whole is empty. */
export const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

/** "Sat 10 Oct" style day label for a date in the UTC calendar (no time-zone shift). */
export const dayLabel = (iso: string) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Due label for a list row: "3d late", "Due today" or "Fri 17 Oct". */
export const dueLabel = (due: string, today: string) => {
  const d = diff(due, today)
  if (d < 0) return `${-d}d late`
  if (d === 0) return 'Due today'
  return dayLabel(due)
}

/** "Saturday 10 October 2026" */
export const longDate = (iso: string) =>
  new Date(iso + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

/** "5 Oct" for a date, for compact labels. */
export const dayMonth = (iso: string) => `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]}`

/** Number of weekdays in an array of ISO dates. */
export const weekdaysIn = (dates: string[]) => dates.filter(isWeekday).length
