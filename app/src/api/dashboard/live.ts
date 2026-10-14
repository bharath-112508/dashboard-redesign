import { estimateHours } from '../../domain/tasks'
import { addDays, range } from '../../lib/dates'
import { leaveDays } from '../users/derive'
import type { Company, LeaveRequest, Person, Task, TimeEntry } from '../types'
import type { StaticBudget, StaticListRow } from './static'
import { dayLabel, isWeekday } from './time'

/**
 * API mode: the Dashboard figures that are fixed samples in mock mode (./static.ts),
 * computed from the real data instead.
 */

/**
 * Budget vs hours used per client project: the budget is the sum of its tickets'
 * estimates (there is no "hours sold" field), used is the time logged on it.
 * Projects without estimates are left out; the most used come first.
 */
export const budgetsFrom = (companies: Company[], tasks: Task[], entries: TimeEntry[]): StaticBudget[] =>
  companies
    .filter(c => !c.archived)
    .flatMap(c =>
      c.projects.map(p => {
        const epics = new Set([...p.epics.map(e => e.id), `none~${p.id}`])
        const own = tasks.filter(t => !t.parent && epics.has(t.epic))
        const ids = new Set(own.map(t => t.id))
        const sold = Math.round(own.reduce((a, t) => a + estimateHours(t), 0))
        const hours = Math.round(
          entries.filter(e => e.project === `c:${p.id}` || (e.task != null && ids.has(e.task))).reduce((a, e) => a + e.bill + e.non, 0),
        )
        const meta = hours > sold ? `${hours}h of ${sold}h · ${hours - sold}h over budget` : `${hours}h of ${sold}h · ${sold - hours}h left`
        return { title: `${c.name} · ${p.name}`, hours, sold, meta }
      }),
    )
    .filter(b => b.sold > 0)
    .sort((a, b) => b.hours / b.sold - a.hours / a.sold)
    .slice(0, 4)

const isCompOff = (r: LeaveRequest) => /comp/i.test(r.type)
const nameOf = (people: Person[], id: string) => people.find(p => p.id === id)?.name ?? 'Someone'
const pendingOf = (leave: LeaveRequest[]) => leave.filter(r => r.status === 'Pending').sort((a, b) => a.from.localeCompare(b.from))

/** Rows a dashboard list shows at most. */
const MAX_ROWS = 5

/** Pending requests to show: those not over yet (soonest first), then overdue ones (latest first). */
const pendingToShow = (leave: LeaveRequest[], today: string) => {
  const pending = pendingOf(leave)
  return [...pending.filter(r => r.to >= today), ...pending.filter(r => r.to < today).reverse()]
}

/** The first weekday after a leave ends. */
const backOn = (to: string) => {
  let d = addDays(to, 1)
  while (!isWeekday(d)) d = addDays(d, 1)
  return d
}

/** "Leave & attendance": who is off today, then the requests waiting for a decision (five rows at most). */
export const leaveRows = (leave: LeaveRequest[], people: Person[], today: string): StaticListRow[] => {
  const off = leave
    .filter(r => r.status === 'Approved' && r.from <= today && today <= r.to)
    .map((r): StaticListRow => ({ tag: 'Off today', tone: 'grey', title: nameOf(people, r.userId), meta: `${r.type} · back ${dayLabel(backOn(r.to))}` }))
  const pending = pendingToShow(leave, today).map((r): StaticListRow => {
    const n = leaveDays(r)
    return {
      tag: 'Pending',
      tone: 'amber',
      title: `${nameOf(people, r.userId)} · ${n} ${n === 1 ? 'day' : 'days'}`,
      meta: `${r.type} · ${range(r.from, r.to)}`,
      right: 'Approve',
      rightTone: 'ink',
    }
  })
  return [...off, ...pending].slice(0, MAX_ROWS)
}

/** Pending leave and comp-off, counted apart, and the start of the earliest pending leave. */
export const pendingCounts = (leave: LeaveRequest[]) => {
  const pending = pendingOf(leave)
  const plain = pending.filter(r => !isCompOff(r))
  return { leave: plain.length, compoff: pending.length - plain.length, oldestLeave: plain[0]?.from ?? null }
}

/** "Approvals": pending leave and comp-off requests. */
export const approvalRows = (leave: LeaveRequest[], people: Person[], today: string): StaticListRow[] =>
  pendingToShow(leave, today).slice(0, MAX_ROWS).map(r => {
    const n = leaveDays(r)
    return {
      tag: isCompOff(r) ? 'Comp-off' : 'Leave',
      tone: isCompOff(r) ? 'blue' : 'amber',
      title: `${nameOf(people, r.userId)} · ${r.type}`,
      meta: `${range(r.from, r.to)} · ${n} ${n === 1 ? 'day' : 'days'}`,
      right: 'Review',
      rightTone: 'ink',
    }
  })
