import type { TimeEntry } from '../types'

/** A time entry as the backend returns it (`GET /timesheets`, `/timesheets/me`). */
export interface BackendEntry {
  id: string
  user_id: string
  local_date: string
  entry_type: 'general' | 'task_linked'
  project_id: string | null
  task_id: string | null
  general_category: string | null
  billable_total_minutes: number
  non_billable_total_minutes: number
  description: string
  work_type?: string | null
  /** Present on the team list. */
  user?: { id: string; full_name: string } | null
  /** The ticket's id and title (both lists). */
  task?: { id: string; title: string | null } | null
}

/** Decimal hours as whole hours and minutes (1.75 → 1 h 45 m). */
export const minutesSplit = (h: number) => {
  const m = Math.round(h * 60)
  return { hours: Math.floor(m / 60), minutes: m % 60 }
}

/** The description the backend requires: the note, else what the entry is about. */
const describe = (t: Pick<TimeEntry, 'notes' | 'area' | 'type' | 'task'>, taskTitle: (id: string) => string) =>
  t.notes.trim() || t.area || (t.task ? taskTitle(t.task) : '') || t.type

export const entryFrom = (
  e: BackendEntry,
  ctx: {
    userName: (id: string) => string
    projectRef: (projectId: string | null) => string | undefined
    epicOfTask: (taskId: string) => string | undefined
    taskTitle: (taskId: string) => string
  },
): TimeEntry => {
  const area = e.entry_type === 'general' ? e.general_category ?? undefined : undefined
  const type = e.work_type || 'General'
  // A description that only stood in for an empty note reads as no note.
  const title = e.task?.title ?? (e.task_id ? ctx.taskTitle(e.task_id) : '')
  const fill = [area, title.trim(), e.work_type].filter(Boolean)
  const project = ctx.projectRef(e.project_id)
  const epic = e.task_id ? ctx.epicOfTask(e.task_id) : undefined
  return {
    id: e.id,
    date: e.local_date,
    userId: e.user_id,
    user: e.user?.full_name || ctx.userName(e.user_id),
    type,
    task: e.task_id,
    ...(area !== undefined ? { area } : {}),
    ...(epic ? { epic } : {}),
    ...(project ? { project } : {}),
    notes: fill.includes(e.description) ? '' : e.description,
    bill: e.billable_total_minutes / 60,
    non: e.non_billable_total_minutes / 60,
  }
}

export const entryBody = (
  t: TimeEntry,
  ctx: { projectId: (ref: string | undefined) => string | null; projectOfTask: (taskId: string) => string | null; taskTitle: (taskId: string) => string },
): Record<string, unknown> => {
  const bill = minutesSplit(t.bill)
  const non = minutesSplit(t.non)
  const where = t.task
    ? { entry_type: 'task_linked', task_id: t.task, project_id: ctx.projectOfTask(t.task) ?? ctx.projectId(t.project) }
    : { entry_type: 'general', project_id: ctx.projectId(t.project), general_category: t.area || null }
  return {
    ...where,
    local_date: t.date,
    work_type: t.type,
    description: describe(t, ctx.taskTitle),
    billable_hours: bill.hours,
    billable_minutes: bill.minutes,
    non_billable_hours: non.hours,
    non_billable_minutes: non.minutes,
  }
}
