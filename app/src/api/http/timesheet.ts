import { api } from './client'
import { allPages, liveProjects } from './companies'
import { boardIndex, fetchTasks } from './board'
import { entryFrom, type BackendEntry } from './timesheetMappers'
import { isClientRole } from '../session/access'
import { fmt } from '../../lib/dates'
import type { Session, TimeEntry, WeekSubmission } from '../types'

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Time is read from the first day of the previous month: this month's and last month's weeks. */
// ponytail: older time is not loaded; add a from-date to the history view if people need to look further back.
export const rangeStart = (now = new Date()) => isoDay(new Date(now.getFullYear(), now.getMonth() - 1, 1))

/** Staff who read their team's time (the backend scopes the list to their team). */
const readsTeam = (s: Session) => s.role === 'super' || s.role === 'pm'

/**
 * The signed-in person's time entries, and their team's for a manager or
 * admin. Clients have no timesheet. The board is read first so ticket entries
 * know their epic and title.
 */
export const fetchEntries = async (session: Session | null): Promise<TimeEntry[]> => {
  if (!session || isClientRole(session.role)) return []
  const from = rangeStart()
  const [projects, mine, team] = await Promise.all([
    liveProjects(),
    allPages<BackendEntry>(`/timesheets/me?from_date=${from}`),
    readsTeam(session) ? allPages<BackendEntry>(`/timesheets?from_date=${from}`) : Promise.resolve([]),
    fetchTasks(session),
  ])
  const kind = new Map(projects.map(p => [p.id, p.company_id ? 'c' : 'i']))
  const ctx = {
    userName: (id: string) => (id === session.personId ? session.name : ''),
    projectRef: (id: string | null) => (id && kind.has(id) ? `${kind.get(id)}:${id}` : undefined),
    epicOfTask: (id: string) => boardIndex.tasks.get(id)?.epic,
    taskTitle: (id: string) => boardIndex.tasks.get(id)?.title ?? '',
  }
  // The team list includes the person's own rows; keep one of each.
  const byId = new Map<string, BackendEntry>()
  for (const e of [...mine, ...team]) byId.set(e.id, { ...byId.get(e.id), ...e })
  return [...byId.values()].map(e => entryFrom(e, ctx))
}

type BackendWeek = { id: string; user_id: string; week_start: string; submitted_at: string }

/** Submitted weeks: the person's own, or their team's for a manager or admin. */
export const fetchWeekSubmissions = async (session: Session | null): Promise<WeekSubmission[]> => {
  if (!session || isClientRole(session.role)) return []
  const rows = await api.get<BackendWeek[]>(`/timesheets/weeks?from_date=${rangeStart()}`)
  return rows.map(w => {
    const d = new Date(w.submitted_at)
    return { userId: w.user_id, week: w.week_start, when: `${fmt(isoDay(d))}, ${pad(d.getHours())}:${pad(d.getMinutes())}` }
  })
}
