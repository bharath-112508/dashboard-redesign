/** The design's fixed "today". The mock data is written around this date. */
export const TODAY = '2026-10-10'

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

/** Whole days from b to a. */
export const diff = (a: string, b: string) =>
  Math.round((new Date(a + 'T12:00:00Z').getTime() - new Date(b + 'T12:00:00Z').getTime()) / 864e5)

export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
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
