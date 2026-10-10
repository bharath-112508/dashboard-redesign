import type { ReactNode } from 'react'
import { useEntries, useTasks, useWorkspace } from '../../api/queries'
import type { Task } from '../../api/types'
import { Avatar } from '../../components/ui'
import { diff, short, TODAY } from '../../lib/dates'
import { PEOPLE } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { useOverlay, useUi } from '../../state/ui'
import { assigneesOf, cardAvatars, estimateHours, loggedHours, statusOf, taskKey } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'
import { useGoView } from './TicketsLayout'

/** "3h 30m" */
const fh = (n: number) => {
  const m = Math.round(n * 60)
  const H = Math.floor(m / 60)
  const M = m % 60
  return (H ? H + 'h' : '') + (M ? (H ? ' ' : '') + M + 'm' : '') || '0h'
}
const r1 = (n: number) => Math.round(n * 10) / 10

type Why = { t: string; bg: string; c: string; r: number }

/** The "Overview" tab: what needs attention across the project, and where the time went. */
export function OverviewView() {
  const ws = useWorkspace().data!
  const all = (useTasks().data ?? []).filter(t => !t.parent)
  const entries = useEntries().data ?? []
  const ui = useUi()
  const person = usePerson()
  const overlay = useOverlay()
  const goView = useGoView()
  const openTask = useOpenTask()

  // Hours per task, as in the prototype (rounded to 0.1h).
  const wH = all.map(t => {
    const hl = r1(loggedHours(t, entries))
    const he = estimateHours(t)
    return { t, hl, he, hOver: r1(hl - he) }
  })
  const open = all.filter(t => t.status !== 'done')
  const od = open.filter(t => t.due && t.due < TODAY)
  const overL = wH.filter(x => x.he && x.hl > x.he).sort((a, b) => b.hOver - a.hOver)
  const attL = wH
    .filter(x => x.t.status !== 'done')
    .map(x => {
      const why: Why[] = []
      if (x.t.prio === 'Critical') why.push({ t: '● Critical', bg: '#C0392B', c: '#fff', r: 0 })
      if (x.t.due && x.t.due < TODAY) why.push({ t: diff(TODAY, x.t.due) + ' days overdue', bg: '#FBE3DF', c: '#C0392B', r: 1 })
      if (x.he && x.hl > x.he) why.push({ t: x.hOver + 'h over estimate', bg: '#FBEDC2', c: '#7A5C0E', r: 2 })
      if (!assigneesOf(x.t).length) why.push({ t: 'Unassigned', bg: '#E7EEFB', c: '#22354C', r: 3 })
      return { ...x, why }
    })
    .filter(x => (x.why.length && x.why[0].r < 3) || x.why.length > 1)
    .sort((a, b) => a.why[0].r - b.why[0].r || b.why.length - a.why.length)

  const epName = (id: string) => ws.epics.find(e => e.id === id)?.name || ''
  const missL: { key: string; tag: string; tagBg: string; tagC: string; name: string; late: string; sub: string; go: () => void }[] = []
  ws.sprints
    .filter(x => x.end < TODAY && x.state !== 'done')
    .forEach(x => {
      const n = all.filter(t => t.sprint === x.id && t.status !== 'done').length
      missL.push({
        key: 'e' + x.id,
        tag: 'Sprint',
        tagBg: '#DCE5FA',
        tagC: '#1F3FAF',
        name: epName(x.epic) + ' · ' + x.name,
        late: diff(TODAY, x.end) + ' days past end',
        sub: 'Ended ' + short(x.end) + ' · ' + n + ' tasks still open',
        go: () => overlay.open('sprint', x.id),
      })
    })
  ws.sprints
    .filter(x => x.state !== 'planned')
    .forEach(x => {
      const late = all.filter(t => t.sprint === x.id && t.status !== 'done' && t.due && t.due > x.end)
      if (late.length)
        missL.push({
          key: 'l' + x.id,
          tag: 'Sprint',
          tagBg: '#DCE5FA',
          tagC: '#1F3FAF',
          name: epName(x.epic) + ' · ' + x.name,
          late: late.length + ' past sprint',
          sub: late.length + ' task' + (late.length === 1 ? '' : 's') + ' due after the sprint ends (' + short(x.end) + ')',
          go: () => overlay.open('sprint', x.id),
        })
    })
  ws.epics.forEach(E => {
    const et = all.filter(t => t.epic === E.id)
    const ed = et.filter(t => t.status === 'done').length
    if (E.target && E.target < TODAY && ed < et.length)
      missL.push({
        key: 'x' + E.id,
        tag: 'Epic',
        tagBg: '#E6DFFA',
        tagC: '#3F2E94',
        name: E.name,
        late: diff(TODAY, E.target) + ' days late',
        sub: 'Target ' + short(E.target) + ' · ' + (et.length - ed) + ' tasks open',
        go: () => overlay.open('epic', E.id),
      })
  })

  const tot = wH.reduce((a, x) => a + x.hl, 0)
  const pp = PEOPLE.map(n => {
    let v = 0
    entries.forEach(x => {
      if (x.user === n && all.some(t => t.id === x.task)) v += (x.bill || 0) + (x.non || 0)
    })
    return { ...person(n), v }
  }).sort((a, b) => b.v - a.v)
  const pmx = Math.max(1, ...pp.map(x => x.v))
  const topL = wH
    .filter(x => x.hl > 0)
    .sort((a, b) => b.hl - a.hl)
    .slice(0, 4)
  const tmx = Math.max(1, ...topL.map(x => x.hl))
  const critN = all.filter(t => t.prio === 'Critical' && t.status !== 'done').length

  const acts: { who: string; what: string; key: string; ord: number; k: string }[] = []
  all
    .filter(t => t.epic === ui.epic)
    .forEach(t =>
      t.acts.forEach((a, i) =>
        acts.push({
          who: a.who,
          what: a.kind === 'comment' ? 'commented' : a.what || '',
          key: taskKey(t),
          ord: a.when === 'just now' ? 1e6 - i : -i,
          k: t.id + '-' + i,
        }),
      ),
    )
  acts.sort((a, b) => b.ord - a.ord)

  const board = () => goView('board')
  const kpis = [
    { l: 'Hours logged', v: fh(tot), sub: all.length + ' tasks, all epics', c: '#4870E8', vc: '#1B2D45', go: () => goView('timesheet') },
    { l: 'Needs attention', v: String(attL.length), sub: 'critical, late or over estimate', c: '#D2724A', vc: attL.length ? '#C0392B' : '#1B2D45', go: board },
    { l: 'Overdue', v: String(od.length), sub: 'past due date', c: '#C0392B', vc: od.length ? '#C0392B' : '#1B2D45', go: board },
    { l: 'Critical open', v: String(critN), sub: 'blinking on the board', c: '#C0392B', vc: critN ? '#C0392B' : '#1B2D45', go: board },
    { l: 'Over estimate', v: String(overL.length), sub: 'more hours than planned', c: '#B98A2F', vc: overL.length ? '#7A5C0E' : '#1B2D45', go: board },
  ]

  const statusFor = (t: Task) => statusOf(ws.statuses, t.status)
  const Head = ({ title, n, right }: { title: string; n?: ReactNode; right?: string }) => (
    <div className="flex items-center gap-2 px-1.5 py-1">
      <span className="text-[13.5px] font-semibold text-ink">{title}</span>
      <span className="tnum text-[13px] text-ink-2">{n}</span>
      {right && <span className="ml-auto text-[12px] text-muted">{right}</span>}
    </div>
  )
  const Empty = ({ children }: { children: ReactNode }) => (
    <div className="rounded-xl border-[1.5px] border-dashed border-line p-3.5 text-center text-[13px] text-muted">{children}</div>
  )
  const card = 'cursor-pointer rounded-[14px] bg-white px-3.5 py-3 shadow-[0_0_0_1.5px_#D6DEE8,0_1px_2px_rgba(27,45,69,0.04)]'
  const taskHead = (t: Task) => (
    <div className="flex min-w-0 items-center gap-2.5">
      <span className="flex flex-none">
        {cardAvatars(assigneesOf(t), person).map(a => (
          <Avatar key={a.name} title={a.name} i={a.i} bg={a.bg} color={a.color} size={24} radius={6} font={10} className="!font-bold" ring={`0 0 0 2px #fff,${a.ring}`} style={{ marginRight: -6 }} />
        ))}
      </span>
      <span className="ml-[7px] min-w-0 flex-1 truncate text-[14px] font-semibold text-ink">{t.title}</span>
      <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-[7px] py-[3px] text-[11.5px] font-semibold text-blue-ink">{taskKey(t)}</span>
    </div>
  )
  const taskCard = (t: Task, body: ReactNode, key: string) => (
    <div
      key={key}
      onClick={() => openTask(t)}
      data-crit={t.prio === 'Critical' ? '1' : undefined}
      className={`${card} flex flex-col gap-2.5 transition-shadow hover:shadow-[0_0_0_1.5px_#4870E8,0_6px_16px_-8px_rgba(27,45,69,0.2)] ${
        t.prio === 'Critical' && t.status !== 'done' ? 'animate-crit-blink' : ''
      }`}
    >
      {taskHead(t)}
      {body}
    </div>
  )
  const col = 'flex flex-col gap-2 rounded-[14px] bg-sky p-2.5'

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid grid-cols-5 gap-2.5">
        {kpis.map(k => (
          <div key={k.l} onClick={k.go} className={`${card} !p-3.5 hover:shadow-[0_0_0_1.5px_#4870E8]`}>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-[2px]" style={{ background: k.c }} />
              <span className="truncate text-[13px] font-semibold text-ink-2">{k.l}</span>
            </div>
            <div className="tnum mt-2 text-[26px] font-bold leading-none tracking-[-0.02em]" style={{ color: k.vc }}>
              {k.v}
            </div>
            <div className="mt-1.5 text-[12px] leading-[1.35] text-muted [text-wrap:pretty]">{k.sub}</div>
          </div>
        ))}
      </div>
      <div className="grid items-start gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(320px,100%),1fr))' }}>
        <div className={col}>
          <Head title="Needs attention" n={attL.length} />
          {attL.slice(0, 5).map(x => {
            const st = statusFor(x.t)
            return taskCard(
              x.t,
              <div className="flex flex-wrap items-center gap-1.5">
                {x.why.map(w => (
                  <span key={w.t} className="inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-[5px] px-2 text-[11.5px] font-bold" style={{ background: w.bg, color: w.c }}>
                    {w.t}
                  </span>
                ))}
                <span className="ml-auto inline-flex items-center gap-[5px] text-[12px] font-semibold" style={{ color: st.ink }}>
                  <span className="size-1.5 rounded-full" style={{ background: st.c }} />
                  {st.name}
                </span>
              </div>,
              'a' + x.t.id,
            )
          })}
          {!attL.length && <Empty>Nothing needs attention</Empty>}
        </div>
        <div className={col}>
          <Head title="Over estimate" n={overL.length} />
          {overL.slice(0, 5).map(x =>
            taskCard(
              x.t,
              <div className="flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-red-soft">
                  <div className="h-full w-full bg-red" />
                </div>
                <span className="tnum whitespace-nowrap text-[12.5px] font-semibold text-ink">
                  {x.hl}h / {x.he}h
                </span>
                <span className="tnum whitespace-nowrap text-[12.5px] font-extrabold text-red">{x.hOver}h over</span>
              </div>,
              'o' + x.t.id,
            ),
          )}
          {!overL.length && <Empty>Every task is within its estimate</Empty>}
        </div>
        <div className={col}>
          <Head title="Missed timelines" n={missL.length} />
          {missL.slice(0, 5).map(m => (
            <div key={m.key} onClick={m.go} className={`${card} hover:shadow-[0_0_0_1.5px_#4870E8]`}>
              <div className="flex items-center gap-2">
                <span className="inline-flex h-[22px] items-center rounded-[5px] px-2 text-[11.5px] font-bold" style={{ background: m.tagBg, color: m.tagC }}>
                  {m.tag}
                </span>
                <span className="ml-auto whitespace-nowrap text-[12.5px] font-extrabold text-red">{m.late}</span>
              </div>
              <div className="mt-2 text-[14.5px] font-bold text-ink">{m.name}</div>
              <div className="mt-[3px] text-[12.5px] leading-[1.4] text-ink-2">{m.sub}</div>
            </div>
          ))}
          {!missL.length && <Empty>No missed sprint or task deadlines</Empty>}
        </div>
        <div className={col}>
          <Head title="Time spent" n={fh(tot)} right="by person" />
          <div className="flex flex-col gap-2.5 rounded-[14px] bg-white p-3.5 shadow-[0_0_0_1.5px_#D6DEE8,0_1px_2px_rgba(27,45,69,0.04)]">
            {pp.map(m => (
              <div key={m.name} className="flex items-center gap-2.5">
                <Avatar i={m.i} bg={m.bg} size={24} radius={6} font={10} className="!font-bold" />
                <span className="w-[84px] truncate text-[13px] text-ink">{m.name}</span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-sky">
                  <div className="h-full bg-blue" style={{ width: Math.round((m.v / pmx) * 100) + '%' }} />
                </div>
                <span className="tnum w-[62px] whitespace-nowrap text-right text-[13px] font-bold">{fh(m.v)}</span>
              </div>
            ))}
          </div>
        </div>
        <div className={col}>
          <Head title="Most hours logged" />
          {topL.map(x =>
            taskCard(
              x.t,
              <div className="flex items-center gap-2.5">
                <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-sky">
                  <div className="h-full" style={{ width: Math.round((x.hl / tmx) * 100) + '%', background: x.he && x.hl > x.he ? '#C0392B' : '#4870E8' }} />
                </div>
                <span className="tnum whitespace-nowrap text-[12.5px] font-bold text-ink">{fh(x.hl) + (x.he ? ' / ' + x.he + 'h' : '')}</span>
              </div>,
              't' + x.t.id,
            ),
          )}
          {!topL.length && <Empty>No hours logged yet</Empty>}
        </div>
        <div className={col}>
          <Head title="Recent activity" />
          <div className="rounded-[14px] bg-white px-3.5 py-1 shadow-[0_0_0_1.5px_#D6DEE8,0_1px_2px_rgba(27,45,69,0.04)]">
            {acts.slice(0, 8).map((a, i) => {
              const m = person(a.who)
              return (
                <div key={a.k} className="flex items-center gap-2.5 py-[9px]" style={{ borderTop: '1.5px solid #EEF3FB', borderTopWidth: i ? 1.5 : 1.5 }}>
                  <Avatar i={m.i} bg={m.bg} size={24} radius={6} font={10} className="!font-bold" />
                  <div className="min-w-0 flex-1 truncate text-[13px] text-ink-2">
                    <b className="font-semibold text-ink">{a.who}</b> {a.what}
                  </div>
                  <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-[7px] py-[3px] text-[11.5px] font-semibold text-blue-ink">{a.key}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
