import { ApiError, api } from './client'
import { allPages, liveProjects } from './companies'
import { boardIndex } from './board'
import { entryBody, entryFrom, type BackendEntry } from './timesheetMappers'
import { isClientRole } from '../session/access'
import { fmt } from '../../lib/dates'
import type { TimeCommand } from '../timesheet/commands'
import type { Session, TimeEntry, WeekSubmission } from '../types'

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/** Time is read from the first day of the previous month: this month's and last month's weeks. */
// ponytail: older time is not loaded; add a from-date to the history view if people need to look further back.
export const rangeStart = (now = new Date()) => {
  const first = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  // Back to its Monday, so a week that straddles the month is loaded whole.
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7))
  return isoDay(first)
}

/** Staff who read their team's time (the backend scopes the list to their team). */
const readsTeam = (s: Session) => s.role === 'super' || s.role === 'pm'

/**
 * The signed-in person's time entries, and their team's for a manager or
 * admin. Clients have no timesheet. Entries name their own ticket, so the
 * board is not waited for (an entry's epic is filled in when the board is
 * already loaded; pages find it from the ticket otherwise).
 */
/** All-time hours logged per project id (the backend's summary, scoped to who may read them), for the dashboard's budgets. */
export const fetchProjectHours = async (): Promise<Record<string, number>> => {
  const rows = await api.get<{ project: { id: string } | null; billable_total_minutes: number; non_billable_total_minutes: number }[]>(
    '/timesheets/summary?group_by=project',
  )
  return Object.fromEntries(rows.filter(r => r.project).map(r => [r.project!.id, (r.billable_total_minutes + r.non_billable_total_minutes) / 60]))
}

export const fetchEntries = async (session: Session | null): Promise<TimeEntry[]> => {
  if (!session || isClientRole(session.role)) return []
  const from = rangeStart()
  const [projects, mine, team] = await Promise.all([
    liveProjects(),
    allPages<BackendEntry>(`/timesheets/me?from_date=${from}`),
    readsTeam(session) ? allPages<BackendEntry>(`/timesheets?from_date=${from}`) : Promise.resolve([]),
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

// ─── Writes ──────────────────────────────────────────────────────────────

const TIME_COMMANDS = new Set(['time.log', 'time.remove', 'week.submit', 'week.reopen'])
export const isTimeApiCommand = (cmd: { type: string }): cmd is TimeCommand => TIME_COMMANDS.has(cmd.type)

const refuse = (message: string) => new ApiError(403, 'NOT_AVAILABLE', message)

/** Sends one time command. The backend always logs and submits as the signed-in person. */
export const sendTimeCommand = async (cmd: TimeCommand, session: Session | null): Promise<{ id?: string }> => {
  const self = session?.personId
  switch (cmd.type) {
    case 'time.log': {
      if (cmd.entry.userId !== self) throw refuse('You can only log your own time.')
      const body = entryBody(cmd.entry, {
        projectId: ref => (ref ? ref.slice(2) : null),
        projectOfTask: t => boardIndex.projectOfTask.get(t) ?? null,
        taskTitle: t => boardIndex.tasks.get(t)?.title ?? '',
      })
      const { id } = await api.post<{ id: string }>('/timesheets', body)
      return { id }
    }
    case 'time.remove':
      // A row just logged has a temporary id until the list reloads.
      if (!/^[a-f0-9]{24}$/i.test(cmd.id)) throw refuse('This entry is still being saved. Try again in a moment.')
      await api.delete(`/timesheets/${cmd.id}`)
      return {}
    case 'week.submit':
      if (cmd.submission.userId !== self) throw refuse('You can only submit your own week.')
      await api.put(`/timesheets/weeks/${cmd.submission.week}`, {})
      return {}
    case 'week.reopen':
      await api.delete(`/timesheets/weeks/${cmd.week}${cmd.userId === self ? '' : `?user_id=${cmd.userId}`}`)
      return {}
  }
}
