import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { useEntries, useTasks, useWorkspace } from '../../api/queries'
import type { Task } from '../../api/types'
import type { Priority } from '../../api/types'
import { range } from '../../lib/dates'
import { pal, TYPE_ICON, TYPES } from '../../lib/theme'
import { isCritical, isOverdue, loggedHours, statusOf, taskKey } from '../../domain/tasks'
import { useMe } from '../../features/tickets/useMe'
import { daysTo, dueLabel, filterMine, groupMine, kpisOf, mineOf, needsYou, newCommentsFor, type MineFilter } from './model'

/** "2h 30m"; "0h" for nothing. */
const fh = (n: number) => {
  const m = Math.round(n * 60)
  const H = Math.floor(m / 60)
  const M = m % 60
  return (H ? H + 'h' : '') + (M ? (H ? ' ' : '') + M + 'm' : '') || '0h'
}

/** Priority icon and colour on a row: [colour, 16px path]. Critical gets a third chevron. */
const PRIO_MARK: Record<Priority, [string, string]> = {
  Critical: ['#C0392B', 'M4 10l4-4 4 4M4 14l4-4 4 4M4 6l4-4 4 4'],
  Urgent: ['#D2724A', 'M4 10l4-4 4 4M4 14l4-4 4 4'],
  High: ['#B98A2F', 'M4 11l4-4 4 4'],
  Medium: ['#4870E8', 'M4 6h8M4 10h8'],
  Low: ['#A9B6C5', 'M4 6l4 4 4-4'],
}

const COMMENT = 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'

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

  // Sprints and epics with open work of mine.
  const openSprintIds = [...new Set(k.open.map(t => t.sprint).filter((x): x is string => !!x))]
  const mySprints = ws.sprints.filter(s => openSprintIds.includes(s.id))
  const myEpics = ws.epics.filter(e => k.open.some(t => t.epic === e.id))

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
    const pr = PRIO_MARK[t.prio] || PRIO_MARK.Medium
    const sp = ws.sprints.find(s => s.id === t.sprint)
    const ep = ws.epics.find(e => e.id === t.epic)
    const done = t.status === 'done'
    const d = daysTo(t)
    const subsDone = t.subs.filter(x => x.done).length
    const msgs = newCommentsFor(t, me.name)
    return (
      <Link
        key={t.id}
        to={`/tickets/board?ticket=${taskKey(t)}`}
        data-row={taskKey(t)}
        className="flex cursor-pointer flex-wrap items-center gap-x-6 gap-y-2.5 border-t-[1.5px] border-line-3 px-4 py-3 text-ink no-underline hover:bg-canvas"
      >
        <div className="flex min-w-0 flex-[1_1_320px] items-center gap-3">
          <span title={t.type} className="grid size-[30px] flex-none place-items-center rounded-lg" style={{ background: ty[1], color: ty[2] }}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d={TYPE_ICON[t.type]} />
            </svg>
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="truncate text-[14px] font-[650] leading-[1.25]">{t.title}</div>
            <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-muted">
              <span className="tnum flex-none rounded-[5px] bg-sky-2 px-1.5 py-px text-[11px] font-bold text-blue-ink">{taskKey(t)}</span>
              <span className="size-1.5 flex-none rounded-sm" style={{ background: ep ? pal(ep.p)[0] : '#A9B6C5' }} />
              <span className="min-w-0 truncate">
                <b className="font-[650] text-ink">{ep?.name ?? t.epic}</b> · {sp ? sp.name : 'Backlog'}
              </span>
            </div>
          </div>
        </div>
        <div className="ml-auto flex flex-none items-center gap-5">
          <span title="Priority" className="flex w-[82px] items-center gap-1.5 whitespace-nowrap text-[12.5px] font-semibold" style={{ color: pr[0] }}>
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d={pr[1]} />
            </svg>
            {t.prio}
          </span>
          <span title="Subtasks done" className="flex w-[110px] flex-col gap-1">
            <span className="tnum whitespace-nowrap text-[12px] font-semibold" style={{ color: t.subs.length ? '#1B2D45' : '#A9B6C5' }}>
              {t.subs.length ? `${subsDone} of ${t.subs.length} subtasks` : 'No subtasks'}
            </span>
            <span className="h-1 overflow-hidden rounded-sm bg-[#EEF2F6]">
              <span className="block h-full bg-green" style={{ width: (t.subs.length ? (subsDone / t.subs.length) * 100 : 0) + '%' }} />
            </span>
          </span>
          <span title={msgs ? msgs + ' new comments' : undefined} className="flex w-[34px] items-center">
            {msgs > 0 && (
              <span className="inline-flex h-5 items-center gap-1 rounded-[10px] bg-blue px-[7px] text-[11px] font-bold text-white">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d={COMMENT} />
                </svg>
                {msgs}
              </span>
            )}
          </span>
          <span
            className="tnum w-[72px] whitespace-nowrap text-right text-[12.5px]"
            style={{
              color: !done && d !== null && d < 0 ? '#C0392B' : !done && d === 0 ? '#7A5C0E' : t.due ? '#1B2D45' : '#3B4A5E',
              fontWeight: !done && d !== null && d <= 0 ? 800 : 600,
            }}
          >
            {dueLabel(t)}
          </span>
          <span className="flex w-[100px] justify-end">
            <span className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-full px-[9px] text-[11.5px] font-bold" style={{ background: st.soft, color: st.ink }}>
              <span className="size-1.5 rounded-full" style={{ background: st.c }} />
              {st.name}
            </span>
          </span>
        </div>
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

      <section className={`${card} min-w-0 overflow-hidden`}>
        <div className="flex flex-wrap items-center gap-2.5 px-4 pt-3.5">
          <h2 className="m-0 mr-1 text-[15px] font-bold text-ink">All my tickets</h2>
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

      <div className="grid items-start gap-[18px]" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,380px),1fr))' }}>
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
      </div>
    </div>
  )
}
