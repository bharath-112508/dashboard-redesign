import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { usePeople } from '../../api/people/directory'
import { useEntries, useTasks, useWorkspace } from '../../api/queries'
import type { Task } from '../../api/types'
import { Avatar } from '../../components/ui'
import { fmt, range, short, TODAY } from '../../lib/dates'
import { PRIO, TYPES } from '../../lib/theme'
import { isCritical, isOverdue, loggedHours, statusOf, taskKey } from '../../domain/tasks'
import { avatarFor, useMe } from '../../features/tickets/useMe'
import {
  dueLabel,
  filterMine,
  groupMine,
  kpisOf,
  mineOf,
  needsYou,
  weekDays,
  weekHours,
  WEEK_TARGET_HOURS,
  type MineFilter,
} from './model'

/** "2h 30m"; "0h" for nothing. */
const fh = (n: number) => {
  const m = Math.round(n * 60)
  const H = Math.floor(m / 60)
  const M = m % 60
  return (H ? H + 'h' : '') + (M ? (H ? ' ' : '') + M + 'm' : '') || '0h'
}

const card = 'rounded-2xl border-[1.5px] border-line-2 bg-white'
const chipBase = 'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border-[1.5px] px-3 text-[13px] font-semibold'

/** Empty state inside a list or card. */
const Empty = ({ children }: { children: ReactNode }) => <div className="p-6 text-center text-[13.5px] text-ink-2">{children}</div>

/** My tickets: what I am working on, across the same store as the Tickets page. */
export function MyTicketsPage() {
  const me = useMe()
  const tasks = useTasks().data ?? []
  const entries = useEntries().data ?? []
  const ws = useWorkspace().data
  const people = usePeople().data ?? []
  const [f, setF] = useState<MineFilter>({ tab: 'open', proj: '', q: '' })
  const [by, setBy] = useState<'due' | 'sprint' | 'proj'>('due')

  if (!ws) return <div className="p-12 text-center text-[14px] text-muted">Loading…</div>

  const mine = mineOf(tasks, me.name)
  const k = kpisOf(mine, entries)
  const first = me.name.split(' ')[0] || 'there'
  const needs = needsYou(mine)
  const counts = {
    open: mine.filter(t => t.status !== 'done').length,
    done: mine.filter(t => t.status === 'done').length,
    all: mine.length,
  }
  const list = filterMine(mine, f)
  const groups = groupMine(list, by, ws.sprints, ws.epics)
  const projects = ws.epics.filter(e => mine.some(t => t.epic === e.id))
  const setTab = (tab: MineFilter['tab']) => setF(p => ({ ...p, tab }))
  const kpiGo = (tab: MineFilter['tab'], sort: 'due' | 'sprint' | 'proj' = 'due') => {
    setF(p => ({ ...p, tab }))
    setBy(sort)
  }

  // Week bars: Monday to Friday of this week, from the shared time store.
  const days = weekDays(TODAY)
  const hours = weekHours(entries, me.id, days)
  const weekTotal = hours.reduce((a, b) => a + b, 0)
  const barMax = Math.max(WEEK_TARGET_HOURS / 5, ...hours)
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

  // Sprints and epics with open work of mine.
  const openSprintIds = [...new Set(k.open.map(t => t.sprint).filter((x): x is string => !!x))]
  const mySprints = ws.sprints.filter(s => openSprintIds.includes(s.id))
  const myEpics = ws.epics.filter(e => k.open.some(t => t.epic === e.id))

  // The feed: the latest activity on my tickets, newest first.
  const feed = mine
    .flatMap(t => t.acts.slice(0, 3).map(a => ({ a, t })))
    .slice(0, 5)

  const avatar = (name: string) => {
    const m = avatarFor(people, name)
    return <Avatar i={m.i} bg={m.bg} size={22} radius={6} font={9} title={name} />
  }

  const kpis = [
    { id: 'open', label: 'Open tickets', value: String(k.open.length), sub: 'Across ' + k.projects + (k.projects === 1 ? ' project' : ' projects'), tone: '#4870E8', go: () => kpiGo('open') },
    {
      id: 'critical',
      label: 'Critical',
      value: String(k.critical.length),
      sub: k.critical.length ? 'Fix these first' : 'None right now',
      tone: '#C0392B',
      go: () => kpiGo('open'),
    },
    {
      id: 'overdue',
      label: 'Overdue',
      value: String(k.overdue.length),
      sub: k.overdue.length ? 'Oldest ' + k.oldestLate + 'd late' : 'Nothing late',
      tone: '#C0392B',
      go: () => kpiGo('open'),
    },
    { id: 'week', label: 'Due this week', value: String(k.week.length), sub: 'Next 7 days', tone: '#B98A2F', go: () => kpiGo('open') },
    {
      id: 'hours',
      label: 'Hours on open work',
      value: fh(k.hours),
      sub: 'of ' + fh(k.estimated) + ' estimated',
      tone: '#3F9079',
      go: () => setTab('open'),
    },
  ]

  const row = (t: Task) => {
    const st = statusOf(ws.statuses, t.status)
    const ty = TYPES[t.type]
    const pr = PRIO[t.prio] || PRIO.Low
    const sp = ws.sprints.find(s => s.id === t.sprint)
    const late = isOverdue(t)
    return (
      <Link
        key={t.id}
        to={`/tickets/board?ticket=${taskKey(t)}`}
        data-row={taskKey(t)}
        className="grid cursor-pointer items-center gap-3 border-t-[1.5px] border-line-3 px-4 py-3 no-underline hover:bg-canvas"
        style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="tnum flex-none text-[12px] font-semibold text-blue-ink">{taskKey(t)}</span>
            <span className="min-w-0 truncate text-[14px] font-semibold text-ink">{t.title}</span>
          </span>
          <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-2">
            <span className="inline-flex items-center gap-1 rounded-full px-2 py-px font-semibold" style={{ background: st.soft, color: st.ink }}>
              <span className="size-1.5 rounded-full" style={{ background: st.c }} />
              {st.name}
            </span>
            <span className="rounded-full px-2 py-px font-semibold" style={{ background: ty[1], color: ty[0] }}>
              {t.type}
            </span>
            <span className="rounded-full px-2 py-px font-semibold" style={{ background: pr[1], color: pr[0] }}>
              {t.prio}
            </span>
            {sp && <span>{sp.name}</span>}
            <span className="tnum" style={{ color: late ? '#C0392B' : undefined, fontWeight: late ? 700 : 500 }}>
              {dueLabel(t)}
            </span>
            {loggedHours(t, entries) > 0 && <span className="tnum">{fh(loggedHours(t, entries))} logged</span>}
          </span>
        </span>
        <span className="inline-flex items-center gap-1 text-[13px] font-semibold text-blue-ink">Open ›</span>
      </Link>
    )
  }

  return (
    <div data-page="my-tickets" className="flex flex-col gap-5 pb-14 pt-2">
      <div>
        <h1 className="m-0 text-[24px] font-bold tracking-[-0.02em] text-ink">My tickets</h1>
        <p className="mt-1 text-[14px] text-ink-2">
          Hi {first}, you have {k.open.length} open tickets in {k.sprints} sprints
          {k.critical.length ? `, ${k.critical.length} of them critical.` : '.'}
        </p>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(190px,100%),1fr))' }}>
        {kpis.map(c => (
          <button key={c.id} type="button" onClick={c.go} className={`${card} cursor-pointer px-4 py-3.5 text-left hover:border-blue`}>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-ink-2">{c.label}</div>
            <div className="tnum mt-1.5 text-[28px] font-semibold leading-none" style={{ color: c.tone }}>
              {c.value}
            </div>
            <div className="mt-1.5 text-[12.5px] text-ink-2">{c.sub}</div>
          </button>
        ))}
      </div>

      {needs.length > 0 && (
        <section className="rounded-2xl border-[1.5px] border-[#F0B9AE] bg-[#FDF3F1] p-4">
          <div className="flex items-baseline gap-2">
            <h2 className="m-0 text-[15px] font-bold text-[#7A2A1A]">Needs you now</h2>
            <span className="text-[12.5px] text-[#9A3A24]">
              {needs.length} critical or overdue
            </span>
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {needs.map(t => (
              <Link
                key={t.id}
                to={`/tickets/board?ticket=${taskKey(t)}`}
                className="flex items-center gap-3 rounded-xl border-[1.5px] border-[#F0B9AE] bg-white px-3.5 py-2.5 no-underline hover:border-[#C0392B]"
              >
                <span className="tnum flex-none text-[12px] font-semibold text-blue-ink">{taskKey(t)}</span>
                <span className="min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{t.title}</span>
                {isCritical(t) && (
                  <span className="flex-none rounded-full bg-[#C0392B] px-2 py-px text-[11.5px] font-bold text-white">● Critical</span>
                )}
                {isOverdue(t) && <span className="flex-none text-[12.5px] font-bold text-[#C0392B]">{dueLabel(t)}</span>}
                <span className="flex-none text-[13px] font-semibold text-blue-ink">Open ›</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className={`${card} min-w-0 overflow-hidden`}>
          <div className="flex flex-wrap items-center gap-2.5 px-4 pt-3.5">
            <div className="inline-flex rounded-[10px] bg-canvas p-[3px]" role="tablist">
              {(
                [
                  ['open', 'Open', counts.open],
                  ['done', 'Done', counts.done],
                  ['all', 'All', counts.all],
                ] as const
              ).map(([id, label, n]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={f.tab === id}
                  onClick={() => setTab(id)}
                  className="h-8 cursor-pointer rounded-[8px] border-0 px-3 text-[13px] font-semibold"
                  style={{ background: f.tab === id ? '#fff' : 'transparent', color: f.tab === id ? '#1B2D45' : '#56657A' }}
                >
                  {label} <span className="tnum text-ink-2">{n}</span>
                </button>
              ))}
            </div>
            <input
              value={f.q}
              onChange={e => setF(p => ({ ...p, q: e.target.value }))}
              placeholder="Search my tickets"
              aria-label="Search my tickets"
              className="h-8 min-w-[180px] flex-1 rounded-[10px] border-[1.5px] border-line bg-white px-3 text-[13.5px] text-ink outline-0"
            />
            <select
              value={by}
              onChange={e => setBy(e.target.value as typeof by)}
              aria-label="Group by"
              className="h-8 cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white px-2.5 text-[13px] font-semibold text-ink"
            >
              <option value="due">Group by due date</option>
              <option value="sprint">Group by sprint</option>
              <option value="proj">Group by project</option>
            </select>
          </div>
          <div className="flex flex-wrap gap-1.5 px-4 pb-3 pt-2.5">
            <button
              type="button"
              onClick={() => setF(p => ({ ...p, proj: '' }))}
              className={chipBase}
              style={{ borderColor: f.proj ? '#E4EAF0' : '#4870E8', color: f.proj ? '#3B4A5E' : '#1F3FAF', background: f.proj ? '#fff' : '#EEF3FB' }}
            >
              All projects
            </button>
            {projects.map(e => {
              const on = f.proj === e.id
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setF(p => ({ ...p, proj: on ? '' : e.id }))}
                  className={chipBase}
                  style={{ borderColor: on ? '#4870E8' : '#E4EAF0', color: on ? '#1F3FAF' : '#3B4A5E', background: on ? '#EEF3FB' : '#fff' }}
                >
                  {e.name}
                </button>
              )
            })}
          </div>

          {groups.length === 0 && <Empty>No tickets match these filters.</Empty>}
          {groups.map(g => {
            const hrs = g.tasks.reduce((a, t) => a + loggedHours(t, entries), 0)
            return (
              <div key={g.key}>
                <div className="flex items-center gap-2 bg-canvas px-4 py-2 text-[12.5px] font-semibold text-ink-2">
                  <span className="text-ink">{g.label}</span>
                  <span className="tnum">{g.tasks.length}</span>
                  {hrs > 0 && <span className="tnum ml-auto">{fh(hrs)} logged</span>}
                </div>
                {g.tasks.map(row)}
              </div>
            )
          })}
        </section>

        <aside className="flex flex-col gap-4">
          <section className={`${card} p-4`}>
            <div className="flex items-baseline">
              <h2 className="m-0 text-[15px] font-bold text-ink">My hours this week</h2>
              <span className="ml-auto text-[12px] text-ink-2">
                {short(days[0])} – {fmt(days[4])}
              </span>
            </div>
            <div className="mt-3 flex h-[120px] items-end gap-2.5">
              {hours.map((h, i) => (
                <div key={days[i]} className="flex h-full flex-1 flex-col items-center justify-end gap-1.5">
                  <span className="tnum text-[12px] font-semibold text-ink-2">{h ? fh(h) : '–'}</span>
                  <div className="w-full rounded-t-md" style={{ height: `${Math.max(4, (h / barMax) * 84)}px`, background: days[i] === TODAY ? '#4870E8' : '#B7C8F3' }} />
                  <span className="text-[12px] font-semibold text-ink-2">{DOW[i]}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center text-[13px]">
              <span className="tnum font-semibold text-ink">{fh(weekTotal)}</span>
              <span className="ml-1.5 text-ink-2">of {fh(WEEK_TARGET_HOURS)}</span>
              <Link to="/timesheet" className="ml-auto font-semibold text-blue-ink no-underline">
                Log time ›
              </Link>
            </div>
          </section>

          <section className={`${card} p-4`}>
            <h2 className="m-0 text-[15px] font-bold text-ink">My sprints</h2>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {mySprints.map(s => {
                const ep = ws.epics.find(e => e.id === s.epic)
                const ts = tasks.filter(t => t.sprint === s.id && !t.parent)
                const dn = ts.filter(t => t.status === 'done').length
                return (
                  <Link
                    key={s.id}
                    to={`/tickets/plan?sprint=${s.id}`}
                    className="rounded-xl bg-canvas px-3 py-2.5 no-underline hover:bg-sky-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">
                        {s.name} · {ep?.name}
                      </span>
                      <span className="tnum flex-none text-[12px] text-ink-2">
                        {dn}/{ts.length} done
                      </span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-ink-2">{range(s.start, s.end)}</div>
                  </Link>
                )
              })}
              {!mySprints.length && <div className="text-[13px] text-muted">No sprints with your open tickets.</div>}
            </div>
          </section>

          <section className={`${card} p-4`}>
            <h2 className="m-0 text-[15px] font-bold text-ink">My epics</h2>
            <div className="mt-2.5 flex flex-col gap-1.5">
              {myEpics.map(e => {
                const ts = tasks.filter(t => t.epic === e.id && !t.parent)
                const dn = ts.filter(t => t.status === 'done').length
                const pct = ts.length ? Math.round((dn / ts.length) * 100) : 0
                const mineOpen = k.open.filter(t => t.epic === e.id).length
                return (
                  <Link key={e.id} to={`/tickets/plan?epic=${e.id}`} className="rounded-xl bg-canvas px-3 py-2.5 no-underline hover:bg-sky-2">
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{e.name}</span>
                      <span className="tnum flex-none text-[12px] text-ink-2">{mineOpen} open</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white">
                      <div className="h-full rounded-full bg-blue" style={{ width: pct + '%' }} />
                    </div>
                    <div className="mt-1 text-[12px] text-ink-2">
                      {dn}/{ts.length} tasks done · {pct}%
                    </div>
                  </Link>
                )
              })}
              {!myEpics.length && <div className="text-[13px] text-muted">No epics with your open tickets.</div>}
            </div>
          </section>

          <section className={`${card} p-4`}>
            <h2 className="m-0 text-[15px] font-bold text-ink">Recent on my tickets</h2>
            <div className="mt-2.5 flex flex-col gap-2.5">
              {feed.map(({ a, t }, i) => (
                <Link key={i} to={`/tickets/board?ticket=${taskKey(t)}`} className="flex items-start gap-2.5 text-[13px] text-ink no-underline">
                  {avatar(a.who)}
                  <span className="min-w-0">
                    <span className="font-semibold">{a.who}</span> {a.kind === 'comment' ? 'commented' : a.what} ·{' '}
                    <span className="text-blue-ink">{taskKey(t)}</span>
                    <span className="block text-[12px] text-ink-2">{a.when}</span>
                  </span>
                </Link>
              ))}
              {!feed.length && <div className="text-[13px] text-muted">No activity on your tickets yet.</div>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  )
}
