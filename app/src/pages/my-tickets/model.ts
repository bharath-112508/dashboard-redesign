import { diff, TODAY } from '../../lib/dates'
import type { Epic, Sprint, Task, TimeEntry } from '../../api/types'
import { assigneesOf, compareTaskIds, estimateHours, isCritical, isOverdue, loggedHours } from '../../domain/tasks'

/**
 * My tickets is a view over the same ticket and time store as the Tickets page,
 * so every number here is computed from it (nothing is typed in).
 */

/** Top-level tickets assigned to this person. Subtasks are not counted; they belong to their ticket. */
export const mineOf = (tasks: Task[], name: string) => tasks.filter(t => !t.parent && assigneesOf(t).includes(name))

/** Days until the due date from TODAY (negative when late), or null when there is none. */
export const daysTo = (t: Pick<Task, 'due'>) => (t.due ? diff(t.due, TODAY) : null)

/** Due label as on the cards: "3d late", "Today", "Tomorrow", a short date, or "No date". */
export const dueLabel = (t: Pick<Task, 'due' | 'status'>) => {
  const d = daysTo(t)
  if (d === null) return 'No date'
  if (t.status !== 'done' && d < 0) return -d + 'd late'
  if (d === 0) return 'Today'
  if (d === 1) return 'Tomorrow'
  const [, m, day] = t.due.split('-')
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${+day} ${MON[+m - 1]}`
}

export type DueGroup = 'Overdue' | 'Today' | 'This week' | 'Later' | 'No due date' | 'Done'
export const DUE_ORDER: DueGroup[] = ['Overdue', 'Today', 'This week', 'Later', 'No due date', 'Done']

export const dueGroupOf = (t: Pick<Task, 'due' | 'status'>): DueGroup => {
  if (t.status === 'done') return 'Done'
  const d = daysTo(t)
  if (d === null) return 'No due date'
  if (d < 0) return 'Overdue'
  if (d === 0) return 'Today'
  if (d <= 6) return 'This week'
  return 'Later'
}

/** Hours on tasks, the same figure Tickets shows for each ticket. */
export const hoursOn = (tasks: Task[], entries: TimeEntry[]) => tasks.reduce((a, t) => a + loggedHours(t, entries), 0)

export const estimateOn = (tasks: Task[]) => tasks.reduce((a, t) => a + estimateHours(t), 0)

export type MineFilter = { tab: 'open' | 'done' | 'all'; proj: string; q: string }

/** Applies the tab, project chip and search to my tickets. */
export const filterMine = (mine: Task[], f: MineFilter) => {
  const q = f.q.trim().toLowerCase()
  return mine.filter(
    t =>
      (f.tab === 'all' || (f.tab === 'done' ? t.status === 'done' : t.status !== 'done')) &&
      (!f.proj || t.epic === f.proj) &&
      (!q || (t.title + ' ' + ('PMT-' + t.id)).toLowerCase().includes(q)),
  )
}

export interface Group {
  key: string
  label: string
  tasks: Task[]
}

/** Groups tickets by due date, sprint or project. Empty groups are left out. */
export const groupMine = (tasks: Task[], by: 'due' | 'sprint' | 'proj', sprints: Sprint[], epics: Epic[]): Group[] => {
  // Earliest due first, undated last, then by id.
  const byDue = (a: Task, b: Task) => {
    const ka = a.due || '\uffff'
    const kb = b.due || '\uffff'
    return ka < kb ? -1 : ka > kb ? 1 : compareTaskIds(a.id, b.id)
  }
  const map = new Map<string, Group>()
  const put = (key: string, label: string, t: Task) => {
    const g = map.get(key) ?? { key, label, tasks: [] }
    g.tasks.push(t)
    map.set(key, g)
  }
  if (by === 'due') {
    tasks.forEach(t => put(dueGroupOf(t), dueGroupOf(t), t))
    return DUE_ORDER.filter(k => map.has(k)).map(k => ({ ...map.get(k)!, tasks: map.get(k)!.tasks.sort(byDue) }))
  }
  if (by === 'sprint') {
    tasks.forEach(t => {
      const s = sprints.find(x => x.id === t.sprint)
      const ep = epics.find(e => e.id === t.epic)
      put(s ? s.id : 'backlog', s ? s.name + (ep ? ' · ' + ep.name : '') : 'Backlog', t)
    })
    const order = (k: string) => (k === 'backlog' ? '\uffff' : (sprints.find(x => x.id === k)?.start ?? ''))
    return [...map.values()].sort((a, b) => (order(a.key) < order(b.key) ? -1 : 1)).map(g => ({ ...g, tasks: g.tasks.sort(byDue) }))
  }
  tasks.forEach(t => {
    const ep = epics.find(e => e.id === t.epic)
    put(t.epic, ep?.name ?? t.epic, t)
  })
  return epics
    .filter(e => map.has(e.id))
    .map(e => ({ ...map.get(e.id)!, tasks: map.get(e.id)!.tasks.sort(byDue) }))
}

/** The numbers on the five KPI cards, from my tickets. */
export const kpisOf = (mine: Task[], entries: TimeEntry[]) => {
  const open = mine.filter(t => t.status !== 'done')
  const critical = open.filter(isCritical)
  const overdue = open.filter(t => isOverdue(t))
  const week = open.filter(t => {
    const d = daysTo(t)
    return d !== null && d >= 0 && d <= 6
  })
  const oldest = overdue.reduce((m, t) => Math.max(m, -(daysTo(t) ?? 0)), 0)
  return {
    open,
    critical,
    overdue,
    week,
    projects: new Set(open.map(t => t.epic)).size,
    sprints: new Set(open.map(t => t.sprint).filter(Boolean)).size,
    oldestLate: oldest,
    hours: hoursOn(open, entries),
    estimated: estimateOn(open),
  }
}

/** Critical or overdue open tickets, critical first, for "Needs you now". */
export const needsYou = (mine: Task[]) =>
  mine
    .filter(t => t.status !== 'done' && (isCritical(t) || isOverdue(t)))
    .sort((a, b) => {
      if (isCritical(a) !== isCritical(b)) return isCritical(a) ? -1 : 1
      const ka = a.due || '\uffff'
      const kb = b.due || '\uffff'
      return ka < kb ? -1 : ka > kb ? 1 : compareTaskIds(a.id, b.id)
    })

/**
 * Comments others left on a ticket since this person last did anything on it
 * (activity is newest first). Shown as the "new comments" badge.
 */
export const newCommentsFor = (t: Pick<Task, 'acts'>, name: string) => {
  let n = 0
  for (const a of t.acts) {
    if (a.who === name) break
    if (a.kind === 'comment') n++
  }
  return n
}
