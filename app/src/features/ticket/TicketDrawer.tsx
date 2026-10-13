import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useLocation } from 'react-router'
import { useEntries } from '../../api/queries'
import type { Command } from '../../api/commands'
import type { Attachment, Subtask, Task } from '../../api/types'
import { Markdown } from '../../components/Markdown'
import { Avatar, Backdrop, CloseButton, CountPill, Icon, Label, PATHS, Scrim, TabButton, unassigned } from '../../components/ui'
import { diff, fmt, short, TODAY } from '../../lib/dates'
import { focusField } from '../../lib/focusField'
import { pal, PEOPLE, PRIO, PRIO_LIST, TYPE_LIST, TYPES } from '../../lib/theme'
import { usePage } from '../../state/page'
import { ClientChat } from './ClientChat'
import { useOverlay } from '../../state/ui'
import { useActorName, useActorSend, useIsClient, useScopedTasks, useScopedWorkspace } from '../../state/access'
import {
  assigneesOf,
  entryCount,
  estimateHours,
  fileExt,
  fileSize,
  loggedHours,
  rh,
  sprintsOf,
  statusOf,
  taskKey,
} from '../../domain/tasks'
import { DescriptionEditor } from './DescriptionEditor'
import { Caret, PillDropdown, type PillOption } from './PillDropdown'

type Tab = 'details' | 'subs' | 'act' | 'chat'

const VIEW_NAMES: Record<string, string> = {
  board: 'board',
  plan: 'epics & sprints',
  timeline: 'timeline',
  overview: 'overview',
  tasks: 'tasks',
  backlog: 'backlog',
  timesheet: 'timesheet',
  files: 'files',
}

/** Subtasks with titles and done state taken from their full records once opened. */
const subsOf = (raw: Task, tasks: Task[]): Subtask[] =>
  raw.subs.map(x => {
    const r = x.sid ? tasks.find(y => y.id === x.sid) : undefined
    return r ? { ...x, t: r.title, done: r.status === 'done' } : x
  })

/** The full ticket, opened from the board, plan or timeline. Subtasks open in the same drawer. */
export function TicketDrawer({ id }: { id: number }) {
  const tasks = useScopedTasks() ?? []
  const overlay = useOverlay()
  const isClient = useIsClient()
  const [navStack, setNavStack] = useState<number[]>([])
  const [initialTab, setInitialTab] = useState<Tab>('details')
  const [railHide, setRailHide] = useState<boolean | null>(null)
  const raw0 = tasks.find(t => t.id === id)
  // Client-reported bugs open in the bug window; a link to one of them lands there.
  const isBug = !!raw0?.clientBug
  useEffect(() => {
    if (isClient && isBug) overlay.open('bug', id, { replace: true })
    // Only the item and the role decide the redirect.
  }, [isClient, isBug, id])

  const go = (to: number, tab: Tab = 'details', stack = navStack) => {
    setNavStack(stack)
    setInitialTab(tab)
    overlay.open('ticket', to, { replace: true })
  }

  const onClose = () => {
    setNavStack([])
    overlay.close('ticket')
  }

  if (!raw0) return null
  return (
    <TicketBody
      key={id}
      raw0={raw0}
      tasks={tasks}
      initialTab={initialTab}
      navStack={navStack}
      railHide={railHide}
      setRailHide={setRailHide}
      go={go}
      onClose={onClose}
    />
  )
}

/**
 * A ticket created by "+ Create ticket" starts empty. Left without a title (any close path,
 * browser Back or a route change), it is removed; a typed title is saved instead.
 * Does nothing once the ticket has a title, so it is safe to run more than once.
 */
function settleNewTicket(send: (cmd: Command) => void, t: Task, titleDraft: string) {
  if (!t.isNew || t.title) return
  const v = titleDraft.trim()
  if (v) send({ type: 'task.update', id: t.id, patch: { title: v, isNew: false } })
  else send({ type: 'task.delete', id: t.id })
}

function TicketBody({
  raw0,
  tasks,
  initialTab,
  navStack,
  railHide,
  setRailHide,
  go,
  onClose,
}: {
  raw0: Task
  tasks: Task[]
  initialTab: Tab
  navStack: number[]
  railHide: boolean | null
  setRailHide: (v: boolean) => void
  go: (to: number, tab?: Tab, stack?: number[]) => void
  onClose: () => void
}) {
  const ws = useScopedWorkspace()!
  const entries = useEntries().data ?? []
  const send = useActorSend()
  const me = useActorName()
  const loc = useLocation()
  const { person, side } = usePage()
  const view = loc.pathname.split('/')[2] || 'board'
  // Clients only raise bugs and answer questions: a team ticket (or a subtask) is View only, with no comments.
  const isClient = useIsClient()
  const ro = isClient && !raw0.clientBug

  const [tab, setTab] = useState<Tab>(raw0.parent && initialTab === 'subs' ? 'details' : initialTab)
  const [tdd, setTdd] = useState<string | null>(null)
  const [descEdit, setDescEdit] = useState(false)
  const [titleDraft, setTitleDraft] = useState(raw0.title)
  const [estDraft, setEstDraft] = useState(raw0.est)
  const [subDraft, setSubDraft] = useState('')
  const [cDraft, setCDraft] = useState('')
  const [actTab, setActTab] = useState<'all' | 'comments' | 'history'>('all')
  const [asAll, setAsAll] = useState(false)
  const [logHr, setLogHr] = useState(0)
  const [logMin, setLogMin] = useState(0)
  const [dropOn, setDropOn] = useState(false)

  // The latest values, read by the close paths below (including the unmount cleanup).
  const latest = useRef({ task: raw0, titleDraft, send, settled: false })
  latest.current = { task: raw0, titleDraft, send, settled: latest.current.settled }
  const pendingSettle = useRef<number | undefined>(undefined)

  /** Settles the new ticket once per drawer instance. */
  const settle = () => {
    const L = latest.current
    if (L.settled) return
    L.settled = true
    settleNewTicket(L.send, L.task, L.titleDraft)
  }
  const close = () => {
    settle()
    onClose()
  }

  // Leaving the drawer by any route (browser Back, a link, a route change, another ticket) settles it too.
  // The settle is deferred one tick so that React's strict-mode effect replay, which runs cleanup straight
  // after mount, cancels it instead of removing a ticket that is still open.
  useEffect(() => {
    window.clearTimeout(pendingSettle.current)
    return () => {
      pendingSettle.current = window.setTimeout(settle, 0)
    }
  }, [])

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // An open menu closes first; the next Escape closes the drawer.
      if (tdd || asAll) {
        setTdd(null)
        setAsAll(false)
        return
      }
      close()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [tdd, asAll, close])

  useEffect(() => {
    if (raw0.isNew && !raw0.title) setTimeout(() => document.querySelector<HTMLInputElement>('input[placeholder="Ticket title"]')?.focus(), 150)
  }, [raw0.isNew, raw0.title])

  const raw: Task = { ...raw0, subs: subsOf(raw0, tasks) }
  const id = raw.id
  const upd = (patch: Partial<Task>, log?: string) => {
    if (ro) return
    send({ type: 'task.update', id, patch, log })
  }
  const key = taskKey(raw)
  const st = statusOf(ws.statuses, raw.status)
  const ty = TYPES[raw.type]
  const pr = PRIO[raw.prio] || PRIO.Low
  const A = assigneesOf(raw)
  const ep = ws.epics.find(e => e.id === raw.epic)
  const sp = ws.sprints.find(x => x.id === raw.sprint)
  const par = raw.parent ? tasks.find(t => t.id === raw.parent) : undefined
  const isSub = !!raw.parent
  const prevId = navStack[navStack.length - 1]
  const prevT = prevId != null ? tasks.find(t => t.id === prevId) : undefined
  const d = raw.due ? diff(raw.due, TODAY) : null
  const late = d != null && d < 0 && raw.status !== 'done'
  const logged = loggedHours(raw, entries)
  const nEnt = entryCount(raw, entries)
  const estN = estimateHours(raw)
  const estOver = estN > 0 && logged > estN
  const people = PEOPLE

  // ---------- subtasks
  const openSub = (parent: Task, i: number) => {
    const x = parent.subs[i]
    if (!x) return
    const stack = x.sid !== id ? [...navStack, id] : navStack
    if (x.sid && tasks.some(y => y.id === x.sid)) {
      go(x.sid, 'details', stack)
      return
    }
    const sid = 100000 + parent.id * 100 + i + 1
    const rec: Task = {
      id: sid,
      parent: parent.id,
      subKey: taskKey(parent) + '.' + (i + 1),
      title: x.t,
      type: 'Task',
      status: x.done ? 'done' : ws.statuses[0].id,
      prio: parent.prio,
      due: x.due || '',
      assignee: x.assignee || '',
      contribs: [],
      est: '',
      desc: x.note || '',
      atts: [],
      subs: [],
      deps: [],
      epic: parent.epic,
      sprint: parent.sprint,
      start: parent.start || TODAY,
      time: {},
      acts: [{ kind: 'history', who: me, what: 'opened subtask of ' + taskKey(parent), when: 'just now' }],
    }
    send({
      type: 'batch',
      cmds: [
        { type: 'task.create', task: rec },
        { type: 'task.update', id: parent.id, patch: { subs: parent.subs.map((y, j) => (j === i ? { ...y, sid } : y)) } },
      ],
    })
    go(sid, 'details', stack)
  }
  const toggleSub = (i: number) => {
    if (ro) return
    const x = raw.subs[i]
    const done = !x.done
    const cmds: Command[] = [
      {
        type: 'task.update',
        id,
        patch: { subs: raw0.subs.map((y, j) => (j === i ? { ...y, done } : y)) },
        log: (done ? 'completed' : 'reopened') + ' subtask “' + x.t + '”',
      },
    ]
    if (x.sid) cmds.push({ type: 'task.update', id: x.sid, patch: { status: done ? 'done' : ws.statuses[0].id } })
    send({ type: 'batch', cmds })
  }
  const addSub = () => {
    const v = subDraft.trim()
    if (!v || ro) return
    upd({ subs: [...raw0.subs, { t: v, done: false }] }, 'added subtask “' + v + '”')
    setSubDraft('')
  }

  // ---------- comments
  const post = () => {
    const v = cDraft.trim()
    if (!v || ro) return
    send({ type: 'task.comment', id, text: v })
    setCDraft('')
  }

  // ---------- title
  const saveTitle = () => {
    const v = titleDraft.trim()
    if (v && !raw.title) upd({ title: v, isNew: false })
    else if (v && v !== raw.title) upd({ title: v }, 'renamed it to “' + v + '”')
    else setTitleDraft(raw.title)
  }

  // ---------- attachments
  const addFiles = (fs: File[]) => {
    if (!fs.length) return
    const add: Attachment[] = fs.map(f => ({ name: f.name, size: fileSize(f.size), date: fmt(TODAY) }))
    upd({ atts: [...raw.atts, ...add] }, 'added ' + (add.length > 1 ? add.length + ' attachments' : 'an attachment'))
  }

  // ---------- status flow
  const stl = ws.statuses
  const ci = stl.findIndex(x => x.id === raw.status)
  const curC = pal(stl[ci]?.p ?? 0)[0]
  const nxt = stl[ci + 1]

  // ---------- sidebar dropdowns
  const pick = (onPick: () => void) => () => {
    if (ro) return
    setTdd(null)
    onPick()
  }
  const sps = sprintsOf(ws.sprints, raw.epic)
  const rows: {
    k: string
    label: string
    value: string
    c: string
    bg: string
    avatar?: { i: string; bg: string }
    options: PillOption[]
  }[] = [
    {
      k: 'status',
      label: 'Status',
      value: st.name,
      c: st.ink,
      bg: st.soft,
      options: stl.map(s => ({
        key: s.id,
        label: s.name,
        dot: pal(s.p)[0],
        selected: s.id === raw.status,
        pick: pick(() => s.id !== raw.status && upd({ status: s.id }, 'changed status to ' + s.name)),
      })),
    },
    {
      k: 'prio',
      label: 'Priority',
      value: raw.prio,
      c: pr[0],
      bg: pr[1],
      options: PRIO_LIST.map(p => ({
        key: p,
        label: p,
        dot: PRIO[p][0],
        selected: p === raw.prio,
        pick: pick(() => p !== raw.prio && upd({ prio: p }, 'set priority to ' + p)),
      })),
    },
    {
      k: 'type',
      label: 'Type',
      value: raw.type,
      c: ty[2],
      bg: ty[1],
      options: TYPE_LIST.map(p => ({
        key: p,
        label: p,
        dot: TYPES[p][0],
        selected: p === raw.type,
        pick: pick(() => p !== raw.type && upd({ type: p }, 'changed type to ' + p)),
      })),
    },
    {
      k: 'assignee',
      label: 'Assignee',
      value: A.length ? (A.length > 1 ? A[0].split(' ')[0] + ' +' + (A.length - 1) : A[0]) : 'Unassigned',
      c: '#1B2D45',
      bg: '#EEF3FB',
      avatar: raw.assignee ? person(raw.assignee) : { i: '+', bg: '#A9B6C5' },
      // Several people can be assigned, so the menu stays open while picking.
      options: people.map(n => {
        const on = A.includes(n)
        return {
          key: n,
          label: n,
          dot: person(n).bg,
          selected: on,
          pick: () => {
            const L = on ? A.filter(x => x !== n) : [...A, n]
            const cmds: Command[] = [
              {
                type: 'task.update',
                id,
                patch: { assignees: L, assignee: L[0] || '', contribs: raw.contribs.filter(x => !L.includes(x)) },
                log: on ? 'removed ' + n + ' as assignee' : 'assigned ' + n,
              },
            ]
            if (!on && raw.sprint) cmds.push({ type: 'sprint.addMembers', id: raw.sprint, names: [n] })
            send({ type: 'batch', cmds })
          },
        }
      }),
    },
    {
      k: 'epic',
      label: 'Epic',
      value: ep ? ep.name : 'None',
      c: '#3F2E94',
      bg: '#E6DFFA',
      options: ws.epics.map(e => ({
        key: e.id,
        label: e.name,
        dot: pal(e.p)[0],
        selected: e.id === raw.epic,
        pick: pick(() => e.id !== raw.epic && upd({ epic: e.id, sprint: null }, 'moved it to epic ' + e.name)),
      })),
    },
    {
      k: 'sprint',
      label: 'Sprint',
      value: sp ? sp.name : 'Backlog',
      c: sp ? '#1F3FAF' : '#7A5C0E',
      bg: sp ? '#DCE5FA' : '#FBEDC2',
      options: [
        ...sps.map(x => ({
          key: x.id,
          label: x.name + (x.state === 'active' ? ' · active' : x.state === 'done' ? ' · done' : ''),
          dot: x.state === 'active' ? '#4870E8' : x.state === 'done' ? '#3F9079' : '#A9B6C5',
          selected: x.id === raw.sprint,
          pick: pick(() => x.id !== raw.sprint && upd({ sprint: x.id }, 'moved it to ' + x.name)),
        })),
        {
          key: 'backlog',
          label: 'Backlog',
          dot: '#B98A2F',
          selected: !raw.sprint,
          pick: pick(() => raw.sprint && upd({ sprint: null }, 'moved it to the backlog')),
        },
      ],
    },
  ]

  // ---------- assignee card
  const people4 = A.length
    ? A.slice(0, 4).map(n => ({ ...person(n), color: '#fff', ring: '0 0 0 0 transparent' }))
    : [{ name: 'Unassigned', ...unassigned }]
  const peopleAll = [
    ...A.map((n, i) => ({ ...person(n), role: i === 0 ? 'Assignee · primary' : 'Assignee' })),
    ...raw.contribs.map(n => ({ ...person(n), role: 'Contributor' })),
  ].concat(A.length ? [] : [{ name: 'Nobody assigned', i: '–', bg: '#A9B6C5', role: 'Use Edit assignees' }])
  const editAssignees = () => {
    if (ro) return
    setAsAll(false)
    setTdd('d_assignee')
  }

  // ---------- activity
  const acts = raw.acts.filter(a => actTab === 'all' || (actTab === 'comments' ? a.kind === 'comment' : a.kind === 'history'))
  const comments = raw.acts.filter(a => a.kind === 'comment')
  const created = raw.acts[raw.acts.length - 1]

  // ---------- rail (subtask pages)
  const rc = railHide == null ? typeof window !== 'undefined' && window.innerWidth < 1180 : railHide
  const railBack = () => par && go(par.id, 'subs', [...navStack, id])
  const sibs = par
    ? subsOf(par, tasks).map((x, i) => {
        const on = x.sid === id
        const rec = x.sid ? tasks.find(y => y.id === x.sid) : undefined
        const p = rec?.prio || par.prio || 'Low'
        const due = rec?.due || x.due || ''
        const an = rec?.assignee || x.assignee || ''
        const dd = due ? diff(due, TODAY) : null
        return { x, i, on, p, due, an, overdue: dd != null && dd < 0 && !x.done }
      })
    : []

  const navBack = () => {
    if (prevT) go(prevT.id, 'details', navStack.slice(0, -1))
    else close()
  }
  const backLabel = prevT ? 'Back to ' + taskKey(prevT) : 'Back to ' + (VIEW_NAMES[view] || 'board')
  const rowCols = isSub ? 'minmax(0,1fr)' : '110px minmax(0,1fr)'
  const rowGap = isSub ? 8 : 20
  const dTabs: [Tab, string, number][] = [
    ['details', isSub ? 'Overview' : 'Details', raw.atts.length + raw.deps.length],
    ['subs', 'Subtasks', raw.subs.length],
    ['act', 'Activity', raw.acts.length],
    // The team chats with the client on bugs the client reported.
    ...(raw.clientBug && side === 'team' ? [['chat', 'Client chat', raw.clientBug.chat.length] as [Tab, string, number]] : []),
  ]
  const sdn = raw.subs.filter(x => x.done).length
  const subPct = raw.subs.length ? Math.round((sdn / raw.subs.length) * 100) + '%' : '0%'

  // Due and Time shortcuts; only these two get the blue hover ring (the Assignee card does not).
  const factBase = 'flex min-w-0 cursor-pointer flex-col gap-1.5 rounded-xl bg-white px-3.5 py-3 shadow-[0_0_0_1.5px_#C9D2DD] transition-shadow'
  const fact = factBase + ' hover:shadow-[0_0_0_1.5px_#4870E8] focus-visible:shadow-[0_0_0_2px_#4870E8]'
  /** Enter or Space on a clickable card, for keyboard users. */
  const keyOpen = (fn: () => void) => (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.target !== e.currentTarget) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      fn()
    }
  }
  const sideRow = 'flex min-h-12 items-center justify-between gap-2.5 px-3.5 py-1.5'
  const tnumSm = 'tnum text-[12.5px] text-ink'

  return (
    <>
      <Backdrop onClick={close} z={40} />
      <aside
        className="fixed bottom-3 right-3 top-3 z-[41] flex max-w-[calc(100vw-24px)] animate-pop-in overflow-hidden rounded-[28px] border-[1.5px] border-line bg-white shadow-[0_30px_90px_rgba(27,45,69,0.22)]"
        style={{ width: par ? 'min(1240px, calc(100vw - 24px))' : 'min(1120px, calc(100vw - 24px))' }}
      >
        <CloseButton onClick={close} className="absolute right-4 top-4 z-[5]" />

        {par && rc && (
          <div className="flex flex-[0_0_56px] flex-col items-center gap-2 border-r-[1.5px] border-line bg-canvas py-5">
            <button type="button" onClick={() => setRailHide(false)} title="Show subtasks" className="grid size-[34px] cursor-pointer place-items-center rounded-[10px] border-[1.5px] border-line bg-white p-0 text-blue-ink">
              <Icon d={PATHS.next} size={15} />
            </button>
            <button type="button" onClick={railBack} title={par.title} className="tnum size-[34px] cursor-pointer rounded-[10px] border-0 bg-sky-2 p-0 text-[9.5px] font-semibold text-blue-ink">
              ↑
            </button>
            <div className="my-1 h-[1.5px] w-6 bg-line" />
            {sibs.map(s => (
              <button
                key={s.i}
                type="button"
                onClick={() => openSub(par, s.i)}
                title={s.x.t}
                className="size-[30px] cursor-pointer rounded-full border-[1.5px] p-0 text-[12px] font-bold"
                style={{
                  borderColor: s.on ? '#4870E8' : s.x.done ? '#3F9079' : '#C9D2DD',
                  background: s.on ? '#4870E8' : s.x.done ? '#D6E9E2' : '#fff',
                  color: s.on ? '#fff' : s.x.done ? '#195040' : '#22354C',
                }}
              >
                {s.i + 1}
              </button>
            ))}
          </div>
        )}
        {par && !rc && (
          <div className="flex flex-[0_0_210px] flex-col gap-1.5 overflow-y-auto border-r-[1.5px] border-line bg-canvas px-3 py-[22px]">
            <button type="button" onClick={railBack} className="flex w-full cursor-pointer flex-col items-start gap-1 rounded-xl border-[1.5px] border-line bg-white px-3 py-2.5 text-left hover:border-blue">
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-blue-ink">
                <Icon d={PATHS.back} size={13} sw={2.6} />
                Back to task
              </span>
              <span className="tnum text-[11px] text-muted">{taskKey(par)}</span>
              <span className="text-[13px] font-semibold leading-[1.35] text-ink">{par.title}</span>
            </button>
            <div className="mt-2.5 flex items-center px-1 pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
              Subtasks
              <button type="button" onClick={() => setRailHide(true)} title="Collapse" className="ml-auto grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-ink-2 hover:bg-sky-2">
                <Icon d={PATHS.back} size={14} />
              </button>
            </div>
            {sibs.map(s => {
              const pc = PRIO[s.p] || PRIO.Low
              const a = s.an ? { ...person(s.an), color: '#fff', ring: 'none' } : unassigned
              return (
                <button
                  key={s.i}
                  type="button"
                  onClick={() => openSub(par, s.i)}
                  className="flex w-full cursor-pointer flex-col gap-2 rounded-xl border-[1.5px] px-[11px] py-2.5 text-left hover:!border-blue"
                  style={{
                    borderColor: s.on ? '#4870E8' : '#C9D2DD',
                    background: s.on ? '#E7EEFB' : '#FFFFFF',
                    boxShadow: s.on ? '0 0 0 3px rgba(72,112,232,0.15)' : 'none',
                  }}
                >
                  <span className="flex w-full min-w-0 items-start gap-2">
                    <span
                      className="mt-px grid size-[15px] flex-none place-items-center rounded-full border-[1.5px] text-[8.5px] text-white"
                      style={{ borderColor: s.x.done ? '#3F9079' : '#A9B6C5', background: s.x.done ? '#3F9079' : '#fff' }}
                    >
                      {s.x.done ? '✓' : ''}
                    </span>
                    <span
                      className="clamp-2 min-w-0 flex-1 text-[13px] leading-[1.35]"
                      style={{ fontWeight: s.on ? 700 : 500, color: s.on ? '#1B2D45' : '#22354C', textDecoration: s.x.done ? 'line-through' : 'none' }}
                    >
                      {s.x.t}
                    </span>
                  </span>
                  <span className="flex w-full items-center gap-1.5">
                    <span className="tnum text-[10.5px] text-muted">{taskKey(par)}.{s.i + 1}</span>
                    <span className="inline-flex h-[18px] items-center rounded-full px-[7px] text-[10.5px] font-semibold" style={{ background: pc[1], color: pc[0] }}>
                      {s.p}
                    </span>
                    {s.due && (
                      <span className="tnum whitespace-nowrap text-[10.5px]" style={{ color: s.overdue ? '#C0392B' : '#22354C' }}>
                        {short(s.due)}
                      </span>
                    )}
                    <Avatar title={s.an || 'Unassigned'} i={a.i} bg={a.bg} color={a.color} ring={a.ring} size={20} radius={5} font={8.5} className="ml-auto" />
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-8 pt-[18px]">
            <button type="button" onClick={navBack} className="mb-2.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink">
              <Icon d={PATHS.back} size={14} sw={2.6} />
              {backLabel}
            </button>
            <div className="mb-2.5 flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pr-11 text-[12.5px] text-ink-2">
              {par && (
                <>
                  <button type="button" onClick={railBack} className="tnum cursor-pointer border-0 bg-transparent p-0 text-[12px] font-semibold text-blue-ink hover:underline">
                    {taskKey(par)}
                  </button>
                  <span className="text-faint">/</span>
                  <span className="tnum mr-2 text-[12px] font-semibold text-ink">{key}</span>
                </>
              )}
              <span>Project Management tool</span>
              <span className="text-faint">›</span>
              <span className="font-semibold text-purple-ink">{ep ? ep.name : 'No epic'}</span>
              <span className="text-faint">›</span>
              <span className="font-semibold" style={{ color: sp ? '#1F3FAF' : '#7A5C0E' }}>
                {sp ? sp.name : 'Backlog'}
              </span>
            </div>
            <div className="flex items-center gap-3 pr-11">
              <span className="grid size-8 flex-none place-items-center rounded-lg" style={{ background: ty[1] }}>
                <TypeIcon type={raw.type} />
              </span>
              <input
                value={titleDraft}
                placeholder="Ticket title"
                onChange={e => setTitleDraft(e.target.value)}
                onBlur={saveTitle}
                onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()}
                readOnly={ro}
                title={raw.title}
                className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[22px] font-bold tracking-[-0.02em] text-ink outline-0 [text-overflow:ellipsis]"
              />
              {ro && <span className="flex-none whitespace-nowrap rounded-md bg-sky px-2 py-1 text-[12px] font-semibold text-ink-2">View only</span>}
              <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-2 py-1 text-[12px] font-semibold text-blue-ink">{key}</span>
            </div>

            <div className="mt-[18px] rounded-2xl border-[1.5px] border-line bg-canvas px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex min-w-[260px] flex-1 items-center gap-1">
                  {stl.map((x, i) => (
                    <button
                      key={x.id}
                      type="button"
                      onClick={() => x.id !== raw.status && upd({ status: x.id }, 'changed status to ' + x.name)}
                      title={'Move to ' + x.name}
                      disabled={ro}
                      className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 border-0 bg-transparent p-0 text-left disabled:cursor-default"
                    >
                      <span className="h-[5px] rounded-[3px]" style={{ background: i <= ci ? curC : '#DDE3E8' }} />
                      <span className="truncate text-[12px]" style={{ fontWeight: i === ci ? 700 : 500, color: i === ci ? '#1B2D45' : '#3B4A5E' }}>
                        {x.name}
                      </span>
                    </button>
                  ))}
                </div>
                {nxt ? (
                  <button
                    type="button"
                    onClick={() => upd({ status: nxt.id }, 'changed status to ' + nxt.name)}
                    disabled={ro}
                    className="inline-flex h-[34px] flex-none cursor-pointer items-center gap-2 rounded-[10px] border-0 bg-blue px-3.5 text-[13px] font-semibold text-white shadow-[0_1px_2px_rgba(27,45,69,0.12)] hover:bg-blue-600 disabled:cursor-default disabled:bg-faint"
                  >
                    {/* Separate flex items, so the 8px gap sits before the status name as in the prototype. */}
                    <span>Move to </span>
                    <span>{nxt.name}</span>
                    <Icon d={PATHS.arrowRight} size={14} sw={2.6} />
                  </button>
                ) : (
                  <span className="inline-flex h-[34px] flex-none items-center gap-1.5 rounded-[10px] bg-green-soft px-3 text-[13px] font-semibold text-green-ink">
                    <Icon d={PATHS.check} size={14} sw={2.6} />
                    Done
                  </span>
                )}
              </div>
              <div className="mt-3.5 grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr) minmax(0,1fr)' }}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !raw.due && !ro && focusField('tk-due')}
                  onKeyDown={keyOpen(() => !raw.due && !ro && focusField('tk-due'))}
                  className={ro ? factBase : fact}
                >
                  <Label>Due</Label>
                  <span className="truncate text-[16px] font-bold" style={{ color: late ? '#C0392B' : '#1B2D45' }}>
                    {raw.due ? fmt(raw.due) : 'Not set'}
                  </span>
                  <span
                    className="inline-flex h-[22px] items-center self-start rounded-md px-[9px] text-[12px] font-bold"
                    style={{
                      background: late ? '#F6DDD0' : raw.due ? '#DCE5FA' : '#E7EEFB',
                      color: late ? '#7A3818' : raw.due ? '#1F3FAF' : '#3B4A5E',
                    }}
                  >
                    {raw.due && d != null ? (late ? -d + 'd overdue' : d === 0 ? 'Today' : 'in ' + d + 'd') : 'Add date'}
                  </span>
                </div>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => !ro && focusField('tk-log')}
                  onKeyDown={keyOpen(() => !ro && focusField('tk-log'))}
                  className={ro ? factBase : fact}
                >
                  <div className="flex items-center gap-2">
                    <Label>Time</Label>
                    <span className="ml-auto inline-flex h-[22px] items-center gap-[5px] rounded-md bg-sky-2 px-2 text-[12px] font-bold text-blue-ink">
                      <Icon d={PATHS.plus} size={10} sw={3.2} />
                      Log
                    </span>
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1.5">
                    <span className="text-[16px] font-bold" style={{ color: estOver ? '#A5502C' : '#1B2D45' }}>
                      {logged ? rh(logged) : '0h'}
                    </span>
                    <span className="whitespace-nowrap text-[13px] font-semibold text-muted">{estN ? 'of ' + estN + 'h estimate' : 'no estimate'}</span>
                  </div>
                  <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-sky-2">
                    <span
                      className="h-full rounded-[3px]"
                      style={{ width: (estN ? Math.min(100, Math.round((logged / estN) * 100)) : logged ? 100 : 0) + '%', background: estOver ? '#D2724A' : '#3F9079' }}
                    />
                  </div>
                  <span className="truncate text-[12px] font-semibold" style={{ color: estOver ? '#A5502C' : '#3B4A5E' }}>
                    {estOver ? rh(logged - estN) + ' over estimate' : estN ? rh(estN - logged) + ' left' : 'Set an estimate'}
                  </span>
                </div>
                <div className={factBase + ' relative !cursor-default'}>
                  <Label>{A.length > 1 ? 'Assignees' : 'Assignee'}</Label>
                  <div onClick={editAssignees} title="Edit assignees" className="flex min-h-7 cursor-pointer items-center">
                    {people4.map(a => (
                      <Avatar key={a.name} title={a.name} i={a.i} bg={a.bg} color={a.color} size={28} radius={7} font={11} className="!font-bold" ring={`0 0 0 2px #fff,${a.ring}`} style={{ marginRight: -6 }} />
                    ))}
                    {A.length > 4 && (
                      <span className="grid size-7 place-items-center rounded-[7px] bg-sky-2 text-[11px] font-bold text-blue-ink shadow-[0_0_0_2px_#fff]">+{A.length - 4}</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setAsAll(!asAll)
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 self-start border-0 bg-transparent p-0 text-[12px] font-bold text-blue-ink"
                  >
                    View all
                    <Icon d={PATHS.chevron} size={11} sw={2.8} style={{ transform: `rotate(${asAll ? 180 : 0}deg)` }} />
                  </button>
                  {asAll && (
                    <>
                      <Scrim onClick={() => setAsAll(false)} z={58} />
                      <div className="absolute right-0 top-[calc(100%+6px)] z-[59] w-[250px] rounded-[14px] bg-white p-1.5 shadow-[0_14px_40px_rgba(27,45,69,0.18),0_0_0_1.5px_#C9D2DD]">
                        <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">People on this ticket</div>
                        {peopleAll.map(p => (
                          <div key={p.name + p.role} className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] hover:bg-sky">
                            <Avatar i={p.i} bg={p.bg} size={28} radius={7} font={11} className="!font-bold" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13.5px] font-semibold text-ink">{p.name}</span>
                              <span className="block text-[11.5px] font-semibold text-muted">{p.role}</span>
                            </span>
                          </div>
                        ))}
                        <button type="button" onClick={editAssignees} className="mt-1 h-8 w-full cursor-pointer rounded-lg border-0 bg-sky text-[12.5px] font-bold text-blue-ink">
                          Edit assignees
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-[18px] flex gap-6 shadow-[inset_0_-1.5px_0_#C9D2DD]">
              {dTabs
                .filter(([t]) => !(isSub && t === 'subs'))
                .map(([t, label, n]) => (
                  <TabButton key={t} on={tab === t} onClick={() => setTab(t)}>
                    {label}
                    <CountPill n={n} />
                  </TabButton>
                ))}
            </div>
          </div>

          <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-8 pb-8 pt-6">
            {tab === 'details' && (
              <div className="-mt-[18px] flex flex-col">
                <div className="grid py-[18px]" style={{ gridTemplateColumns: rowCols, gap: rowGap }}>
                  <div className="pt-0.5 text-[13px] font-semibold text-ink-2">Description</div>
                  <div className="min-w-0">
                    {descEdit ? (
                      <DescriptionEditor
                        initial={raw.desc}
                        onCancel={() => setDescEdit(false)}
                        onSave={v => {
                          if (v !== raw.desc) upd({ desc: v }, 'updated the description')
                          setDescEdit(false)
                        }}
                        onImage={f => upd({ atts: [...raw.atts, { name: f.name, size: Math.max(1, Math.round(f.size / 1e3)) + ' KB', date: fmt(TODAY) }] }, 'added an attachment')}
                      />
                    ) : (
                      <div className="flex items-start gap-4">
                        <div
                          onClick={() => !ro && setDescEdit(true)}
                          className="-mx-2.5 -my-1.5 min-w-0 flex-1 cursor-text whitespace-pre-wrap [overflow-wrap:anywhere] rounded-[10px] px-2.5 py-1.5 text-[14.5px] leading-[1.65] [text-wrap:pretty] hover:bg-canvas"
                          style={{ color: raw.desc ? '#1B2D45' : '#3B4A5E' }}
                        >
                          {raw.desc ? <Markdown src={raw.desc} /> : 'No description yet. Add what should happen and why.'}
                        </div>
                        {!ro && (
                          <button type="button" onClick={() => setDescEdit(true)} className="cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[13px] font-semibold text-blue-ink">
                            Edit
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {!isSub && (
                  <div
                    onClick={() => setTab('subs')}
                    className="-mx-3 grid cursor-pointer rounded-xl border-t-[1.5px] border-line px-3 py-[18px] hover:bg-canvas"
                    style={{ gridTemplateColumns: rowCols, gap: rowGap }}
                  >
                    <div className="pt-0.5 text-[13px] font-semibold text-ink-2">Subtasks</div>
                    <div className="flex min-w-0 items-center gap-3.5">
                      <span className="whitespace-nowrap text-[14.5px] font-semibold text-ink">
                        {raw.subs.length ? sdn + ' of ' + raw.subs.length + ' done' : 'No subtasks yet'}
                      </span>
                      {raw.subs.length > 0 && (
                        <span className="h-[5px] max-w-[200px] flex-1 overflow-hidden rounded-[3px] bg-sky-2">
                          <span className="block h-full rounded-[3px] bg-green" style={{ width: subPct }} />
                        </span>
                      )}
                      <span className="ml-auto inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-semibold text-blue-ink">
                        {raw.subs.length || ro ? 'Open' : 'Add subtasks'}
                        <Icon d={PATHS.next} size={13} sw={2.6} />
                      </span>
                    </div>
                  </div>
                )}
                <div className="grid border-t-[1.5px] border-line py-[18px]" style={{ gridTemplateColumns: rowCols, gap: rowGap }}>
                  <div className="pt-0.5 text-[13px] font-semibold text-ink-2">Attachments</div>
                  <div className="flex min-w-0 flex-col gap-2.5">
                    <div className="flex flex-wrap gap-2">
                      {raw.atts.map((a, i) => (
                        <div key={a.name + i} className="flex max-w-[260px] items-center gap-2.5 rounded-[10px] border-[1.5px] border-line bg-white py-[7px] pl-[7px] pr-3">
                          <span className="tnum grid size-8 flex-none place-items-center rounded-lg bg-sky-2 text-[9.5px] font-semibold text-blue-ink">{fileExt(a.name, 99)}</span>
                          <span className="min-w-0">
                            <span className="block truncate text-[13px] font-semibold">{a.name}</span>
                            <span className="mt-px block text-[12px] text-ink-2">{a.size} · {a.date}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                    {!ro && <label
                      onDragOver={(e: DragEvent) => {
                        e.preventDefault()
                        if (!dropOn) setDropOn(true)
                      }}
                      onDragLeave={() => setDropOn(false)}
                      onDrop={(e: DragEvent) => {
                        e.preventDefault()
                        setDropOn(false)
                        addFiles([...(e.dataTransfer?.files || [])])
                      }}
                      className="flex min-h-[76px] cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-[1.5px] border-dashed p-3 text-center text-ink-2 transition-[background,border-color] hover:!border-blue hover:!bg-canvas"
                      style={{ borderColor: dropOn ? '#4870E8' : '#A9B6C5', background: dropOn ? '#E7EEFB' : '#FFFFFF' }}
                    >
                      <Icon d={PATHS.upload} size={18} sw={2.2} stroke="#4870E8" />
                      <span className="text-[13.5px] font-semibold text-ink">{dropOn ? 'Drop to attach' : 'Drag and drop files here'}</span>
                      <span className="text-[12px] font-medium text-muted">
                        or <span className="font-semibold text-blue-ink">click to browse</span> · any file type
                      </span>
                      <input
                        type="file"
                        multiple
                        className="hidden"
                        onChange={e => {
                          addFiles([...(e.target.files || [])])
                          e.target.value = ''
                        }}
                      />
                    </label>}
                  </div>
                </div>
                <div className="grid border-t-[1.5px] border-line py-[18px]" style={{ gridTemplateColumns: rowCols, gap: rowGap }}>
                  <div className="pt-0.5 text-[13px] font-semibold text-ink-2">Blocked by</div>
                  <div className="flex min-w-0 flex-col gap-1">
                    {raw.deps.map(depId => {
                      const o = tasks.find(x => x.id === depId)
                      if (!o) return null
                      const os = statusOf(ws.statuses, o.status)
                      return (
                        <div key={depId} className="-mx-2.5 flex items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 hover:bg-canvas">
                          <span className="tnum flex-none text-[12px] text-ink-2">{taskKey(o)}</span>
                          <span className="min-w-0 flex-1 truncate text-[14px]">{o.title}</span>
                          <StatusPill name={os.name} c={os.c} soft={os.soft} ink={os.ink} />
                          {!ro && <button
                            type="button"
                            onClick={() => upd({ deps: raw.deps.filter(x => x !== depId) }, 'unlinked ' + taskKey(o))}
                            title="Unlink"
                            className="cursor-pointer border-0 bg-transparent text-[16px] text-faint hover:text-rust"
                          >
                            ×
                          </button>}
                        </div>
                      )
                    })}
                    <div className="flex items-center gap-4">
                      {!raw.deps.length && <span className="text-[14.5px] text-ink-2">Nothing</span>}
                      {!ro && <span className="relative ml-auto inline-flex items-center">
                        <span className="pointer-events-none whitespace-nowrap text-[13px] font-semibold text-blue-ink">+ Link task</span>
                        <select
                          value=""
                          onChange={e => {
                            const v = +e.target.value
                            if (v) upd({ deps: [...raw.deps, v] }, 'linked PMT-' + v + ' as a blocker')
                          }}
                          className="absolute inset-0 w-full cursor-pointer opacity-0"
                        >
                          <option value="">Link task…</option>
                          {tasks
                            .filter(x => !x.parent && x.id !== id && !raw.deps.includes(x.id))
                            .map(x => (
                              <option key={x.id} value={x.id}>
                                {taskKey(x)} · {x.title}
                              </option>
                            ))}
                        </select>
                      </span>}
                    </div>
                  </div>
                </div>
                {isSub && (
                  // The prototype's 16px flex gap plus a 6px margin: 22px below "Blocked by".
                  <div className="mt-[22px] border-t-[1.5px] border-line pt-[18px]">
                    <div className="mb-3 flex items-center gap-2">
                      <span className="text-[15px] font-bold text-ink">Comments</span>
                      <span className="tnum text-[12px] text-ink-2">{comments.length}</span>
                    </div>
                    {!ro && <CommentBox value={cDraft} onChange={setCDraft} onPost={post} />}
                    <div className="mt-1.5 flex flex-col">
                      {comments.map((a, i) => {
                        const m = person(a.who)
                        return (
                          <div key={i} className="flex gap-3 border-b-[1.5px] border-line-3 py-3">
                            <Avatar i={m.i} bg={m.bg} size={28} radius={6} font={10.5} />
                            <div className="min-w-0 flex-1">
                              <div className="text-[13.5px] text-ink-2">
                                <b className="font-bold text-ink">{a.who}</b> <span className="text-muted">· {a.when}</span>
                              </div>
                              <div className="mt-1.5 whitespace-pre-wrap rounded-xl border-[1.5px] border-line bg-canvas px-3 py-2.5 text-[14px] leading-normal [overflow-wrap:anywhere]">{a.text}</div>
                            </div>
                          </div>
                        )
                      })}
                      {!comments.length && <div className="py-3 text-[13.5px] text-muted">No comments yet.</div>}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tab === 'subs' && !isSub && (
              <>
                <div className="flex items-center gap-3">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-[3px] bg-sky-2">
                    <div className="h-full rounded-[3px] bg-green" style={{ width: subPct }} />
                  </div>
                  <span className="tnum text-[12px] text-ink-2">{sdn}/{raw.subs.length} done</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {raw.subs.map((x, i) => (
                    <SubtaskRow key={i} parent={raw} x={x} i={i} tasks={tasks} onOpen={() => openSub(raw0, i)} onToggle={() => toggleSub(i)} />
                  ))}
                </div>
                {!ro && <div className="flex gap-2">
                  <input
                    value={subDraft}
                    onChange={e => setSubDraft(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addSub()}
                    placeholder="Add a subtask and press Enter"
                    className="h-10 w-full flex-1 rounded-[10px] border-[1.5px] border-line bg-canvas px-2.5 text-[13.5px] text-ink outline-0"
                  />
                  <button
                    type="button"
                    onClick={addSub}
                    className="h-10 cursor-pointer rounded-[10px] border-0 bg-blue px-4 text-[13.5px] font-semibold text-white"
                    style={{ opacity: subDraft.trim() ? 1 : 0.45 }}
                  >
                    Add
                  </button>
                </div>}
              </>
            )}

            {tab === 'chat' && raw.clientBug && <ClientChat bug={raw} />}

            {tab === 'act' && (
              <>
                <div className="rounded-[14px] border-[1.5px] border-line bg-canvas p-1">
                  {!ro && <textarea
                    value={cDraft}
                    onChange={e => setCDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        post()
                      }
                    }}
                    rows={2}
                    placeholder="Write a comment, @mention someone…"
                    className="w-full resize-y border-0 bg-transparent px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
                  />}
                  <div className={`flex items-center gap-1 px-1.5 ${ro ? 'py-1.5' : 'pb-1.5'}`}>
                    {(
                      [
                        ['all', 'All'],
                        ['comments', 'Comments'],
                        ['history', 'History'],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setActTab(k)}
                        className="h-[26px] cursor-pointer rounded-full border-0 px-2.5 text-[12.5px] font-semibold"
                        style={{ background: actTab === k ? '#FFFFFF' : 'transparent', color: actTab === k ? '#1B2D45' : '#1F3FAF' }}
                      >
                        {label}
                      </button>
                    ))}
                    {!ro && <button
                      type="button"
                      onClick={post}
                      className="ml-auto h-[30px] cursor-pointer rounded-lg border-0 bg-blue px-3.5 text-[13px] font-semibold text-white"
                      style={{ opacity: cDraft.trim() ? 1 : 0.45 }}
                    >
                      Comment
                    </button>}
                  </div>
                </div>
                <div className="flex flex-col">
                  {acts.map((a, i) => {
                    const m = person(a.who)
                    return (
                      <div key={i} className="flex gap-3 border-b-[1.5px] border-line py-3">
                        <Avatar i={m.i} bg={m.bg} size={28} radius={6} font={10.5} />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13.5px] leading-[1.45] text-ink-2 [overflow-wrap:anywhere]">
                            <b className="font-semibold text-ink">{a.who}</b> {a.kind === 'comment' ? 'commented' : a.what} <span>· {a.when}</span>
                          </div>
                          {a.kind === 'comment' && (
                            <div className="mt-1.5 whitespace-pre-wrap rounded-xl border-[1.5px] border-line bg-canvas px-3 py-2.5 text-[14px] leading-normal [overflow-wrap:anywhere]">{a.text}</div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  {!acts.length && <div className="py-3.5 text-[13px] text-ink-2">Nothing here yet.</div>}
                </div>
              </>
            )}
          </div>
        </div>

        {/* Details sidebar */}
        <div className="flex-[0_0_308px] overflow-y-auto border-l-[1.5px] border-line bg-canvas px-[18px] pb-7 pt-16">
          <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">{isSub ? 'Subtask details' : 'Details'}</div>
          <div className="rounded-[14px] bg-white shadow-[0_0_0_1px_#C9D2DD,0_1px_2px_rgba(27,45,69,0.04)]">
            {rows.map((r, i) => (
              <div key={r.k} className="flex min-h-[46px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3" style={{ borderTop: i ? '1.5px solid #C9D2DD' : 'none' }}>
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-2">{r.label}</span>
                <PillDropdown
                  label={r.label}
                  value={r.value}
                  color={r.c}
                  bg={r.bg}
                  avatar={r.avatar}
                  open={tdd === 'd_' + r.k}
                  onToggle={() => setTdd(tdd === 'd_' + r.k ? null : 'd_' + r.k)}
                  onClose={() => setTdd(null)}
                  options={r.options}
                  up={i >= 4}
                  disabled={ro}
                />
              </div>
            ))}
            {par && (
              <div className="flex min-h-[46px] items-center justify-between gap-2.5 border-t-[1.5px] border-line py-2 pl-3.5 pr-3">
                <span className="text-[13px] text-ink-2">Parent</span>
                <button
                  type="button"
                  onClick={railBack}
                  title={par.title}
                  className="flex max-w-[170px] cursor-pointer items-center gap-1.5 rounded-md border-0 bg-sky-2 px-2.5 py-[5px] text-[12px] font-semibold text-blue-ink shadow-[inset_0_0_0_1.5px_rgba(27,45,69,0.14)] hover:shadow-[0_0_0_1.5px_#4870E8]"
                >
                  <span className="tnum flex-none">{taskKey(par)}</span>
                  <span className="min-w-0 truncate text-ink">{par.title}</span>
                </button>
              </div>
            )}
            <div className="flex min-h-[46px] items-center justify-between gap-2.5 border-t-[1.5px] border-line py-2 pl-3.5 pr-3">
              <span className="text-[13px] text-ink-2">Contributors</span>
              <div className="relative flex-none">
                <button
                  type="button"
                  onClick={() => setTdd(tdd === 'd_contrib' ? null : 'd_contrib')}
                  disabled={ro}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border-0 bg-sky px-1.5 py-1 text-[12px] font-semibold text-ink hover:!shadow-[0_0_0_1.5px_#4870E8]"
                  style={{ boxShadow: tdd === 'd_contrib' ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1.5px rgba(27,45,69,0.14)' }}
                >
                  <span className="flex">
                    {raw.contribs.map(n => {
                      const m = person(n)
                      return <Avatar key={n} title={n} i={m.i} bg={m.bg} size={20} radius={5} font={8.5} ring="0 0 0 2px #EEF3FB" style={{ marginRight: -5 }} />
                    })}
                  </span>
                  <span className="whitespace-nowrap" style={{ paddingLeft: raw.contribs.length ? 4 : 2 }}>
                    {raw.contribs.length ? (raw.contribs.length === 1 ? raw.contribs[0].split(' ')[0] : raw.contribs.length + ' people') : 'Add people'}
                  </span>
                  <Caret />
                </button>
                {tdd === 'd_contrib' && (
                  <>
                    <Scrim onClick={() => setTdd(null)} z={50} />
                    <div className="absolute bottom-[calc(100%+6px)] right-0 z-[51] w-[250px] rounded-[14px] bg-white/[.97] p-1.5 text-left shadow-[0_14px_40px_rgba(27,45,69,0.16),0_0_0_1px_rgba(27,45,69,0.12)] backdrop-blur-[20px]">
                      <div className="flex items-center px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">
                        Contributors
                        <span className="ml-auto font-medium normal-case tracking-normal text-muted">{raw.contribs.length} selected</span>
                      </div>
                      {people.map(n => {
                        const on = raw.contribs.includes(n)
                        const isA = n === raw.assignee
                        const m = person(n)
                        return (
                          <button
                            key={n}
                            type="button"
                            onClick={() => {
                              if (isA) return
                              upd(
                                { contribs: on ? raw.contribs.filter(x => x !== n) : [...raw.contribs, n] },
                                on ? 'removed ' + n + ' as contributor' : 'added ' + n + ' as contributor',
                              )
                            }}
                            className="flex w-full items-center gap-2.5 rounded-lg border-0 px-2.5 py-[7px] text-left text-[13px] text-ink hover:!bg-sky-2"
                            style={{ background: on ? '#EEF3FB' : 'transparent', fontWeight: on ? 600 : 500, opacity: isA ? 0.6 : 1, cursor: isA ? 'default' : 'pointer' }}
                          >
                            <Avatar i={m.i} bg={m.bg} size={24} radius={6} font={9.5} />
                            <span className="min-w-0 flex-1 truncate">
                              {n}
                              <span className="block text-[11.5px] font-medium text-muted">{isA ? 'Assignee' : on ? 'Contributor' : ''}</span>
                            </span>
                            <span
                              className="grid size-[18px] flex-none place-items-center rounded-[5px] border-[1.5px] text-[11px] text-white"
                              style={{ borderColor: on ? '#4870E8' : '#A9B6C5', background: on ? '#4870E8' : isA ? '#C9D2DD' : '#FFFFFF' }}
                            >
                              {on || isA ? '✓' : ''}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="px-1 pb-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">Dates</div>
          <div className="rounded-[14px] bg-white px-3.5 pb-3.5 pt-4 shadow-[0_0_0_1px_#C9D2DD,0_1px_2px_rgba(27,45,69,0.04)]">
            <div className="text-[12px] text-ink-2">Due date</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2" style={{ color: late ? '#A5502C' : raw.due ? '#1B2D45' : '#3B4A5E' }}>
              <span className="text-[24px] font-bold tracking-[-0.02em]">{raw.due ? fmt(raw.due) : 'No due date'}</span>
              <span className="text-[12px] font-semibold">
                {d == null ? '' : d === 0 ? 'Due today' : d > 0 ? 'In ' + d + ' day' + (d > 1 ? 's' : '') : -d + ' day' + (d < -1 ? 's' : '') + ' overdue'}
              </span>
            </div>
          </div>
          <div className="mt-2.5 rounded-[14px] bg-white shadow-[0_0_0_1px_#C9D2DD,0_1px_2px_rgba(27,45,69,0.04)]">
            <div className={sideRow}>
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Start</div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">
                  {raw.start ? (x => (x === 0 ? 'Today' : x > 0 ? 'in ' + x + ' days' : -x + ' days ago'))(diff(raw.start, TODAY)) : 'Not set'}
                </div>
              </div>
              <input
                type="date"
                value={raw.start || ''}
                disabled={ro}
                onChange={e => upd({ start: e.target.value }, e.target.value ? 'set start date to ' + fmt(e.target.value) : 'cleared the start date')}
                className={`${tnumSm} border-0 bg-transparent text-right outline-0`}
              />
            </div>
            <div className={sideRow + ' border-t-[1.5px] border-line'}>
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Due</div>
                <div className="mt-px text-[11.5px] font-semibold" style={{ color: late ? '#A5502C' : '#3B4A5E' }}>
                  {raw.due && d != null ? 'Fixed · ' + (late ? -d + ' day' + (d < -1 ? 's' : '') + ' overdue' : d === 0 ? 'Today' : 'in ' + d + ' day' + (d > 1 ? 's' : '')) : 'Not set'}
                </div>
              </div>
              {raw.due ? (
                <Locked>{fmt(raw.due)}</Locked>
              ) : (
                <input
                  id="tk-due"
                  type="date"
                  disabled={ro}
                  value=""
                  onChange={e => e.target.value && upd({ due: e.target.value }, 'set due date to ' + fmt(e.target.value))}
                  className={`${tnumSm} border-0 bg-transparent text-right outline-0`}
                />
              )}
            </div>
            <div className={sideRow + ' border-t-[1.5px] border-line'}>
              <div className="min-w-0 text-[13px] text-ink-2">Estimate</div>
              {raw.est ? (
                <Locked>{String(raw.est).replace(/h$/, '') + 'h'}</Locked>
              ) : (
                <input
                  id="tk-est"
                  disabled={ro}
                  value={estDraft}
                  onChange={e => setEstDraft(e.target.value)}
                  onBlur={() => {
                    const v = estDraft.trim()
                    if (v !== raw.est) upd({ est: v }, v ? 'set estimate to ' + v : 'cleared the estimate')
                  }}
                  placeholder="e.g. 4h"
                  className={`${tnumSm} w-[90px] border-0 bg-transparent text-right outline-0`}
                />
              )}
            </div>
            <div className={sideRow + ' border-t-[1.5px] border-line'}>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  Hours
                  {!ro && <button
                    type="button"
                    onClick={() => focusField('tk-log')}
                    title="Log hours"
                    aria-label="Log hours"
                    className="inline-grid size-[18px] cursor-pointer place-items-center rounded-[5px] border-0 bg-blue p-0 align-middle text-white"
                  >
                    <Icon d={PATHS.plus} size={10} sw={3.2} />
                  </button>}
                </div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">{nEnt ? nEnt + ' entr' + (nEnt > 1 ? 'ies' : 'y') : 'Nothing logged yet'}</div>
              </div>
              <span className="tnum text-[13px] font-semibold" style={{ color: estOver ? '#A5502C' : '#1B2D45' }}>
                {logged ? rh(logged) : '0h'}
              </span>
            </div>
            {!ro && <div data-fx="1" className="flex items-center gap-2 rounded-b-[14px] border-t-[1.5px] border-line bg-canvas px-3.5 py-2.5">
              <span className="flex-1 text-[13px] font-semibold text-ink">Log time</span>
              <MiniSelect id="tk-log" value={logHr} onChange={setLogHr} options={Array.from({ length: 25 }, (_, i) => [i, i + 'h'])} />
              <MiniSelect value={logMin} onChange={setLogMin} options={[0, 5, 10, 15, 30, 45].map(m => [m, m + 'm'])} />
              <button
                type="button"
                onClick={() => {
                  const v = Math.round((logHr + logMin / 60) * 100) / 100
                  if (!v) return
                  const tm = { ...(raw.time || {}) }
                  tm[TODAY] = (tm[TODAY] || 0) + v
                  const lbl = ((logHr ? logHr + 'h' : '') + (logMin ? ' ' + logMin + 'm' : '')).trim()
                  upd({ time: tm }, 'logged ' + lbl)
                  setLogHr(0)
                  setLogMin(0)
                }}
                className="h-8 cursor-pointer rounded-lg border-0 bg-blue px-3 text-[12.5px] font-bold text-white"
              >
                Add
              </button>
            </div>}
          </div>
          {created?.who && (
            <div className="px-1 pt-3.5 text-[12px] text-ink-2">
              Created by {created.who} · {created.when}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}

function TypeIcon({ type }: { type: Task['type'] }) {
  if (type === 'Bug')
    return (
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#D2724A" strokeWidth="2.2" strokeLinecap="round">
        <rect x="7" y="7" width="10" height="13" rx="5" />
        <path d="M9 7l-2-3M15 7l2-3M3 12h4M17 12h4M4 18l3-2M20 18l-3-2" />
      </svg>
    )
  if (type === 'Story')
    return (
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#3F9079" strokeWidth="2.4" strokeLinejoin="round">
        <path d="M6 3h12v18l-6-4-6 4z" />
      </svg>
    )
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#4870E8" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M8 12l3 3 5-6" />
    </svg>
  )
}

export function StatusPill({ name, c, soft, ink, small = false }: { name: string; c: string; soft: string; ink: string; small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full pl-[7px] pr-[9px] text-[12px] font-semibold ${small ? 'h-[22px]' : 'py-0.5'}`}
      style={{ background: soft, color: ink }}
    >
      <span className="size-1.5 rounded-full" style={{ background: c }} />
      {name}
    </span>
  )
}

function Locked({ children }: { children: string }) {
  return (
    <span className="tnum inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink">
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#3B4A5E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d={PATHS.lock} />
      </svg>
      {children}
    </span>
  )
}

function MiniSelect({ id, value, onChange, options }: { id?: string; value: number; onChange: (v: number) => void; options: (string | number)[][] }) {
  return (
    <span className="relative inline-flex">
      <select
        id={id}
        value={value}
        onChange={e => onChange(+e.target.value)}
        className="tnum h-8 cursor-pointer appearance-none rounded-lg border-[1.5px] border-line bg-white pl-[9px] pr-[22px] text-[13px] font-semibold text-ink outline-0"
      >
        {options.map(([v, label]) => (
          <option key={v} value={v}>
            {label}
          </option>
        ))}
      </select>
      <Icon d={PATHS.chevron} size={10} sw={2.8} className="pointer-events-none absolute right-[7px] top-1/2 -translate-y-1/2 text-ink-2" />
    </span>
  )
}

function CommentBox({ value, onChange, onPost }: { value: string; onChange: (v: string) => void; onPost: () => void }) {
  return (
    <div className="rounded-[14px] border-[1.5px] border-line bg-canvas p-1">
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onPost()
          }
        }}
        rows={2}
        placeholder="Write a comment, @mention someone…"
        className="w-full resize-y border-0 bg-transparent px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
      />
      <div className="flex items-center px-1.5 pb-1.5">
        <span className="text-[12px] font-medium text-ink-2">Enter posts · Shift+Enter new line</span>
        <button
          type="button"
          onClick={onPost}
          className="ml-auto h-8 cursor-pointer rounded-lg border-0 bg-blue px-3.5 text-[13px] font-semibold text-white"
          style={{ opacity: value.trim() ? 1 : 0.45 }}
        >
          Comment
        </button>
      </div>
    </div>
  )
}

function SubtaskRow({
  parent,
  x,
  i,
  tasks,
  onOpen,
  onToggle,
}: {
  parent: Task
  x: Subtask
  i: number
  tasks: Task[]
  onOpen: () => void
  onToggle: () => void
}) {
  const ws = useScopedWorkspace()!
  const entries = useEntries().data ?? []
  const { person } = usePage()
  const rec = x.sid ? tasks.find(y => y.id === x.sid) : undefined
  const an = rec?.assignee || x.assignee || ''
  const due = rec?.due || x.due || ''
  const dd = due ? diff(due, TODAY) : null
  const pr = rec?.prio || parent.prio || 'Low'
  const pc = PRIO[pr] || PRIO.Low
  const st = statusOf(ws.statuses, rec ? rec.status : x.done ? 'done' : ws.statuses[0].id)
  const lg = rec ? loggedHours(rec, entries) : 0
  const en = rec ? parseFloat(rec.est) || 0 : 0
  const a = an ? { ...person(an), color: '#fff', ring: 'none' } : unassigned
  const chip = 'tnum inline-flex h-[22px] items-center gap-[5px] rounded-full border-[1.5px] border-line bg-canvas px-[9px] text-[11.5px]'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={e => {
        // Only the row itself: Enter or Space on the nested done toggle is left to that button.
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
      className="grid cursor-pointer items-center gap-3 rounded-xl border-[1.5px] border-line bg-white px-3.5 py-3 hover:border-blue focus-visible:border-blue"
      style={{ gridTemplateColumns: '22px minmax(0,1fr) auto' }}
    >
      <button
        type="button"
        onClick={e => {
          e.stopPropagation()
          onToggle()
        }}
        className="grid size-5 cursor-pointer place-items-center rounded-full border-[1.5px] p-0 text-[11px] text-white"
        style={{ borderColor: x.done ? '#3F9079' : '#A9B6C5', background: x.done ? '#3F9079' : '#FFFFFF' }}
      >
        {x.done ? '✓' : ''}
      </button>
      <div className="min-w-0">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="tnum flex-none text-[11.5px] text-muted">
            {taskKey(parent)}.{i + 1}
          </span>
          <span
            className="min-w-0 truncate text-[14.5px] font-semibold"
            style={{ color: x.done ? '#3B4A5E' : '#1B2D45', textDecoration: x.done ? 'line-through' : 'none' }}
          >
            {x.t}
          </span>
        </div>
        <div className="mt-[7px] flex flex-wrap items-center gap-1.5">
          <StatusPill name={st.name} c={st.c} soft={st.soft} ink={st.ink} small />
          <span className="inline-flex h-[22px] items-center rounded-full px-[9px] text-[12px] font-semibold" style={{ background: pc[1], color: pc[0] }}>
            {pr}
          </span>
          <span className={chip} style={{ color: dd != null && dd < 0 && !x.done ? '#C0392B' : '#22354C' }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <rect x="3" y="5" width="18" height="16" rx="2" />
              <path d={PATHS.calendar} />
            </svg>
            {due ? (dd != null && dd < 0 && !x.done ? -dd + 'd late' : short(due)) : 'No due date'}
          </span>
          <span className={chip} style={{ color: en && lg > en ? '#A5502C' : '#22354C' }}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            {en ? rh(lg) + ' / ' + en + 'h' : lg ? rh(lg) + ' logged' : 'No estimate'}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2.5">
        <span className="flex max-w-[170px] items-center gap-2">
          <Avatar i={a.i} bg={a.bg} color={a.color} ring={a.ring} size={28} radius={6} font={10.5} />
          <span className="truncate text-[13px] font-semibold" style={{ color: an ? '#1B2D45' : '#3B4A5E' }}>
            {an || 'Unassigned'}
          </span>
        </span>
        <span className="grid size-[30px] flex-none place-items-center rounded-lg bg-sky text-blue-ink">
          <Icon d={PATHS.next} size={14} sw={2.6} />
        </span>
      </div>
    </div>
  )
}
