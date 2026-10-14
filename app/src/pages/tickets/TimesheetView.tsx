import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useEntries, useRequests, useSend, useTasks, useWorkspace } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { logTime } from '../../api/timesheet'
import { Avatar, Icon, PATHS } from '../../components/ui'
import { diff, fmt, TODAY } from '../../lib/dates'
import { useMe, useTeamPeople } from '../../features/tickets/useMe'
import { usePerson } from '../../state/page'
import { useUi } from '../../state/ui'
import { compareTaskIds, taskKey } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'
import { useOpenRequest } from '../../features/tickets/DevopsPanel'

/** [ink, soft, dot] per entry type */
const ETYPE: Record<string, [string, string, string]> = {
  DevOps: ['#3F2E94', '#E6DFFA', '#9F89E5'],
  General: ['#3F2E94', '#E6DFFA', '#9F89E5'],
  Meeting: ['#7A5C0E', '#FBEDC2', '#B98A2F'],
  Review: ['#1F6F6E', '#DFF1F0', '#3E908F'],
}
const COLS = '120px 190px 110px minmax(180px,1.2fr) minmax(200px,1.4fr) 100px 120px 90px'

/** "2h 30m"; "–" for nothing. */
const hm = (n: number) => {
  if (!n) return '–'
  const m = Math.round(n * 60)
  const H = Math.floor(m / 60)
  const M = m % 60
  return (H ? H + 'h' : '') + (H && M ? ' ' : '') + (M ? M + 'm' : '') || '0m'
}
const hmZ = (n: number) => (n ? hm(n) : '0m')

const hours = z.union([z.literal(''), z.coerce.number().min(0, 'Hours can’t be negative')])
const schema = z
  .object({
    date: z.string().min(1),
    user: z.string().min(1),
    type: z.string().min(1),
    task: z.string().min(1, 'Pick a task'),
    notes: z.string(),
    bill: hours,
    non: hours,
  })
  .refine(f => (+f.bill || 0) + (+f.non || 0) > 0, { message: 'Add some hours', path: ['bill'] })
type Form = z.input<typeof schema>

type Row = {
  id: string
  date: string
  user: string
  type: string
  title: string
  notes: string
  bill: number
  non: number
  open: () => void
  remove: () => void
}

/** The "Timesheet" tab: time logged on the epic's tickets and DevOps requests. */
export function TimesheetView() {
  const ws = useWorkspace().data!
  const tasks = useTasks().data ?? []
  const entries = useEntries().data ?? []
  const people = usePeople().data ?? []
  const team = useTeamPeople()
  const me = useMe()
  const requests = useRequests().data ?? []
  const ui = useUi()
  const send = useSend()
  const person = usePerson()
  const openTask = useOpenTask()
  const openRequest = useOpenRequest()
  const [userF, setUserF] = useState('')
  const [rangeF, setRangeF] = useState<'all' | 'week' | 'month'>('all')
  const [formOpen, setFormOpen] = useState(false)
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({})

  const epTasks = tasks.filter(t => t.epic === ui.epic)
  const ids = new Set(epTasks.filter(t => !ui.spSel || ui.spSel.includes(t.sprint || 'backlog')).map(t => t.id))
  const reqs = requests.filter(r => r.key === ws.devopsLinks[ui.epic])
  const rangeOk = (d: string) =>
    rangeF === 'all' || (rangeF === 'week' ? diff(TODAY, d) < 7 && diff(TODAY, d) >= 0 : d.slice(0, 7) === TODAY.slice(0, 7))
  /** The person picked in the filter, by directory id ('' for everyone). */
  const pickedName = userF ? (people.find(p => p.id === userF)?.name ?? '') : ''
  const nameOf = (id: string, fallback: string) => people.find(p => p.id === id)?.name ?? fallback
  const userOkId = (id: string) => !userF || id === userF
  const userOkName = (n: string) => !userF || n === pickedName

  const rows: Row[] = [
    ...entries
      .filter(x => x.task !== null && ids.has(x.task) && userOkId(x.userId) && rangeOk(x.date))
      .map(x => {
        const t = tasks.find(y => y.id === x.task)
        return {
          id: 'e' + x.id,
          date: x.date,
          user: nameOf(x.userId, x.user),
          type: x.type,
          title: t ? t.title : '—',
          notes: x.notes,
          bill: x.bill,
          non: x.non,
          sortId: String(x.id),
          open: () => t && openTask(t),
          remove: () => send({ type: 'time.remove', id: x.id }),
        }
      })
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : compareTaskIds(b.sortId, a.sortId))),
    ...reqs.flatMap(r =>
      (r.logs || []).flatMap((x, i) =>
        x.date && userOkName(x.by) && rangeOk(x.date)
          ? [
              {
                id: 'r' + r.id + '_' + i,
                date: x.date,
                user: x.by,
                type: 'DevOps',
                title: r.rkey + ' · ' + r.text,
                notes: x.notes || '',
                bill: x.h,
                non: 0,
                open: () => openRequest(r),
                remove: () =>
                  send({ type: 'request.update', id: r.id, patch: { logs: (r.logs || []).filter((_, j) => j !== i) } }),
              },
            ]
          : [],
      ),
    ),
  ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))

  const B = rows.reduce((a, x) => a + (x.bill || 0), 0)
  const N = rows.reduce((a, x) => a + (x.non || 0), 0)
  const users = new Set(rows.map(x => x.user))
  const kpis = [
    { label: 'Total', value: hmZ(B + N), bg: '#EEF3FB', bd: '#DCE5FA', lc: '#1F3FAF', vc: '#4870E8', ib: '#DCE5FA', icon: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { label: 'Billable', value: hmZ(B), bg: '#EEF7F3', bd: '#D6E9E2', lc: '#195040', vc: '#3F9079', ib: '#D6E9E2', icon: 'M12 3v18M16 7.5c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 2.6 4 3 4 1.3 4 3-1.8 3-4 3-4-1.3-4-3' },
    { label: 'Non-billable', value: hmZ(N), bg: '#FDF8EC', bd: '#FBEDC2', lc: '#7A5C0E', vc: '#B98A2F', ib: '#FBEDC2', icon: 'M10 2h4M12 13V9M20 14a8 8 0 11-16 0 8 8 0 0116 0z' },
    {
      label: 'Contributors',
      value: String(users.size),
      bg: '#FBF3EF',
      bd: '#F6DDD0',
      lc: '#7A3818',
      vc: '#D2724A',
      ib: '#F6DDD0',
      icon: 'M16 20v-1.5a3.5 3.5 0 00-3.5-3.5h-5A3.5 3.5 0 004 18.5V20M10 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM20 20v-1.5a3.5 3.5 0 00-2.5-3.35M15.5 4.15a3.5 3.5 0 010 6.7',
    },
  ]

  // ---------- log time form
  const taskOpts = [
    ...epTasks.filter(t => !t.parent).map(t => ({ v: String(t.id), label: taskKey(t) + ' · ' + t.title })),
    ...epTasks.filter(t => t.parent).map(t => ({ v: String(t.id), label: taskKey(t) + ' · ' + t.title })),
    ...reqs.map(r => ({ v: 'r' + r.id, label: r.rkey + ' · ' + r.text + ' (DevOps)' })),
  ]
  const blank: Form = { date: TODAY, user: String(me.id), type: 'General', task: taskOpts[0]?.v || '', notes: '', bill: '', non: '' }
  const { register, handleSubmit, reset, watch, getValues } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: blank })
  const w = watch()
  const ok = !!w.task && (+(w.bill || 0) || 0) + (+(w.non || 0) || 0) > 0
  const onSave = (f: Form) => {
    const bill = +(f.bill || 0) || 0
    const non = +(f.non || 0) || 0
    const pid = f.user
    const pname = nameOf(pid, '')
    if (f.task.startsWith('r')) {
      const r = requests.find(x => x.id === +f.task.slice(1))
      if (r) {
        const entry = { h: bill + non, by: pname, when: 'just now', date: f.date || TODAY, notes: f.notes.trim() }
        send({ type: 'request.update', id: r.id, patch: { logs: [...(r.logs || []), entry] }, addLog: entry })
      }
    } else {
      send(
        logTime({
          date: f.date || TODAY,
          userId: pid,
          user: pname,
          type: f.type,
          task: f.task,
          notes: f.notes.trim(),
          bill,
          non,
        }),
      )
    }
    reset({ ...getValues(), notes: '', bill: '', non: '' })
  }

  const field = 'flex flex-col gap-[5px] text-[12px] text-ink-2'
  const control = 'h-9 rounded-[10px] border-[1.5px] border-line bg-white px-2.5 text-[13.5px] text-ink outline-0'
  const select = 'h-9 w-full cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-line bg-white pl-3 pr-[30px] text-[13.5px] font-semibold text-ink outline-0'
  const chevron = <Icon d={PATHS.chevron} size={12} sw={2.6} className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-2" />

  return (
    <div className="flex flex-col gap-3.5">
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(220px,100%),1fr))' }}>
        {kpis.map(k => (
          <div key={k.label} className="flex items-start gap-3 rounded-2xl border px-[18px] py-4" style={{ background: k.bg, borderColor: k.bd }}>
            <div className="min-w-0 flex-1">
              <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: k.lc }}>
                {k.label}
              </div>
              <div className="tnum mt-1.5 text-[30px] font-semibold leading-[1.05] tracking-[-0.01em]" style={{ color: k.vc }}>
                {k.value}
              </div>
            </div>
            <span className="grid size-10 flex-none place-items-center rounded-[11px]" style={{ background: k.ib, color: k.vc }}>
              <Icon d={k.icon} size={19} sw={2} />
            </span>
          </div>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border-[1.5px] border-line-2 bg-white">
        <div className="flex flex-wrap items-center gap-2.5 px-[18px] py-3.5">
          <span className="text-[16px] font-bold">Entries</span>
          <div className="ml-3 flex gap-2">
            <span className="relative inline-flex">
              <select value={userF} onChange={e => setUserF(e.target.value)} aria-label="Person" className={select}>
                <option value="">Everyone</option>
                {team.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {chevron}
            </span>
            <span className="relative inline-flex">
              <select value={rangeF} onChange={e => setRangeF(e.target.value as typeof rangeF)} aria-label="Range" className={select}>
                <option value="all">All time</option>
                <option value="week">Last 7 days</option>
                <option value="month">This month</option>
              </select>
              {chevron}
            </span>
          </div>
          <span className="tnum ml-auto text-[12px] text-ink-2">{rows.length} entries</span>
          <button
            type="button"
            onClick={() => {
              if (!formOpen) reset({ ...blank, task: getValues('task') || blank.task })
              setFormOpen(!formOpen)
            }}
            className="h-9 cursor-pointer rounded-[10px] border-0 bg-blue px-3.5 text-[13.5px] font-semibold text-white hover:bg-blue-600"
          >
            {formOpen ? 'Close' : '+ Log time'}
          </button>
        </div>
        {formOpen && (
          <form
            onSubmit={handleSubmit(onSave)}
            className="grid items-end gap-2 border-t-[1.5px] border-line-2 bg-canvas px-[18px] py-3.5"
            style={{ gridTemplateColumns: '150px 190px 130px minmax(180px,1fr) 90px 90px' }}
          >
            <label className={field}>
              Date
              <input type="date" {...register('date')} className={`${control} tnum !text-[12.5px]`} />
            </label>
            <label className={field}>
              Person
              <span className="relative inline-flex w-full">
                <select {...register('user')} className={select}>
                  {team.map(p => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                {chevron}
              </span>
            </label>
            <label className={field}>
              Type
              <span className="relative inline-flex w-full">
                <select {...register('type')} className={select}>
                  {Object.keys(ETYPE).map(k => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
                {chevron}
              </span>
            </label>
            <label className={field}>
              Task
              <span className="relative inline-flex w-full">
                <select {...register('task')} className={select}>
                  {taskOpts.map(o => (
                    <option key={o.v} value={o.v}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {chevron}
              </span>
            </label>
            <label className={field}>
              Billable h
              <input placeholder="0" type="number" min="0" step="0.5" {...register('bill')} className={`${control} tnum`} />
            </label>
            <label className={field}>
              Non-bill. h
              <input placeholder="0" type="number" min="0" step="0.5" {...register('non')} className={`${control} tnum`} />
            </label>
            <label className={field} style={{ gridColumn: '1 / -2' }}>
              Notes
              <input {...register('notes')} placeholder="What did you work on?" className={control} />
            </label>
            <button
              type="submit"
              className="h-9 cursor-pointer rounded-[10px] border-0 bg-ink text-[13.5px] font-semibold text-white"
              style={{ opacity: ok ? 1 : 0.45 }}
            >
              Log time
            </button>
          </form>
        )}
        <div className="overflow-x-auto">
          <div className="min-w-[1160px]">
            <div
              className="grid h-[42px] items-center gap-3.5 bg-sky-2 px-[18px] text-[11.5px] font-semibold uppercase tracking-[0.06em] text-blue-ink"
              style={{ gridTemplateColumns: COLS }}
            >
              <span>Date</span>
              <span>User</span>
              <span>Type</span>
              <span>Task</span>
              <span>Notes</span>
              <span className="text-right">Billable</span>
              <span className="text-right">Non-billable</span>
              <span className="text-right">Total</span>
            </div>
            {rows.map(r => {
              const m = person(r.user)
              const ty = ETYPE[r.type] || ETYPE.General
              const isOpen = !!openRows[r.id]
              return (
                <div key={r.id} className="border-t-[1.5px] border-line-3 hover:bg-canvas">
                  <div className="grid min-h-[52px] items-center gap-3.5 px-[18px] py-1.5" style={{ gridTemplateColumns: COLS }}>
                    <span className="tnum whitespace-nowrap text-[13px] text-ink-2">{fmt(r.date)}</span>
                    <span className="flex min-w-0 items-center gap-[9px]">
                      <Avatar i={m.i} bg={m.bg} size={28} radius={6} font={10.5} ring={`0 0 0 2px #fff,0 0 0 3px ${m.bg}55`} />
                      <span className="truncate text-[14px] font-semibold">{r.user}</span>
                    </span>
                    <span>
                      <span className="inline-flex items-center gap-1.5 rounded-full py-[3px] pl-2 pr-2.5 text-[12.5px] font-semibold" style={{ background: ty[1], color: ty[0] }}>
                        <span className="size-1.5 rounded-full" style={{ background: ty[2] }} />
                        {r.type}
                      </span>
                    </span>
                    <span onClick={r.open} className="cursor-pointer truncate text-[14px] hover:text-blue-ink">
                      {r.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => setOpenRows(o => ({ ...o, [r.id]: !isOpen }))}
                      className="flex min-w-0 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left text-ink-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-[13.5px]">{r.notes.split('\n')[0] || 'No notes'}</span>
                      <Icon d={PATHS.chevron} size={13} sw={2.4} style={{ transform: `rotate(${isOpen ? 180 : 0}deg)` }} />
                    </button>
                    <span className="tnum text-right text-[13px] text-green">{hm(r.bill)}</span>
                    <span className="tnum text-right text-[13px] text-amber">{hm(r.non)}</span>
                    <span className="tnum text-right text-[13.5px] font-semibold text-ink">{hm((r.bill || 0) + (r.non || 0))}</span>
                  </div>
                  {isOpen && (
                    <div className="flex items-start gap-3 pb-3.5 pr-[18px]" style={{ paddingLeft: 'calc(18px + 120px + 14px + 190px + 14px + 110px + 14px)' }}>
                      <div className="flex-1 whitespace-pre-wrap rounded-[10px] border-[1.5px] border-line-2 bg-canvas px-3 py-2.5 text-[13.5px] leading-[1.55] text-ink-2">
                        {r.notes || 'No notes'}
                      </div>
                      <button
                        type="button"
                        onClick={r.remove}
                        className="h-[30px] cursor-pointer rounded-lg border border-rust-line bg-rust-soft px-2.5 text-[12.5px] font-semibold text-rust"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
            {!rows.length && <div className="border-t-[1.5px] border-line-3 p-10 text-center text-[14px] text-ink-2">No time logged in this range.</div>}
          </div>
        </div>
      </div>
    </div>
  )
}
