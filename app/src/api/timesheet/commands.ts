import { nextEntryId } from '../../domain/tasks'
import type { Db, PersonId, TimeEntry, WeekSubmission } from '../types'
import type { Resource } from '../commands'
import { projectOfTask } from './projects'

/**
 * Time commands: the shared time model used by Dashboard quick log, My timesheet,
 * the Tickets Timesheet tab and Employee timesheets. Every writer sends these
 * commands; nobody keeps a separate store.
 *
 * - `time.log` adds an entry. `entry.id` 0 (or an id already in use) gets the next free id.
 *   A missing `project` is filled from the ticket's epic when the ticket has one.
 * - `time.remove` deletes an entry by id.
 * - `week.submit` locks a person's week (Monday's date). `week.reopen` unlocks it.
 *
 * Submitted weeks are locked in My timesheet. The reducer does not refuse writes
 * into a submitted week (see the report): a backend has to enforce it.
 */
export type TimeCommand =
  | { type: 'time.log'; entry: TimeEntry }
  | { type: 'time.remove'; id: string }
  | { type: 'week.submit'; submission: WeekSubmission }
  | { type: 'week.reopen'; userId: PersonId; week: string }

/** An entry before it has an id. */
export type NewTimeEntry = Omit<TimeEntry, 'id'> & { id?: string }

/**
 * The `time.log` command for an entry. Send it with `useSend()` (or `useSendAsync()`),
 * for example `send(logTime({ date, userId, user, type, task, notes, bill, non }))`.
 */
export const logTime = (entry: NewTimeEntry): TimeCommand => ({ type: 'time.log', entry: { ...entry, id: entry.id ?? '' } })

export const touchesTime = (cmd: { type: string }): Resource[] => {
  switch (cmd.type) {
    case 'time.log':
    case 'time.remove':
      return ['entries']
    case 'week.submit':
    case 'week.reopen':
      return ['weekSubmissions']
    default:
      return []
  }
}

/** Gives a `time.log` entry an id that is free in `db`. Other commands are returned unchanged. */
export const assignTimeIds = <C extends { type: string }>(db: Db, cmd: C): C => {
  if (cmd.type !== 'time.log') return cmd
  const c = cmd as unknown as TimeCommand & { type: 'time.log' }
  if (c.entry.id && !db.entries.some(e => e.id === c.entry.id)) return cmd
  const next = nextEntryId(db.entries)
  return { ...c, entry: { ...c.entry, id: next } } as unknown as C
}

const sameWeek = (s: WeekSubmission, userId: PersonId, week: string) => s.userId === userId && s.week === week

export const reduceTime = <C extends { type: string }>(db: Db, cmd: C): Db => {
  const c = cmd as unknown as TimeCommand
  switch (c.type) {
    case 'time.log': {
      const e = c.entry
      // Tasks and companies may not be in the React Query cache yet (optimistic update); then no project is derived.
      const project = e.project ?? (e.task !== null ? projectOfTask(e.task, db.tasks ?? [], db.companies ?? []) : undefined)
      const entry: TimeEntry = project ? { ...e, project } : e
      return { ...db, entries: [...db.entries, entry] }
    }
    case 'time.remove':
      return { ...db, entries: db.entries.filter(e => e.id !== c.id) }
    case 'week.submit': {
      const s = c.submission
      const rest = (db.weekSubmissions ?? []).filter(w => !sameWeek(w, s.userId, s.week))
      return { ...db, weekSubmissions: [...rest, s] }
    }
    case 'week.reopen':
      return { ...db, weekSubmissions: (db.weekSubmissions ?? []).filter(w => !sameWeek(w, c.userId, c.week)) }
    default:
      return db
  }
}
