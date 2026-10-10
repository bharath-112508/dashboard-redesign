import { useState } from 'react'
import { useTasks, useWorkspace } from '../../api/queries'
import type { Task } from '../../api/types'
import { Avatar, CheckSquare, Icon, PATHS, Scrim, Select, unassigned } from '../../components/ui'
import { addDays, diff, MON, range, short, TODAY } from '../../lib/dates'
import { pal, SPRINT_STATE } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { useUi } from '../../state/ui'
import { sprintsOf, statusOf } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'

type Row =
  | { kind: 'group'; id: string; name: string; sub: string; count: number; closed: boolean; span: { left: number; w: number; c: string } | null }
  | { kind: 'task'; t: Task; left: number; w: number; over: boolean; range: string }

const navBtn =
  'h-9 cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white text-[13.5px] font-semibold text-ink'

/** Gantt of the epic's tasks, grouped by sprint. */
export function TimelineView() {
  const ws = useWorkspace().data!
  const ui = useUi()
  const openTask = useOpenTask()
  const all = (useTasks().data ?? []).filter(t => !t.parent && t.epic === ui.epic)
  const eSp = sprintsOf(ws.sprints, ui.epic)
  const [scale, setScale] = useState<'days' | 'weeks'>('days')
  const [sel, setSel] = useState<string[] | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [off, setOff] = useState(0)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [pickOpen, setPickOpen] = useState(false)

  const colW = scale === 'days' ? 52 : 18
  let start: string
  let n: number
  if (scale === 'days') {
    start = addDays(TODAY, -7 + off * 45)
    n = 45
  } else {
    start = eSp.length ? eSp[0].start : addDays(TODAY, -7)
    const end = eSp.length ? eSp[eSp.length - 1].end : addDays(TODAY, 60)
    n = Math.max(35, diff(end, start) + 8)
  }
  const dayList = Array.from({ length: n }, (_, i) => addDays(start, i))
  const days = dayList.map(iso => {
    const dow = new Date(iso + 'T12:00:00Z').getUTCDay()
    const isT = iso === TODAY
    const we = dow === 0 || dow === 6
    const show = scale === 'days' || dow === 1
    return {
      iso,
      letter: show ? 'SMTWTFS'[dow] : '',
      num: show ? String(new Date(iso + 'T12:00:00Z').getUTCDate()) : '',
      c: isT ? '#4870E8' : we ? '#A9B6C5' : '#22354C',
      w: isT ? 700 : 500,
      bg: isT ? 'rgba(72,112,232,0.08)' : we ? 'rgba(238,243,251,0.5)' : 'transparent',
      line: scale === 'days' ? '#EEF3FB' : dow === 0 ? '#E4EAF0' : 'transparent',
    }
  })
  const months: { label: string; left: number }[] = []
  dayList.forEach((iso, i) => {
    if (i === 0 || iso.slice(8) === '01') {
      const [y, m] = iso.split('-')
      months.push({ label: MON[+m - 1] + ' ' + y, left: i * colW })
    }
  })
  const px = (iso: string) => diff(iso, start) * colW
  const clamp = (v: number) => Math.max(0, Math.min(n * colW, v))

  const ids = [...eSp.map(x => x.id), 'backlog']
  const cur = sel || ids
  const inSel = (id: string) => !sel || sel.includes(id)
  const toggleSel = (id: string) => {
    const nx = cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]
    setSel(nx.length === ids.length ? null : nx)
  }
  const pickLabel = !sel
    ? 'All sprints'
    : cur.length === 0
      ? 'No sprints'
      : cur.length === 1
        ? cur[0] === 'backlog'
          ? 'Backlog'
          : eSp.find(x => x.id === cur[0])?.name
        : cur.length + ' sprints'

  const groups = [
    ...eSp.filter(x => inSel(x.id)).map(x => ({ id: x.id, name: x.name, sub: range(x.start, x.end), sp: x })),
    ...(inSel('backlog') ? [{ id: 'backlog', name: 'Backlog', sub: 'no sprint', sp: null }] : []),
  ]
  const rows: Row[] = []
  let tCount = 0
  let gCount = 0
  groups.forEach(g => {
    const ts = all.filter(t => (g.id === 'backlog' ? !t.sprint : t.sprint === g.id) && (showDone || t.status !== 'done'))
    if (!ts.length) return
    gCount++
    tCount += ts.length
    const closed = !!collapsed[g.id]
    const l = g.sp ? clamp(px(g.sp.start)) : 0
    const r = g.sp ? clamp(px(addDays(g.sp.end, 1))) : 0
    rows.push({
      kind: 'group',
      id: g.id,
      name: g.name,
      sub: g.sub,
      count: ts.length,
      closed,
      span: g.sp && r > l ? { left: l, w: r - l, c: SPRINT_STATE[g.sp.state][2] } : null,
    })
    if (closed) return
    ts.sort((a, b) => ((a.start || '') < (b.start || '') ? -1 : 1)).forEach(t => {
      const s0 = t.start || TODAY
      const e0 = t.due || addDays(s0, 2)
      const l2 = clamp(px(s0))
      const r2 = clamp(px(addDays(e0, 1)))
      rows.push({
        kind: 'task',
        t,
        left: l2 + 4,
        w: Math.max(colW - 8, r2 - l2 - 8),
        over: !!t.due && t.due < TODAY && t.status !== 'done',
        range: short(s0) + ' → ' + (t.due ? short(t.due) : 'no due date'),
      })
    })
  })

  const pager = (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={() => setOff(off - 1)} title="Previous 45 days" className={`${navBtn} grid w-9 place-items-center p-0`}>
        <Icon d={PATHS.back} size={14} sw={2.6} />
      </button>
      <button type="button" onClick={() => setOff(0)} className={`${navBtn} px-3`}>Today</button>
      <button type="button" onClick={() => setOff(off + 1)} title="Next 45 days" className={`${navBtn} grid w-9 place-items-center p-0`}>
        <Icon d={PATHS.next} size={14} sw={2.6} />
      </button>
      <span className="ml-1.5 whitespace-nowrap text-[13px] font-semibold text-ink-2">
        {short(start)} – {short(addDays(start, n - 1))}
      </span>
    </span>
  )
  const pageBtn = 'inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white px-2.5 text-[12.5px] font-bold text-ink hover:border-blue hover:text-blue-ink'

  return (
    <div className="flex flex-col gap-3.5">
      <div className="rounded-2xl border-[1.5px] border-line-2 bg-white">
        <div className="flex flex-wrap items-center gap-2 px-[18px] py-3.5">
          <Select value={scale} onChange={v => setScale(v as 'days' | 'weeks')} className="h-9 rounded-[10px] border-[1.5px] border-line pl-3 pr-8 text-[13.5px] font-semibold">
            <option value="days">Days</option>
            <option value="weeks">Weeks</option>
          </Select>
          <span className="relative inline-flex">
            <button type="button" onClick={() => setPickOpen(!pickOpen)} className={`${navBtn} inline-flex items-center gap-2 px-3`}>
              {pickLabel}
              <Icon d={PATHS.chevron} size={12} sw={2.6} />
            </button>
            {pickOpen && (
              <>
                <Scrim onClick={() => setPickOpen(false)} />
                <div className="absolute left-0 top-[42px] z-[41] w-[290px] rounded-[14px] border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]">
                  <div onClick={() => setSel(sel ? null : [])} className="flex cursor-pointer items-center gap-2.5 rounded-[9px] border-b-[1.5px] border-sky px-2.5 py-[9px] hover:bg-canvas">
                    <CheckSquare on={!sel} />
                    <span className="text-[13.5px] font-bold">All sprints</span>
                  </div>
                  {[...eSp.map(x => ({ id: x.id, label: x.name, sub: range(x.start, x.end) })), { id: 'backlog', label: 'Backlog', sub: 'no sprint' }].map(o => (
                    <div key={o.id} onClick={() => toggleSel(o.id)} className="flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 hover:bg-canvas">
                      <CheckSquare on={cur.includes(o.id)} />
                      <span className="text-[13.5px] font-semibold">{o.label}</span>
                      <span className="ml-auto whitespace-nowrap text-[12px] text-muted">{o.sub}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </span>
          {scale === 'days' && pager}
          <button type="button" onClick={() => setShowDone(!showDone)} className={`${navBtn} ml-auto inline-flex items-center gap-2.5 px-3`}>
            Show done
            <span className="relative h-5 w-[34px] rounded-full" style={{ background: showDone ? '#4870E8' : '#C9D2DD' }}>
              <span className="absolute top-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.2)]" style={{ left: showDone ? 16 : 2 }} />
            </span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t-[1.5px] border-line-2 px-[18px] py-2.5 text-[13px] text-ink-2">
          <span className="tnum text-[11px] uppercase tracking-[0.08em] text-ink-2">Status</span>
          {ws.statuses.map(s => {
            const [c, soft] = pal(s.p)
            return (
              <span key={s.id} className="inline-flex items-center gap-[7px]">
                <span className="h-3 w-4 rounded-[3px]" style={{ background: soft, boxShadow: `inset 0 0 0 1.5px ${c}` }} />
                {s.name}
              </span>
            )
          })}
          <span className="h-4 w-px bg-line-4" />
          <span className="inline-flex items-center gap-1.5">
            <Icon d={PATHS.warn} size={14} sw={2.2} stroke="#D2724A" />
            Overdue
          </span>
          <span className="inline-flex items-center gap-1.5">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#3F9079" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M8.5 12l2.5 2.5 4.5-5" />
            </svg>
            On time
          </span>
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border-[1.5px] border-line-2 bg-white">
        <div className="tnum flex items-center border-b-[1.5px] border-line-2 px-[18px] py-2.5 text-[12px] text-ink-2">
          <span>
            {gCount} group{gCount === 1 ? '' : 's'} · {tCount} tasks
          </span>
          <span className="ml-auto">{n} days shown</span>
          {scale === 'days' && (
            <span className="ml-3 inline-flex gap-1.5">
              <button type="button" onClick={() => setOff(off - 1)} title="Previous 45 days" className={pageBtn}>
                <Icon d={PATHS.back} size={13} sw={2.8} />
                Previous 45 days
              </button>
              <button type="button" onClick={() => setOff(off + 1)} title="Next 45 days" className={pageBtn}>
                Next 45 days
                <Icon d={PATHS.next} size={13} sw={2.8} />
              </button>
            </span>
          )}
        </div>
        <div className="flex">
          <div className="min-w-0 flex-[0_0_280px] border-r-[1.5px] border-line-2">
            <div className="tnum flex h-16 items-end border-b-[1.5px] border-line-2 px-4 pb-2.5 text-[11px] uppercase tracking-[0.08em] text-ink-2">Task</div>
            {rows.map(r =>
              r.kind === 'group' ? (
                <div
                  key={'g' + r.id}
                  onClick={() => setCollapsed(c => ({ ...c, [r.id]: !c[r.id] }))}
                  className="flex h-11 cursor-pointer items-center gap-2 border-b-[1.5px] border-line-2 bg-canvas px-4"
                >
                  <Icon d={PATHS.chevron} size={12} sw={2.6} className="text-ink-2" style={{ transform: `rotate(${r.closed ? -90 : 0}deg)` }} />
                  <span className="text-[13.5px] font-bold">{r.name}</span>
                  <span className="truncate text-[12px] text-ink-2">{r.sub}</span>
                  <span className="ml-auto inline-flex h-[18px] min-w-5 items-center justify-center rounded-[9px] bg-sky-2 px-1.5 text-[11px] font-semibold text-blue-ink">{r.count}</span>
                </div>
              ) : (
                <TaskLabel key={'t' + r.t.id} r={r} onOpen={() => openTask(r.t)} />
              ),
            )}
          </div>
          <div className="relative min-w-0 flex-1 overflow-x-auto">
            <div className="relative" style={{ width: n * colW }}>
              <div className="relative h-16 border-b-[1.5px] border-line-2">
                {months.map(m => (
                  <span key={m.label + m.left} className="absolute top-2 whitespace-nowrap pl-2.5 text-[13px] font-semibold text-ink" style={{ left: m.left }}>
                    {m.label}
                  </span>
                ))}
                <div className="absolute inset-x-0 bottom-0 flex">
                  {days.map(d => (
                    <div key={d.iso} className="flex-none pb-1.5 text-center" style={{ width: colW, color: d.c }}>
                      <div className="tnum text-[10px]">{d.letter}</div>
                      <div className="text-[13px]" style={{ fontWeight: d.w }}>{d.num}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="relative">
                <div className="pointer-events-none absolute inset-0 flex">
                  {days.map(d => (
                    <div key={d.iso} className="h-full flex-none" style={{ width: colW, background: d.bg, boxShadow: `inset -1px 0 0 ${d.line}` }} />
                  ))}
                </div>
                {rows.map(r =>
                  r.kind === 'group' ? (
                    <div key={'g' + r.id} className="relative h-11 border-b-[1.5px] border-line-2 bg-[rgba(246,249,252,0.7)]">
                      {r.span && <span className="absolute top-[19px] h-1.5 rounded-[3px]" style={{ left: r.span.left, width: r.span.w, background: r.span.c }} />}
                    </div>
                  ) : (
                    <TaskBar key={'t' + r.t.id} r={r} onOpen={() => openTask(r.t)} />
                  ),
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskLabel({ r, onOpen }: { r: Extract<Row, { kind: 'task' }>; onOpen: () => void }) {
  const person = usePerson()
  const ws = useWorkspace().data!
  const st = statusOf(ws.statuses, r.t.status)
  const a = r.t.assignee ? { ...person(r.t.assignee), color: '#fff', ring: 'none' } : { ...unassigned, name: 'Unassigned' }
  return (
    <div onClick={onOpen} className="flex h-12 cursor-pointer items-center gap-2.5 border-b-[1.5px] border-line-3 px-4 hover:bg-canvas">
      <span className="size-4 flex-none rounded-full border-[1.5px]" style={{ borderColor: st.c, background: r.t.status === 'done' ? st.c : 'transparent' }} />
      <span className="min-w-0 flex-1 truncate text-[14px]">{r.t.title}</span>
      {r.over && <Icon d={PATHS.warn} size={15} sw={2.2} stroke="#D2724A" />}
      <Avatar title={a.name} i={a.i} bg={a.bg} color={a.color} ring={a.ring} size={24} radius={6} font={9.5} />
    </div>
  )
}

function TaskBar({ r, onOpen }: { r: Extract<Row, { kind: 'task' }>; onOpen: () => void }) {
  const ws = useWorkspace().data!
  const st = statusOf(ws.statuses, r.t.status)
  return (
    <div className="relative h-12 border-b-[1.5px] border-line-3">
      <span
        onClick={onOpen}
        title={r.range}
        className="absolute top-2 flex h-8 cursor-pointer items-center truncate whitespace-nowrap rounded-lg px-2.5 text-[13px] font-semibold"
        style={{ left: r.left, width: r.w, background: st.soft, color: st.ink, boxShadow: `inset 0 0 0 1.5px ${st.c}` }}
      >
        {r.t.title}
      </span>
    </div>
  )
}
