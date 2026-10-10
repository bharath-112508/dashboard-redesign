import type { Company, InternalProject, Person, Task, TimeEntry, WeekSubmission } from '../../api/types'
import { entryProject, findProject, taskLabel, ticketKeyOf } from '../../api/timesheet/projects'
import { entryHours } from '../../api/timesheet/week'
import type { ExportRow } from '../../api/timesheet/export'

/** What the My timesheet views need, computed once by TimesheetPage. */
export interface TimeCtx {
  me: Person
  /** Signed-in user is a freelancer: idle time is not shown (not modelled for them). */
  freelancer: boolean
  /** Today, from lib/dates (the mock anchor). */
  today: string
  tasks: Task[]
  companies: Company[]
  internal: InternalProject[]
  /** My entries only (userId = me). */
  mine: TimeEntry[]
  submissions: WeekSubmission[]
  /** Company id from `?company=`, or null. */
  companyId: string | null
}

export const submissionOf = (ctx: TimeCtx, week: string): WeekSubmission | undefined =>
  ctx.submissions.find(s => s.userId === ctx.me.id && s.week === week)

/** Project label for an entry, or "No project". */
export const projectNameOf = (e: TimeEntry, ctx: TimeCtx): string => {
  const v = entryProject(e, ctx.tasks, ctx.companies)
  return (v && findProject(v, ctx.companies, ctx.internal)?.label) || 'No project'
}

/** "PMT-10 · Login with BankID", or the area text for a text entry. */
export const taskNameOf = (e: TimeEntry, ctx: TimeCtx): string => taskLabel(e, ctx.tasks)

export const billableFlag = (e: Pick<TimeEntry, 'bill' | 'non'>): 'Yes' | 'No' | 'Split' =>
  e.bill > 0 && e.non > 0 ? 'Split' : e.bill > 0 ? 'Yes' : 'No'

/** The row an export file shows for one entry. */
export const toExportRow = (e: TimeEntry, ctx: TimeCtx): ExportRow => {
  const project = projectNameOf(e, ctx)
  const ticket = e.task === null ? undefined : ctx.tasks.find(t => t.id === e.task)
  return {
    date: e.date,
    project: project === 'No project' ? '' : project,
    type: e.type,
    ticket: ticketKeyOf(e, ctx.tasks),
    task: e.task === null ? e.area || '' : ticket ? ticket.title : '(ticket removed)',
    hours: entryHours(e),
    bill: e.bill || 0,
    non: e.non || 0,
    billable: billableFlag(e),
    note: e.notes || '',
  }
}

/** Sums for a list of entries. */
export const totalsOf = (list: TimeEntry[]) => {
  const bill = list.reduce((a, e) => a + (e.bill || 0), 0)
  const non = list.reduce((a, e) => a + (e.non || 0), 0)
  return { bill, non, total: bill + non }
}

/** Shared field and button styles, matching the Tickets page. */
export const ui = {
  label: 'flex flex-col gap-[5px] text-[12px] font-semibold text-ink-2',
  control:
    'h-9 w-full min-w-0 rounded-[10px] border-[1.5px] border-line bg-white px-2.5 text-[13.5px] text-ink outline-0 focus:border-blue disabled:bg-canvas disabled:text-slate',
  select:
    'h-9 w-full min-w-0 cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-line bg-white pl-3 pr-[30px] text-[13.5px] font-semibold text-ink outline-0 focus:border-blue disabled:cursor-not-allowed disabled:bg-canvas disabled:text-slate',
  primary:
    'h-9 cursor-pointer rounded-[10px] border-0 bg-blue px-3.5 text-[13.5px] font-semibold text-white hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-45',
  ghost:
    'h-9 cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white px-3.5 text-[13.5px] font-semibold text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-45',
  error: 'text-[12px] font-semibold text-red',
}
