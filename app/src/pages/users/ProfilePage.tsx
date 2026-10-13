import { useState } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { usePeople } from '../../api/people/directory'
import { useAccess, useCompanies, useEntries, useInternalProjects, useLeave, useNotifications, useTasks, useWorkspace } from '../../api/queries'
import { useSession } from '../../api/session/store'
import type { Person, TimeEntry, Task, Workspace } from '../../api/types'
import {
  datesBetween,
  hoursOf,
  isClientPerson,
  isEmployee,
  isWeekday,
  monthStart,
  projectNames,
  projectOf,
  projectPool,
  statusOf,
  taskOf,
  weekDays,
  weekStart,
} from '../../api/users/derive'
import { canEditPeople, DAY_HOURS } from '../../api/users/access'
import { addDays, range, TODAY } from '../../lib/dates'
import { UserForm } from './UserForm'
import { LeaveSection } from './LeaveSection'
import { PersonAvatar, RoleChip, StatusChip, btnSmall, card, hm } from './ui'

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

interface Props {
  /** The page the profile was opened from. Decides where "Back to Users" goes. */
  base: 'users' | 'employee-timesheets'
}

/** One person: their projects, week timesheet, attendance this month and leave. Shared by Users and Employee timesheets. */
export function ProfilePage({ base }: Props) {
  const { id } = useParams()
  const session = useSession()
  const people = usePeople().data
  const entries = useEntries().data
  const tasks = useTasks().data
  const ws = useWorkspace().data
  const companies = useCompanies().data ?? []
  const internal = useInternalProjects().data ?? []
  const leave = useLeave().data ?? []
  const notes = useNotifications().data ?? []
  const access = useAccess().data
  const [editing, setEditing] = useState(false)

  if (!session) return null
  if (session.role === 'cadmin') return <Navigate to="/users" replace />
  if (!people || !entries || !tasks || !ws) return <p className="px-7 py-10 text-[14px] text-slate">Loading…</p>

  const backHref = base === 'users' ? '/users' : '/employee-timesheets?tab=users'
  const person = people.find(p => p.id === id)
  if (!person) {
    return (
      <main className="px-7 pb-14 pt-6">
        <Link to={backHref} className="text-[13px] font-semibold text-blue-ink">
          ‹ Back to Users
        </Link>
        <p className="mt-6 text-[15px] text-ink-2">This person is not in the directory.</p>
      </main>
    )
  }

  const pool = projectPool(companies, internal)
  const canEdit = canEditPeople(session.role) && (session.role === 'super' || person.role !== 'super')
  const client = isClientPerson(person)
  const status = statusOf(person)
  const notesFor = notes.filter(n => n.userId === person.id)

  return (
    <main className="px-7 pb-14 pt-4">
      <Link to={backHref} className="text-[13px] font-semibold text-blue-ink no-underline hover:underline">
        ‹ Back to Users
      </Link>

      <section className={`${card} mt-3 flex flex-wrap items-center gap-4 p-5`}>
        <PersonAvatar person={person} size={64} showPhoto={!client} />
        <div className="min-w-0 flex-1">
          <h1 className="text-[24px] font-extrabold tracking-[-0.01em] text-ink">{person.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusChip person={person} />
            <RoleChip role={person.role} />
            {person.devType && <span className="text-[12.5px] text-slate">{person.devType}</span>}
            {person.emp === 'freelancer' && <span className="text-[12.5px] text-slate">Freelancer</span>}
          </div>
          <div className="mt-1 text-[13px] text-slate">
            {person.email} · {client ? companies.find(c => c.id === person.org)?.name ?? person.org : 'Viljetech'}
          </div>
        </div>
        {canEdit && (
          <button type="button" className={btnSmall} onClick={() => setEditing(true)}>
            Edit user
          </button>
        )}
      </section>

      <p className="mt-4 text-[14px] text-ink-2">
        <span className="font-bold text-ink">Working on: </span>
        {person.projects === 'all'
          ? client
            ? 'All company projects'
            : 'All projects'
          : person.projects.length
            ? projectNames(person.projects, pool).join(', ')
            : 'Not assigned to any project yet.'}
      </p>

      {client ? (
        <p className="mt-5 rounded-2xl border-[1.5px] border-line-2 bg-white p-5 text-[14px] text-slate">
          Client users do not log time, so there is no timesheet, attendance or leave for this person.
          {status === 'Invited' ? ' This invite is still pending.' : ''}
        </p>
      ) : (
        <div className="mt-5 flex flex-col gap-5">
          <WeekCard personId={person.id} person={person} entries={entries} tasks={tasks} ws={ws} />
          <AttendanceCard person={person} entries={entries} />
          <LeaveSection person={person} leave={leave} notes={notesFor} canEdit={canEdit} session={session} />
        </div>
      )}

      {editing && (
        <UserForm
          person={person}
          scope="all"
          session={session}
          people={people}
          companies={companies}
          internal={internal}
          devTypes={access?.devTypes ?? []}
          onClose={() => setEditing(false)}
        />
      )}
    </main>
  )
}

function WeekCard({
  personId,
  person,
  entries,
  tasks,
  ws,
}: {
  personId: string
  person: Person
  entries: TimeEntry[]
  tasks: Task[]
  ws: Workspace
}) {
  const [monday, setMonday] = useState(() => weekStart(TODAY))
  const days = weekDays(monday)
  const mine = entries.filter(e => e.userId === personId && days.includes(e.date))

  const rows = new Map<string, { project: string; task: string; hours: number[] }>()
  for (const e of mine) {
    const project = projectOf(e, tasks, ws)
    const task = taskOf(e, tasks)
    const key = `${project}\u0000${task}`
    const row = rows.get(key) ?? { project, task, hours: Array(7).fill(0) as number[] }
    row.hours[days.indexOf(e.date)] += hoursOf(e)
    rows.set(key, row)
  }
  const list = [...rows.values()]
  const dayTotals = days.map((_, i) => list.reduce((n, r) => n + r.hours[i], 0))
  const total = dayTotals.reduce((a, b) => a + b, 0)
  const employee = isEmployee(person)
  const idle = days.map((d, i) => (employee && isWeekday(d) && d <= TODAY ? Math.max(0, DAY_HOURS - dayTotals[i]) : 0))
  const idleTotal = idle.reduce((a, b) => a + b, 0)

  const cols = { gridTemplateColumns: 'minmax(220px,1fr) repeat(7, 62px) 80px' }

  return (
    <section className={`${card} p-5`} aria-labelledby="week-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 id="week-title" className="text-[16px] font-bold text-ink">Week timesheet</h2>
          <p className="text-[12.5px] text-slate">{range(days[0], days[6])} · {hm(total)} this week</p>
        </div>
        <div className="flex gap-1.5">
          <button type="button" className={btnSmall} aria-label="Previous week" onClick={() => setMonday(m => addDays(m, -7))}>
            ‹ Previous
          </button>
          <button type="button" className={btnSmall} onClick={() => setMonday(weekStart(TODAY))} disabled={monday === weekStart(TODAY)}>
            This week
          </button>
          <button type="button" className={btnSmall} aria-label="Next week" onClick={() => setMonday(m => addDays(m, 7))}>
            Next ›
          </button>
        </div>
      </div>

      {!employee && <p className="mt-2 text-[12.5px] text-slate">Freelancer · no required hours and no idle time.</p>}

      <div className="mt-3 overflow-x-auto">
        <div className="min-w-[640px]" role="table" aria-label="Week timesheet grid">
          <div role="row" className="grid items-center border-b border-line-3 pb-2 text-[11.5px] font-bold uppercase tracking-[0.05em] text-slate" style={cols}>
            <div role="columnheader">Project / task</div>
            {days.map((d, i) => (
              <div role="columnheader" key={d} className={`text-center ${isWeekday(d) ? '' : 'text-faint'}`}>
                {DAY_NAMES[i]} {+d.slice(8)}
              </div>
            ))}
            <div role="columnheader" className="text-right">Total</div>
          </div>
          {!list.length && <p className="py-6 text-center text-[13.5px] text-slate">No time logged this week.</p>}
          {list.map(r => (
            <div role="row" key={r.project + r.task} className="grid items-center border-b border-line-3 py-2 text-[13px]" style={cols}>
              <div role="cell" className="min-w-0 pr-2">
                <div className="truncate font-semibold text-ink">{r.task}</div>
                <div className="truncate text-[11.5px] text-slate">{r.project}</div>
              </div>
              {r.hours.map((h, i) => (
                <div role="cell" key={i} className="text-center tabular-nums text-ink-2">
                  {h ? hm(h) : '–'}
                </div>
              ))}
              <div role="cell" className="text-right font-bold tabular-nums text-ink">{hm(r.hours.reduce((a, b) => a + b, 0))}</div>
            </div>
          ))}
          <div role="row" className="grid items-center py-2 text-[13px] font-bold text-ink" style={cols}>
            <div role="cell">Daily total</div>
            {dayTotals.map((h, i) => (
              <div role="cell" key={i} className="text-center tabular-nums">
                {h ? hm(h) : '–'}
              </div>
            ))}
            <div role="cell" className="text-right tabular-nums">{hm(total)}</div>
          </div>
          {employee && (
            <>
              <div role="row" className="grid items-center py-1 text-[12.5px] text-slate" style={cols}>
                <div role="cell">Required</div>
                {days.map((d, i) => (
                  <div role="cell" key={i} className="text-center">
                    {employee && isWeekday(d) ? `${DAY_HOURS}h` : '–'}
                  </div>
                ))}
                <div role="cell" className="text-right">{hm(days.filter(isWeekday).length * DAY_HOURS)}</div>
              </div>
              <div role="row" className="grid items-center py-1 text-[12.5px] text-rust" style={cols}>
                <div role="cell">Idle</div>
                {idle.map((h, i) => (
                  <div role="cell" key={i} className="text-center">
                    {h ? hm(h) : '–'}
                  </div>
                ))}
                <div role="cell" className="text-right">{idleTotal ? hm(idleTotal) : 'No idle time'}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function AttendanceCard({ person, entries }: { person: Person; entries: TimeEntry[] }) {
  const month = datesBetween(monthStart(TODAY), TODAY).filter(isWeekday)
  const worked = new Set(entries.filter(e => e.userId === person.id && hoursOf(e) > 0).map(e => e.date))
  const workedDays = month.filter(d => worked.has(d)).length
  const employee = isEmployee(person)

  return (
    <section className={`${card} p-5`} aria-labelledby="attendance-title">
      <h2 id="attendance-title" className="text-[16px] font-bold text-ink">Attendance this month</h2>
      {!employee ? (
        <p className="mt-2 text-[13.5px] text-slate">Freelancer · no attendance tracking.</p>
      ) : !month.length ? (
        <p className="mt-2 text-[13.5px] text-slate">No working days yet this month.</p>
      ) : (
        <>
          <p className="mt-1 text-[13px] text-slate">
            {workedDays} worked · {month.length - workedDays} absent, of {month.length} working days so far
          </p>
          <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Days this month">
            {month.map(d => {
              const ok = worked.has(d)
              return (
                <li
                  key={d}
                  title={`${+d.slice(8)} ${ok ? 'worked' : 'absent'}`}
                  className={`grid h-9 min-w-[44px] place-items-center rounded-lg px-2 text-[12px] font-bold ${
                    ok ? 'bg-green-soft text-green-ink' : 'bg-peach text-rust'
                  }`}
                >
                  <span>{+d.slice(8)}</span>
                  <span className="text-[10px] font-semibold">{ok ? 'Worked' : 'Absent'}</span>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}
