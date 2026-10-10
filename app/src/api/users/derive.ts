import type { Company, InternalProject, LeaveRequest, Person, Task, TimeEntry, Workspace } from '../types'
import { addDays, isIso, plural, TODAY } from '../../lib/dates'
import { taskKey } from '../../domain/tasks'
import { ANNUAL_ALLOWANCE, DAY_HOURS } from './access'

export type PersonStatus = 'Active' | 'Deactivated' | 'Invited'

/** Invited wins: an invited person is inactive until an admin activates them. */
export const statusOf = (p: Pick<Person, 'active' | 'invited'>): PersonStatus =>
  p.invited ? 'Invited' : p.active ? 'Active' : 'Deactivated'

export const isClientPerson = (p: Pick<Person, 'org'>) => p.org !== 'vt'

/** Freelancers and client users have no required hours and no idle time. */
export const isEmployee = (p: Pick<Person, 'org' | 'emp'>) => p.org === 'vt' && p.emp !== 'freelancer'

export interface PoolProject {
  id: string
  name: string
  /** Company name, or 'Viljetech' for internal projects. */
  company: string
  orgId: string
}

/**
 * Projects a person can be given access to. Viljetech sees every active
 * company's projects and every internal project; a client company sees only its own.
 */
export const projectPool = (companies: Company[], internal: InternalProject[], orgId?: string): PoolProject[] => {
  if (orgId) {
    return companies
      .filter(c => c.id === orgId && !c.archived)
      .flatMap(c => c.projects.map(p => ({ id: p.id, name: p.name, company: c.name, orgId: c.id })))
  }
  const fromCompanies = companies
    .filter(c => !c.archived)
    .flatMap(c => c.projects.map(p => ({ id: p.id, name: p.name, company: c.name, orgId: c.id })))
  const fromInternal = internal.map(p => ({ id: p.id, name: p.name, company: 'Viljetech', orgId: 'vt' }))
  return [...fromCompanies, ...fromInternal]
}

export const projectNames = (ids: 'all' | string[], pool: PoolProject[]): string[] =>
  ids === 'all' ? pool.map(p => p.name) : ids.map(id => pool.find(p => p.id === id)?.name ?? id)

export const accessSummary = (p: Person): string => {
  if (p.projects === 'all') return isClientPerson(p) ? 'All company projects' : 'All projects'
  return p.projects.length ? plural(p.projects.length, 'project') : 'No projects'
}

// ---- dates (ISO strings, UTC-safe)

const dow = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay()

export const isWeekday = (iso: string) => dow(iso) >= 1 && dow(iso) <= 5

/** The Monday of the week containing `iso`. */
export const weekStart = (iso: string) => addDays(iso, -((dow(iso) + 6) % 7))

export const weekDays = (monday: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(monday, i))

/** Every date from `from` to `to`, both inclusive. Empty when either is not a date. */
export const datesBetween = (from: string, to: string): string[] => {
  if (!isIso(from) || !isIso(to)) return []
  const out: string[] = []
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d)
  return out
}

export const weekdaysBetween = (from: string, to: string) => datesBetween(from, to).filter(isWeekday).length

/** The first of the month that contains `iso`. */
export const monthStart = (iso: string) => iso.slice(0, 8) + '01'

// ---- time

export const hoursOf = (e: Pick<TimeEntry, 'bill' | 'non'>) => (e.bill || 0) + (e.non || 0)

export const sumHours = (entries: TimeEntry[]) => entries.reduce((n, e) => n + hoursOf(e), 0)

/** Project label for an entry: the ticket's epic (until epics link to projects), the entry's own epic, or its area for text entries. */
export const projectOf = (e: TimeEntry, tasks: Task[], ws: Workspace): string => {
  const task = e.task != null ? tasks.find(t => t.id === e.task) : undefined
  const epicId = e.epic ?? task?.epic
  if (epicId) return ws.epics.find(x => x.id === epicId)?.name ?? epicId
  return e.area || 'No project'
}

/** The ticket key and title of an entry, or its area for a text entry. */
export const taskOf = (e: TimeEntry, tasks: Task[]): string => {
  const task = e.task != null ? tasks.find(t => t.id === e.task) : undefined
  return task ? `${taskKey(task)} ${task.title}` : e.area || 'No task'
}

/** Hours short of the daily target, summed over the weekdays from `from` to `to` (no later than today). */
export const idleHours = (employees: Person[], entries: TimeEntry[], from: string, to: string): number => {
  const days = datesBetween(from, to < TODAY ? to : TODAY).filter(isWeekday)
  let total = 0
  for (const p of employees) {
    for (const d of days) {
      const logged = sumHours(entries.filter(e => e.userId === p.id && e.date === d))
      total += Math.max(0, DAY_HOURS - logged)
    }
  }
  return total
}

// ---- leave

export const leaveDays = (r: Pick<LeaveRequest, 'from' | 'to'>) => weekdaysBetween(r.from, r.to)

export const annualUsed = (leave: LeaveRequest[], userId: number) =>
  leave.filter(r => r.userId === userId && r.type === 'Annual' && r.status === 'Approved').reduce((n, r) => n + leaveDays(r), 0)

export const annualPending = (leave: LeaveRequest[], userId: number) =>
  leave.filter(r => r.userId === userId && r.type === 'Annual' && r.status === 'Pending').reduce((n, r) => n + leaveDays(r), 0)

export const annualLeft = (leave: LeaveRequest[], userId: number) => ANNUAL_ALLOWANCE - annualUsed(leave, userId)
