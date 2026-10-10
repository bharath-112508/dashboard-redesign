import { addDays, diff, fmt, isIso, MON } from '../../lib/dates'
import type { TimeEntry } from '../types'

/** Hours a person is expected to log on a weekday (TARGET_DAY in the prototype). */
export const TARGET_DAY = 8

/** Monday of the week that contains `iso`. */
export const weekStart = (iso: string): string => {
  const day = new Date(iso + 'T12:00:00Z').getUTCDay() // 0 = Sunday
  return addDays(iso, -((day + 6) % 7))
}

/** The seven ISO dates of a week, Monday first. */
export const weekDays = (monday: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(monday, i))

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (iso: string): number => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7

export const WEEKDAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export const isWeekend = (iso: string) => weekdayIndex(iso) >= 5

/** "5 Oct – 11 Oct 2026" */
export const weekLabel = (monday: string): string => {
  const sun = addDays(monday, 6)
  const [, m1, d1] = monday.split('-')
  const [y2, m2, d2] = sun.split('-')
  return `${+d1} ${MON[+m1 - 1]} – ${+d2} ${MON[+m2 - 1]} ${y2}`
}

export const monthStart = (iso: string) => iso.slice(0, 8) + '01'

/** Last day of the month that contains `iso`. */
export const monthEnd = (iso: string): string => {
  const [y, m] = iso.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`
}

export type Period = 'week' | 'lastMonth' | 'month' | 'all' | 'custom'

export const PERIOD_LABEL: Record<Period, string> = {
  week: 'This week',
  lastMonth: 'Last month',
  month: 'This month',
  all: 'All time',
  custom: 'Custom range',
}

/** Inclusive date range of a period, or null for all time. `custom` uses from / to (either may be empty). */
export const periodRange = (
  period: Period,
  today: string,
  custom: { from: string; to: string } = { from: '', to: '' },
): { from: string; to: string } | null => {
  switch (period) {
    case 'week': {
      const mon = weekStart(today)
      return { from: mon, to: addDays(mon, 6) }
    }
    case 'month':
      return { from: monthStart(today), to: monthEnd(today) }
    case 'lastMonth': {
      const first = monthStart(today)
      const prevEnd = addDays(first, -1)
      return { from: monthStart(prevEnd), to: prevEnd }
    }
    case 'custom':
      return { from: isIso(custom.from) ? custom.from : '0000-01-01', to: isIso(custom.to) ? custom.to : '9999-12-31' }
    default:
      return null
  }
}

export const inRange = (date: string, r: { from: string; to: string } | null) => !r || (date >= r.from && date <= r.to)

/** A period as shown in file names and headings, e.g. "5 Oct 2026 – 11 Oct 2026". */
export const rangeText = (r: { from: string; to: string } | null, entries: TimeEntry[]): string => {
  if (r) return `${fmt(r.from)} – ${fmt(r.to)}`
  if (!entries.length) return 'All time'
  const dates = entries.map(e => e.date).sort()
  return `${fmt(dates[0])} – ${fmt(dates[dates.length - 1])}`
}

/** Decimal hours from hours and minutes, rounded to the minute. */
export const toHours = (h: number, m: number): number => Math.round(h * 60 + m) / 60

/** 2.5 → "2h 30m"; 0 → "0m". */
export const fmtHours = (n: number): string => {
  const total = Math.round(n * 60)
  if (!total) return '0m'
  const H = Math.floor(total / 60)
  const M = total % 60
  return (H ? H + 'h' : '') + (H && M ? ' ' : '') + (M ? M + 'm' : '')
}

/** Hours for a file: two decimals, "2.50". */
export const decimal = (n: number): string => (Math.round(n * 100) / 100).toFixed(2)

export const entryHours = (e: Pick<TimeEntry, 'bill' | 'non'>) => (e.bill || 0) + (e.non || 0)

/**
 * Idle hours: for each weekday up to and including today, the part of the daily target not logged.
 * Weekends have no target and future days are not counted yet.
 */
export const idleHours = (days: { iso: string; hours: number }[], today: string): number =>
  days
    .filter(d => !isWeekend(d.iso) && diff(today, d.iso) >= 0)
    .reduce((acc, d) => acc + Math.max(0, TARGET_DAY - d.hours), 0)
