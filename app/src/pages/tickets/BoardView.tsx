import { useState, type DragEvent, type ReactNode } from 'react'
import { useRequests, useSend, useWorkspace } from '../../api/queries'
import type { DevopsRequest, Priority, Task, TaskId } from '../../api/types'
import { Icon, PATHS } from '../../components/ui'
import { diff, short, TODAY } from '../../lib/dates'
import { usePerson } from '../../state/page'
import { useUi } from '../../state/ui'
import { assigneesOf, blurb, cardAvatars, taskKey } from '../../domain/tasks'
import { useCreateTicket, useOpenTask } from '../../features/useOpenTask'
import { useMe } from '../../features/tickets/useMe'
import { useOpenRequest } from '../../features/tickets/DevopsPanel'
import { useBoardTasks } from '../clients/BoardView'
import { TaskCard, type CardModel } from '../clients/TaskCard'

const REQ_STATUS: Record<string, string> = { Open: 'todo', 'In progress': 'prog', Done: 'done' }

/**
 * The team's board: one column per status, plus a Bugs column (bugs still to
 * do) placed before Done. Every column has "+" buttons that create a ticket.
 */
export function BoardView() {
  const me = useMe()
  const ws = useWorkspace().data!
  const ui = useUi()
  const send = useSend()
  const person = usePerson()
  const list = useBoardTasks()
  const requests = useRequests().data ?? []
  const openTask = useOpenTask()
  const openRequest = useOpenRequest()
  const createTicket = useCreateTicket()
  const [dragId, setDragId] = useState<TaskId | null>(null)
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
  const reqs = requests.filter(r => r.key === ws.devopsLinks[ui.epic] && (!q || (r.text + ' ' + r.rkey).toLowerCase().includes(q)))
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
  const isBug = (t: Task) => t.type === 'Bug' && t.status === first
  const drop = (target: string) => (e: DragEvent) => {
    e.preventDefault()
    const t = list.find(x => x.id === dragId)
    setDragId(null)
    setOver(null)
    if (!t) return
    if (target === '__bugs') {
      if (t.type !== 'Bug' || t.status !== first)
        send({ type: 'task.update', who: me.name, id: t.id, patch: { type: 'Bug', status: first }, log: 'moved it to Bugs' })
      return
    }
    const s = ws.statuses.find(x => x.id === target)!
    if (t.status !== s.id) send({ type: 'task.update', who: me.name, id: t.id, patch: { status: s.id }, log: 'moved it to ' + s.name })
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

  const create = (status: string, type?: Task['type'], top = false) => createTicket({ epic: ui.epic, status, type, top })

  const column = (o: {
    id: string
    name: string
    head?: ReactNode
    nameColor: string
    tasks: Task[]
    reqs: DevopsRequest[]
    bg: string
    ring: string
    add: (top: boolean) => void
  }) => (
    <div
      key={o.id}
      data-col={o.name}
      onDragOver={dragOver(o.id)}
      onDrop={drop(o.id)}
      className="flex w-[290px] flex-none flex-col gap-2 rounded-[14px] p-2.5 transition-[background,box-shadow]"
      style={{ background: o.bg, boxShadow: o.ring }}
    >
      <div className="flex items-center gap-2 px-1.5 py-1">
        {o.head}
        <span className="text-[13.5px] font-semibold" style={{ color: o.nameColor }}>
          {o.name}
        </span>
        <span className="tnum text-[13px] text-ink-2">{o.tasks.length + o.reqs.length}</span>
        <button
          type="button"
          onClick={() => o.add(true)}
          title="Add task to top"
          className="ml-auto grid size-[26px] cursor-pointer place-items-center rounded-[7px] border-[1.5px] border-line bg-white p-0 text-blue-ink hover:border-blue hover:bg-sky-2"
        >
          <Icon d={PATHS.plus} size={12} sw={3} />
        </button>
      </div>
      {o.tasks.map(t => (
        <TaskCard key={t.id} c={taskCard(t)} onOpen={() => openTask(t)} {...cardProps(t)} />
      ))}
      {o.reqs.map(r => (
        <TaskCard key={'r' + r.id} c={reqCard(r)} onOpen={() => openRequest(r)} dragging={false} />
      ))}
      <button
        type="button"
        onClick={() => o.add(false)}
        title="Add task"
        className="h-9 cursor-pointer rounded-[10px] border-[1.5px] border-dashed border-line bg-transparent text-[18px] leading-none text-ink-2 hover:border-blue hover:bg-white hover:text-blue-ink"
      >
        +
      </button>
    </div>
  )

  const statusCols = ws.statuses.map(s => {
    const isOver = over === s.id
    return column({
      id: s.id,
      name: s.name,
      nameColor: '#1B2D45',
      tasks: list.filter(t => t.status === s.id && !isBug(t)),
      reqs: reqs.filter(r => (REQ_STATUS[r.status || 'Open'] || first) === s.id),
      bg: isOver ? '#DCE5FA' : '#EEF3FB',
      ring: isOver ? 'inset 0 0 0 2px #4870E8' : 'none',
      add: top => create(s.id, undefined, top),
    })
  })
  const bugOver = over === '__bugs'
  const bugCol = column({
    id: '__bugs',
    name: 'Bugs',
    nameColor: '#A5502C',
    head: (
      <span className="grid size-[22px] place-items-center rounded-md bg-red text-white">
        <Icon d={PATHS.bug} size={13} />
      </span>
    ),
    tasks: list.filter(isBug),
    reqs: [],
    bg: bugOver ? '#F9D3CC' : '#FBEDEA',
    ring: bugOver ? 'inset 0 0 0 2px #C0392B' : 'inset 0 0 0 1.5px #F2C9C1',
    add: top => create(first, 'Bug', top),
  })
  // Bugs sit just before Done.
  const di = ws.statuses.findIndex(s => s.id === 'done')
  const columns = di < 0 ? [...statusCols, bugCol] : [...statusCols.slice(0, di), bugCol, ...statusCols.slice(di)]

  return (
    <div className="-mx-7 overflow-x-auto px-7 pb-2">
      <div className="flex w-max items-start gap-3">{columns}</div>
    </div>
  )
}
