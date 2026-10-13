import { diff, TODAY } from '../lib/dates'
import { pal, person as greyPerson, type Person } from '../lib/theme'
import type { Sprint, Status, Task, TaskId, TimeEntry } from '../api/types'

/**
 * Orders ids by creation: number-like ids as numbers (9 before 10), backend
 * ids by their hex text (an ObjectId starts with its creation time).
 */
export const compareTaskIds = (a: TaskId, b: TaskId) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)

export const taskKey = (t: Pick<Task, 'id' | 'subKey'>) => t.subKey || 'PMT-' + t.id

export const assigneesOf = (t: Task) => t.assignees || (t.assignee ? [t.assignee] : [])

/** Hours logged on a task, from its own log and from timesheet entries. */
export const loggedHours = (t: Task, entries: TimeEntry[]) =>
  Object.values(t.time || {}).reduce((a, b) => a + b, 0) +
  entries.filter(x => x.task === t.id).reduce((a, x) => a + (x.bill || 0) + (x.non || 0), 0)

export const entryCount = (t: Task, entries: TimeEntry[]) =>
  entries.filter(x => x.task === t.id).length + Object.keys(t.time || {}).length

export const estimateHours = (t: Pick<Task, 'est'>) => parseFloat(String(t.est || '').replace(',', '.')) || 0

/** 2.25 → "2.3h" */
export const rh = (n: number) => Math.round(n * 10) / 10 + 'h'

export const statusOf = (statuses: Status[], id: string) => {
  const s = statuses.find(x => x.id === id) || statuses[0]
  const [c, soft, ink] = pal(s.p)
  return { ...s, c, soft, ink }
}

export const isOverdue = (t: Pick<Task, 'due' | 'status'>) => !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'

export const isCritical = (t: Pick<Task, 'prio'>) => t.prio === 'Critical'

export const activeSprint = (sprints: Sprint[], epic: string) =>
  sprints.find(x => x.epic === epic && x.state === 'active') || null

export const sprintsOf = (sprints: Sprint[], epic: string) =>
  sprints.filter(x => x.epic === epic).sort((a, b) => (a.start < b.start ? -1 : 1))

/** Next free number-like id among top-level tickets; backend ids (not numbers) are skipped. */
export const nextTaskId = (tasks: Task[]): TaskId =>
  String(Math.max(0, ...tasks.filter(t => !t.parent).map(t => Number(t.id)).filter(Number.isFinite)) + 1)

/** First line of the description without markdown symbols. */
export const blurb = (desc: string) =>
  (desc || '')
    .replace(/[#*_`>[\]]/g, '')
    .split('\n')
    .filter(Boolean)[0] || ''

export const fileSize = (bytes: number) =>
  bytes > 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1e3)) + ' KB'

export const fileExt = (name: string, n = 4) => (name.split('.').pop() || '').slice(0, n).toUpperCase()

/** Avatars shown on a card: up to three assignees, or an "Unassigned" placeholder. */
export const cardAvatars = (names: string[], person: (n: string) => Person = greyPerson) =>
  names.length
    ? names.slice(0, 3).map(n => {
        const m = person(n)
        return { name: n, i: m.i, bg: m.bg, color: '#fff', ring: '0 0 0 0 transparent' }
      })
    : [{ name: 'Unassigned', i: '+', bg: '#FFFFFF', color: '#3B4A5E', ring: 'inset 0 0 0 1.5px #A9B6C5' }]

/** The id for a new time entry: one more than the largest id in the shared store. */
export const nextEntryId = (entries: TimeEntry[]) =>
  String(Math.max(0, ...entries.map(e => Number(e.id)).filter(Number.isFinite)) + 1)

/**
 * The ticket a `?ticket=` value names: a number ("12") or a key ("PMT-12").
 * Returns null for anything else, so a bad link opens nothing.
 */
export const ticketIdFromParam = (v: string | null | undefined): TaskId | null => {
  if (v == null) return null
  const m = /^(?:PMT-)?(\d+)$/i.exec(v.trim())
  if (m) return String(+m[1])
  // A backend id, as the link carries it.
  return /^[a-z0-9~.-]+$/i.test(v.trim()) ? v.trim() : null
}
