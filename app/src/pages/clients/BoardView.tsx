import { useState, type DragEvent } from 'react'
import { useQuestions, useRequests, useSend, useTasks, useWorkspace } from '../../api/queries'
import type { DevopsRequest, Priority, Task } from '../../api/types'
import { Icon, PATHS } from '../../components/ui'
import { diff, short, TODAY } from '../../lib/dates'
import { ME, questionTags } from '../../lib/theme'
import { useOverlay, useUi } from '../../state/ui'
import { assigneesOf, blurb, cardAvatars, taskKey } from '../../domain/tasks'
import { usePerson } from '../../state/page'
import { clientQuestionState } from '../../domain/questions'
import { TaskCard, type CardModel } from './TaskCard'
import { useOpenTask } from '../../features/useOpenTask'

const REQ_STATUS: Record<string, string> = { Open: 'todo', 'In progress': 'prog', Done: 'done' }

/** Tasks matching the board's epic, sprint, search and filter settings. */
export function useBoardTasks() {
  const ui = useUi()
  const tasks = useTasks().data ?? []
  const q = ui.q.trim().toLowerCase()
  const EPS = ui.epSel.includes(ui.epic) ? ui.epSel : [ui.epic]
  return tasks.filter(
    t =>
      !t.parent &&
      EPS.includes(t.epic) &&
      (!ui.spSel || ui.spSel.includes(t.sprint || 'backlog')) &&
      (!q || (t.title + ' ' + taskKey(t)).toLowerCase().includes(q)) &&
      (!ui.mine || t.assignee === ME) &&
      (!ui.typeF || t.type === ui.typeF) &&
      (!ui.prioF || t.prio === ui.prioF),
  )
}

export function BoardView() {
  const person = usePerson()
  const ws = useWorkspace().data!
  const ui = useUi()
  const send = useSend()
  const overlay = useOverlay()
  const list = useBoardTasks()
  const requests = useRequests().data ?? []
  const questions = useQuestions().data ?? []
  const [dragId, setDragId] = useState<number | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const sprintShort = (id: string | null) => {
    const sp = ws.sprints.find(x => x.id === id)
    return sp ? sp.name.replace('Sprint ', 'S') : 'Backlog'
  }

  const taskCard = (t: Task): CardModel => {
    const overdue = !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'
    return {
      id: 't' + t.id,
      key: taskKey(t),
      title: t.title,
      blurb: blurb(t.desc),
      prio: t.prio,
      critical: t.prio === 'Critical',
      blink: t.prio === 'Critical' && t.status !== 'done',
      sprintLabel: sprintShort(t.sprint),
      dueLabel: t.due ? (overdue ? 'Overdue ' : 'Due ') + short(t.due) : 'No due date',
      dueColor: overdue ? '#C0392B' : '#3B4A5E',
      dueWeight: overdue ? 800 : 600,
      avatars: cardAvatars(assigneesOf(t), person),
      subLabel: t.subs.length ? t.subs.filter(x => x.done).length + '/' + t.subs.length : undefined,
      draggable: true,
    }
  }

  // DevOps requests linked to this epic's project show up as cards too.
  const q = ui.q.trim().toLowerCase()
  const reqs = requests.filter(
    r => r.key === ws.devopsLinks[ui.epic] && (!q || (r.text + ' ' + r.rkey).toLowerCase().includes(q)),
  )
  const reqCard = (r: DevopsRequest): CardModel => ({
    id: 'r' + r.id,
    key: r.rkey,
    title: r.text,
    blurb: 'DevOps request · ' + (r.type || ''),
    prio: (r.prio || 'Medium') as Priority,
    critical: r.prio === 'Critical',
    blink: r.prio === 'Critical' && r.status !== 'Done',
    sprintLabel: 'DevOps',
    dueLabel: r.due ? 'Due ' + short(r.due) : 'No due date',
    dueColor: '#22354C',
    dueWeight: 500,
    avatars: cardAvatars([r.to || 'DevOps team'], person).map(a => (r.to ? a : { ...a, i: 'D', bg: '#9F89E5' })),
    draggable: false,
  })

  const first = ws.statuses[0].id
  const drop = (target: string) => (e: DragEvent) => {
    e.preventDefault()
    const t = list.find(x => x.id === dragId)
    setDragId(null)
    setOver(null)
    if (!t) return
    if (target === '__bugs') {
      if (t.type !== 'Bug' || t.status !== first)
        send({ type: 'task.update', id: t.id, patch: { type: 'Bug', status: first }, log: 'moved it to Bugs' })
      return
    }
    const s = ws.statuses.find(x => x.id === target)!
    if (t.status !== s.id) send({ type: 'task.update', id: t.id, patch: { status: s.id }, log: 'moved it to ' + s.name })
  }
  const dragOver = (id: string) => (e: DragEvent) => {
    e.preventDefault()
    if (over !== id) setOver(id)
  }
  const cardProps = (t: Task) => ({
    onDragStart: (e: DragEvent) => {
      setDragId(t.id)
      try {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(t.id))
      } catch {
        // Some browsers block dataTransfer in tests; dragging still works.
      }
    },
    onDragEnd: () => {
      setDragId(null)
      setOver(null)
    },
    dragging: dragId === t.id,
  })
  const openTask = useOpenTask()

  const bugs = list.filter(t => t.clientBug)
  const bugOver = over === '__bugs'
  const addBugButton = (
    <button
      type="button"
      onClick={() => overlay.open('report', 'top')}
      title="Add task to top"
      className="grid size-[26px] cursor-pointer place-items-center rounded-[7px] border-[1.5px] border-line bg-white p-0 text-blue-ink hover:border-blue hover:bg-sky-2"
    >
      <Icon d={PATHS.plus} size={12} sw={3} />
    </button>
  )

  const qs = questions
    .map(x => ({ x, st: clientQuestionState(x) }))
    .sort((a, b) => a.st.ord - b.st.ord)
  const needYou = qs.filter(y => y.st.ord < 2).length

  return (
    <div className="-mx-7 overflow-x-auto px-7 pb-2">
      <div className="flex w-max items-start gap-3">
        {/* Bugs the client reported. Only place clients can add tickets. */}
        <div
          onDragOver={dragOver('__bugs')}
          onDrop={drop('__bugs')}
          className="flex w-[290px] flex-none flex-col gap-2 rounded-[14px] p-2.5 transition-[background,box-shadow]"
          style={{
            background: bugOver ? '#F9D3CC' : '#FBEDEA',
            boxShadow: bugOver ? 'inset 0 0 0 2px #C0392B' : 'inset 0 0 0 1.5px #F2C9C1',
          }}
        >
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="grid size-[22px] place-items-center rounded-md bg-red text-white">
              <Icon d={PATHS.bug} size={13} />
            </span>
            <span className="text-[13.5px] font-semibold text-rust">Bugs</span>
            <span className="tnum text-[13px] text-ink-2">{bugs.length}</span>
            <span className="ml-auto flex">{addBugButton}</span>
          </div>
          {bugs.map(t => (
            <TaskCard key={t.id} c={taskCard(t)} onOpen={() => openTask(t)} {...cardProps(t)} />
          ))}
          <button
            type="button"
            onClick={() => overlay.open('report')}
            title="Add task"
            className="h-9 cursor-pointer rounded-[10px] border-[1.5px] border-dashed border-line bg-transparent text-[18px] leading-none text-ink-2 hover:border-blue hover:bg-white hover:text-blue-ink"
          >
            +
          </button>
        </div>

        {/* Questions the team asked the client. */}
        <div className="flex w-[320px] flex-none flex-col gap-2 rounded-[14px] bg-purple-soft p-2.5 shadow-[inset_0_0_0_1.5px_#DCD3F5]">
          <div className="flex items-center gap-2 px-1.5 py-1">
            <span className="grid size-[22px] place-items-center rounded-md bg-purple text-[13px] font-extrabold text-white">?</span>
            <span className="text-[13.5px] font-semibold text-purple-ink">Questions to client</span>
            <span className="tnum text-[13px] text-ink-2">{qs.length}</span>
            <span className="ml-auto text-[12px] font-semibold text-purple-ink">
              {needYou ? needYou + ' need you' : 'All caught up'}
            </span>
          </div>
          {qs.map(({ x, st }) => {
            const title = x.title || x.text
            const text = x.title ? x.text : ''
            const tags = [...(x.fromDevops ? [{ t: 'DevOps', bg: '#E7EEFB', c: '#1F3FAF' }] : []), ...questionTags(x)]
            return (
              <div
                key={x.id}
                onClick={() => overlay.open('question', x.id)}
                className="flex cursor-pointer flex-col gap-2 rounded-[14px] bg-white px-3.5 py-3 hover:!shadow-[0_0_0_1.5px_#6E58C9,0_6px_16px_-8px_rgba(27,45,69,0.2)]"
                style={{ boxShadow: `0 0 0 1.5px ${x.answer ? '#D6DEE8' : '#BBAEEA'}` }}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className="inline-flex h-[22px] items-center whitespace-nowrap rounded-md px-2 text-[11.5px] font-bold"
                    style={{ background: st.cardBg, color: st.cardC }}
                  >
                    {st.label}
                  </span>
                  {tags.map(g => (
                    <span
                      key={g.t}
                      className="inline-flex h-[22px] items-center whitespace-nowrap rounded-md px-2 text-[11.5px] font-bold"
                      style={{ background: g.bg, color: g.c }}
                    >
                      {g.t}
                    </span>
                  ))}
                </div>
                <div className="text-[14px] font-semibold leading-[1.4] text-ink">{title}</div>
                {title && text && <div className="clamp-2 text-[13px] leading-[1.45] text-ink-2">{text}</div>}
                <div className="flex items-center gap-1.5 whitespace-nowrap border-t-[1.5px] border-sky pt-2 text-[12px] text-muted">
                  <span className="font-semibold text-ink">{x.by}</span>
                  <span>· {x.when}</span>
                  <span className="ml-auto font-bold text-purple">{st.cta}</span>
                </div>
              </div>
            )
          })}
        </div>

        {ws.statuses.map(s => {
          const cards = list.filter(t => t.status === s.id && !t.clientBug)
          const rcs = reqs.filter(r => (REQ_STATUS[r.status || 'Open'] || first) === s.id)
          const isOver = over === s.id
          return (
            <div
              key={s.id}
              onDragOver={dragOver(s.id)}
              onDrop={drop(s.id)}
              className="flex w-[290px] flex-none flex-col gap-2 rounded-[14px] p-2.5 transition-[background,box-shadow]"
              style={{ background: isOver ? '#DCE5FA' : '#EEF3FB', boxShadow: isOver ? 'inset 0 0 0 2px #4870E8' : 'none' }}
            >
              <div className="flex items-center gap-2 px-1.5 py-1">
                <span className="text-[13.5px] font-semibold text-ink">{s.name}</span>
                <span className="tnum text-[13px] text-ink-2">{cards.length + rcs.length}</span>
              </div>
              {cards.map(t => (
                <TaskCard key={t.id} c={taskCard(t)} onOpen={() => openTask(t)} {...cardProps(t)} />
              ))}
              {rcs.map(r => (
                <TaskCard key={'r' + r.id} c={reqCard(r)} onOpen={() => overlay.open('request', r.id)} dragging={false} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
