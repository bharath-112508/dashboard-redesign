import { compareTaskIds } from '../../domain/tasks'
import { useState } from 'react'
import { usePeople } from '../../api/people/directory'
import { useEntries, useTasks, useWorkspace } from '../../api/queries'
import type { Person, TimeEntry } from '../../api/types'
import { ROLE_ORDER } from '../../api/users/access'
import { hoursOf, idleHours, isEmployee, projectOf, sumHours, taskOf, weekStart } from '../../api/users/derive'
import { addDays, fmt, range, TODAY } from '../../lib/dates'
import { btnSmall, card, fieldInline, hm, PersonAvatar } from '../users/ui'
import { ROLE_LABEL } from '../../api/session/access'

type RangeKey = 'week' | '4w' | 'month' | 'lastMonth'
type Billable = 'all' | 'bill' | 'non'

const prevMonthStart = (iso: string) => {
  const y = +iso.slice(0, 4)
  const m = +iso.slice(5, 7)
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
}

const RANGES: { id: RangeKey; label: string; span: () => [string, string] }[] = [
  { id: 'week', label: 'This week', span: () => [weekStart(TODAY), addDays(weekStart(TODAY), 6)] },
  { id: '4w', label: 'Last 4 weeks', span: () => [addDays(TODAY, -27), TODAY] },
  { id: 'month', label: 'This month', span: () => [TODAY.slice(0, 8) + '01', TODAY] },
  { id: 'lastMonth', label: 'Last month', span: () => [prevMonthStart(TODAY), addDays(TODAY.slice(0, 8) + '01', -1)] },
]

const COLS = 'minmax(110px,120px) minmax(190px,1.1fr) minmax(140px,0.9fr) minmax(200px,1.6fr) 130px 96px'

/** Admin view of the shared time entries: totals, breakdowns by project and person, and the entries table. */
export function TimesheetsTab() {
  const people = usePeople().data ?? []
  const entries = useEntries().data ?? []
  const tasks = useTasks().data ?? []
  const ws = useWorkspace().data
  const [rangeKey, setRangeKey] = useState<RangeKey>('4w')
  const [user, setUser] = useState('all')
  const [role, setRole] = useState('all')
  const [project, setProject] = useState('all')
  const [billable, setBillable] = useState<Billable>('all')

  if (!ws) return <p className="text-[14px] text-slate">Loading time…</p>

  const [from, to] = RANGES.find(r => r.id === rangeKey)!.span()
  const byId = new Map<string, Person>(people.map(p => [p.id, p]))
  const personOk = (userId: string) =>
    (user === 'all' || userId === user) && (role === 'all' || byId.get(userId)?.role === role)

  const inRange = entries.filter(e => e.date >= from && e.date <= to)
  const base = inRange.filter(e => personOk(e.userId) && (billable === 'all' || (billable === 'bill' ? e.bill > 0 : e.non > 0)))
  const rows = base.filter(e => project === 'all' || projectOf(e, tasks, ws) === project)

  const projectNames = [...new Set(inRange.map(e => projectOf(e, tasks, ws)))].sort()
  const idle = idleHours(
    people.filter(p => isEmployee(p) && (user === 'all' || String(p.id) === user) && (role === 'all' || p.role === role)),
    inRange,
    from,
    to,
  )

  const projectTotals = group(base, e => projectOf(e, tasks, ws))
  const personTotals = [...new Set(base.map(e => e.userId))]
    .map(id => ({ id, logged: sumHours(base.filter(e => e.userId === id)) }))
    .sort((a, b) => b.logged - a.logged)

  const filtered = user !== 'all' || role !== 'all' || project !== 'all' || billable !== 'all'
  const clear = () => {
    setUser('all')
    setRole('all')
    setProject('all')
    setBillable('all')
  }
  const sorted = [...rows].sort((a, b) => b.date.localeCompare(a.date) || compareTaskIds(b.id, a.id))

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <select aria-label="Date range" value={rangeKey} onChange={e => setRangeKey(e.target.value as RangeKey)} className={`${fieldInline} min-w-[160px]`}>
          {RANGES.map(r => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <select aria-label="Filter by employee" value={user} onChange={e => setUser(e.target.value)} className={`${fieldInline} min-w-[180px]`}>
          <option value="all">All employees</option>
          {[...people].sort((a, b) => a.name.localeCompare(b.name)).map(p => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select aria-label="Filter by role" value={role} onChange={e => setRole(e.target.value)} className={`${fieldInline} min-w-[160px]`}>
          <option value="all">All roles</option>
          {ROLE_ORDER.map(r => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </select>
        <select aria-label="Filter by project" value={project} onChange={e => setProject(e.target.value)} className={`${fieldInline} min-w-[160px]`}>
          <option value="all">All projects</option>
          {projectNames.map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <select aria-label="Billable filter" value={billable} onChange={e => setBillable(e.target.value as Billable)} className={`${fieldInline} min-w-[190px]`}>
          <option value="all">Billable & non-billable</option>
          <option value="bill">Billable only</option>
          <option value="non">Non-billable only</option>
        </select>
        {filtered && (
          <button type="button" className={btnSmall} onClick={clear}>
            Clear filters
          </button>
        )}
        <span className="ml-auto text-[12.5px] text-slate">{range(from, to)}</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Total logged" value={hm(sumHours(rows))} />
        <Kpi label="Billable" value={hm(rows.reduce((n, e) => n + e.bill, 0))} />
        <Kpi label="Non-billable" value={hm(rows.reduce((n, e) => n + e.non, 0))} />
        <Kpi label="Idle time" value={idle ? hm(idle) : 'No idle time'} note="Employees, weekdays up to today" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${card} p-4`} aria-labelledby="by-project">
          <h2 id="by-project" className="text-[15px] font-bold text-ink">By project</h2>
          <p className="text-[12px] text-slate">Click to filter</p>
          <Bars
            items={projectTotals.map(t => ({ key: t.key, label: t.key, value: t.value, sub: hm(t.value) }))}
            active={project}
            onPick={k => setProject(project === k ? 'all' : k)}
            empty="No time logged for these filters."
          />
        </section>
        <section className={`${card} p-4`} aria-labelledby="by-employee">
          <h2 id="by-employee" className="text-[15px] font-bold text-ink">By employee</h2>
          <p className="text-[12px] text-slate">Click to filter</p>
          <ul className="mt-3 space-y-2.5">
            {personTotals.map(t => {
              const p = byId.get(t.id)
              const idleHere = p && isEmployee(p) ? idleHours([p], inRange, from, to) : 0
              const on = user === String(t.id)
              return (
                <li key={t.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => setUser(on ? 'all' : String(t.id))}
                    className={`w-full rounded-[10px] px-2 py-1.5 text-left ${on ? 'bg-sky' : 'hover:bg-canvas'}`}
                  >
                    <div className="flex items-center justify-between gap-3 text-[13px]">
                      <span className="flex min-w-0 items-center gap-2 font-semibold text-ink">
                        {p && <PersonAvatar person={p} size={22} showPhoto={p.org === 'vt'} />}
                        <span className="truncate">{p?.name ?? 'Unknown'}</span>
                      </span>
                      <span className="flex-none tabular-nums text-ink-2">
                        {hm(t.logged)}
                        {idleHere > 0 && <span className="text-rust"> · {hm(idleHere)} idle</span>}
                      </span>
                    </div>
                    <Track value={t.logged} max={Math.max(...personTotals.map(x => x.logged))} />
                  </button>
                </li>
              )
            })}
            {!personTotals.length && <li className="text-[13px] text-slate">No time logged for these filters.</li>}
          </ul>
        </section>
      </div>

      <section className={card} aria-labelledby="entries-title">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-3 px-4 py-3">
          <h2 id="entries-title" className="text-[15px] font-bold text-ink">
            Entries <span className="font-normal text-slate">· {sorted.length}</span>
          </h2>
        </div>
        <div className="overflow-x-auto">
          <div className="min-w-[860px]" role="table" aria-label="Time entries">
            <div role="row" className="grid gap-3 bg-canvas px-4 py-2.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-slate" style={{ gridTemplateColumns: COLS }}>
              <div role="columnheader">Date</div>
              <div role="columnheader">Employee</div>
              <div role="columnheader">Project</div>
              <div role="columnheader">Task & note</div>
              <div role="columnheader">Time</div>
              <div role="columnheader">Type</div>
            </div>
            {!sorted.length && <p className="px-4 py-10 text-center text-[14px] text-slate">No time logged for these filters.</p>}
            {sorted.map(e => (
              <EntryRow key={e.id} e={e} p={byId.get(e.userId)} project={projectOf(e, tasks, ws)} task={taskOf(e, tasks)} />
            ))}
          </div>
        </div>
      </section>
    </div>
  )
}

function EntryRow({ e, p, project, task }: { e: TimeEntry; p: Person | undefined; project: string; task: string }) {
  const note = e.notes.split('\n').map(s => s.replace(/^-\s*/, '').trim()).find(Boolean) ?? ''
  const split = [e.bill ? `${hm(e.bill)} billable` : '', e.non ? `${hm(e.non)} non-billable` : ''].filter(Boolean).join(' · ')
  return (
    <div role="row" className="grid items-center gap-3 border-t border-line-3 px-4 py-2.5 text-[13px]" style={{ gridTemplateColumns: COLS }}>
      <div role="cell" className="text-ink-2">{fmt(e.date)}</div>
      <div role="cell" className="flex min-w-0 items-center gap-2">
        {p && <PersonAvatar person={p} size={24} showPhoto={p.org === 'vt'} />}
        <span className="truncate font-semibold text-ink">{p?.name ?? e.user}</span>
      </div>
      <div role="cell" className="truncate text-ink-2">{project}</div>
      <div role="cell" className="min-w-0">
        <div className="truncate font-semibold text-ink">{task}</div>
        {note && <div className="truncate text-[12px] text-slate">{note}</div>}
      </div>
      <div role="cell">
        <div className="font-bold tabular-nums text-ink">{hm(hoursOf(e))}</div>
        {split && <div className="text-[11.5px] text-slate">{split}</div>}
      </div>
      <div role="cell" className="text-ink-2">{e.type}</div>
    </div>
  )
}

function Kpi({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className={`${card} px-4 py-3`}>
      <div className="text-[12px] font-semibold text-slate">{label}</div>
      <div className="mt-0.5 text-[20px] font-extrabold text-ink">{value}</div>
      {note && <div className="text-[11.5px] text-slate">{note}</div>}
    </div>
  )
}

function Track({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return (
    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sky-3">
      <div className="h-full rounded-full bg-blue" style={{ width: `${pct}%` }} />
    </div>
  )
}

function Bars({
  items,
  active,
  onPick,
  empty,
}: {
  items: { key: string; label: string; value: number; sub: string }[]
  active: string
  onPick: (key: string) => void
  empty: string
}) {
  if (!items.length) return <p className="mt-3 text-[13px] text-slate">{empty}</p>
  const max = Math.max(...items.map(i => i.value))
  return (
    <ul className="mt-3 space-y-2.5">
      {items.map(i => {
        const on = active === i.key
        return (
          <li key={i.key}>
            <button type="button" aria-pressed={on} onClick={() => onPick(i.key)} className={`w-full rounded-[10px] px-2 py-1.5 text-left ${on ? 'bg-sky' : 'hover:bg-canvas'}`}>
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate font-semibold text-ink">{i.label}</span>
                <span className="flex-none tabular-nums text-ink-2">{i.sub}</span>
              </div>
              <Track value={i.value} max={max} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** Sums `value` per key, largest first. */
function group(list: TimeEntry[], key: (e: TimeEntry) => string) {
  const m = new Map<string, number>()
  for (const e of list) m.set(key(e), (m.get(key(e)) ?? 0) + hoursOf(e))
  return [...m.entries()].map(([k, value]) => ({ key: k, value })).sort((a, b) => b.value - a.value)
}
