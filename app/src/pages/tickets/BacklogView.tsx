import { useState } from 'react'
import { useSend, useTasks, useWorkspace } from '../../api/queries'
import type { Sprint, Task } from '../../api/types'
import { Avatar, Icon, PATHS, unassigned } from '../../components/ui'
import { range, TODAY, weeks } from '../../lib/dates'
import { PRIO, SPRINT_STATE, TYPES } from '../../lib/theme'
import { useMe } from '../../features/tickets/useMe'
import { usePerson } from '../../state/page'
import { useUi } from '../../state/ui'
import { nextTaskId, sprintsOf, statusOf, taskKey } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'

/** The "Backlog" tab: the epic's open sprints and its backlog, with a "move to sprint" menu on every task. */
export function BacklogView() {
  const me = useMe()
  const ws = useWorkspace().data!
  const tasks = useTasks().data ?? []
  const ui = useUi()
  const send = useSend()
  const person = usePerson()
  const openTask = useOpenTask()
  const [draft, setDraft] = useState('')

  const epT = tasks.filter(t => !t.parent && t.epic === ui.epic)
  const eSp = sprintsOf(ws.sprints, ui.epic).filter(x => x.state !== 'done')
  const back = epT.filter(t => !t.sprint)

  const move = (t: Task, v: string) => {
    const to = v || null
    const sp = ws.sprints.find(y => y.id === to)
    send({ type: 'task.update', who: me.name, id: t.id, patch: { sprint: to }, log: sp ? 'moved it to ' + sp.name : 'moved it to the backlog' })
  }

  const row = (t: Task) => {
    const st = statusOf(ws.statuses, t.status)
    const pr = PRIO[t.prio] || PRIO.Low
    const a = t.assignee ? { ...person(t.assignee), color: '#fff', ring: 'none' } : unassigned
    return (
      <div key={t.id} className="flex min-h-11 items-center gap-2.5 border-t-[1.5px] border-line-3 px-3.5 py-1.5">
        <span className="size-[7px] flex-none rounded-[2px]" style={{ background: TYPES[t.type][0] }} />
        <span className="w-14 flex-none text-[12.5px] text-ink-2">{taskKey(t)}</span>
        <span onClick={() => openTask(t)} className="min-w-0 flex-1 cursor-pointer truncate text-[14px] font-semibold hover:text-blue-ink">
          {t.title}
        </span>
        <span className="inline-flex h-[22px] flex-none items-center rounded-full px-2 text-[12px] font-semibold" style={{ background: pr[1], color: pr[0] }}>
          {t.prio}
        </span>
        <span
          className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap rounded-full py-0.5 pl-[7px] pr-[9px] text-[12px] font-semibold"
          style={{ background: st.soft, color: st.ink }}
        >
          <span className="size-1.5 rounded-full" style={{ background: st.c }} />
          {st.name}
        </span>
        <Avatar title={t.assignee || 'Unassigned'} i={a.i} bg={a.bg} color={a.color} ring={a.ring} size={22} radius={5} font={9.5} />
        <span className="relative inline-flex flex-none">
          <select
            value={t.sprint || ''}
            onChange={e => move(t, e.target.value)}
            aria-label={'Sprint for ' + taskKey(t)}
            className="h-[30px] cursor-pointer appearance-none rounded-lg border-[1.5px] border-line bg-white pl-2.5 pr-[26px] text-[12.5px] font-semibold text-ink outline-0"
          >
            {eSp.map(x => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
            <option value="">Backlog</option>
          </select>
          <Icon d={PATHS.chevron} size={11} sw={2.8} className="pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-ink-2" />
        </span>
      </div>
    )
  }

  const section = (x: Sprint) => {
    const ts = epT.filter(t => t.sprint === x.id)
    const [ink, soft, , label] = SPRINT_STATE[x.state]
    return (
      <div key={x.id} className="overflow-hidden rounded-[14px] border-[1.5px] border-line-2 bg-white">
        <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-3">
          <span className="text-[14px] font-semibold text-ink">{x.name}</span>
          <span className="inline-flex items-center rounded-full px-[9px] py-0.5 text-[12px] font-semibold" style={{ background: soft, color: ink }}>
            {label}
          </span>
          <span className="text-[13px] text-ink-2">
            {range(x.start, x.end)} · {weeks(x.start, x.end)} · {ts.length} tasks
          </span>
          <span className="ml-auto inline-flex">
            {x.members.map(n => {
              const m = person(n)
              return <Avatar key={n} title={n} i={m.i} bg={m.bg} size={22} radius={5} font={9} ring="0 0 0 2px #fff" style={{ marginRight: -4 }} />
            })}
          </span>
        </div>
        {ts.map(row)}
        {!ts.length && <div className="border-t-[1.5px] border-line-3 px-3.5 py-3 text-[13px] text-ink-2">No tasks planned yet. Move some in from the backlog.</div>}
      </div>
    )
  }

  const create = () => {
    const v = draft.trim()
    if (!v) return
    send({
      type: 'task.create',
      task: {
        id: nextTaskId(tasks),
        title: v,
        type: 'Task',
        status: ws.statuses[0].id,
        prio: 'Medium',
        due: '',
        assignee: '',
        contribs: [],
        est: '',
        desc: '',
        atts: [],
        subs: [],
        deps: [],
        epic: ui.epic,
        sprint: null,
        start: TODAY,
        time: {},
        acts: [{ kind: 'history', who: me.name, what: 'created the task', when: 'just now' }],
      },
    })
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-3.5">
      {eSp.map(section)}
      <div className="overflow-hidden rounded-[14px] border-[1.5px] border-line-2 bg-white">
        <div className="flex items-center gap-2.5 px-3.5 py-3">
          <span className="text-[14px] font-semibold text-ink">Backlog</span>
          <span className="text-[13px] text-ink-2">{back.length} tasks</span>
        </div>
        {back.map(row)}
        <div className="border-t-[1.5px] border-line-3 px-3.5 pb-3 pt-2">
          <input
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && create()}
            placeholder="+ Create a backlog item and press Enter"
            className="h-[34px] w-full rounded-lg border-0 bg-canvas px-2.5 text-[13.5px] text-ink outline-0"
          />
        </div>
      </div>
    </div>
  )
}
