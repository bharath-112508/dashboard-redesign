import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { Attachment, ChatFile, ChatMessage, ClientPriority, Question, Task, TaskId } from '../../api/types'
import { Avatar, CloseButton, Icon, Label, PATHS } from '../../components/ui'
import { diff, fmt, todayLabel, TODAY } from '../../lib/dates'
import { isImageName, readFiles } from '../../lib/files'
import { questionTags } from '../../lib/theme'
import { initials } from '../../lib/media'
import { usePage } from '../../state/page'
import { useOverlay } from '../../state/ui'
import { useActorName, useActorSend, useScopedQuestions, useScopedTasks, useScopedWorkspace } from '../../state/access'
import { statusOf, taskKey, fileExt } from '../../domain/tasks'
import { answerShownFirst, clientQuestionState, threadOf } from '../../domain/questions'
import { EscapeHoldContext, useEscapeHold, type EscapeHold } from './escapeHold'


const PRIO_COLORS: Record<ClientPriority, [string, string]> = {
  Low: ['#22354C', '#E7EEFB'],
  Medium: ['#1F3FAF', '#DCE5FA'],
  High: ['#7A5C0E', '#FBEDC2'],
  Critical: ['#FFFFFF', '#C0392B'],
}

interface Model {
  kind: string
  kIc: string
  kBg: string
  kSoft: string
  kC: string
  qkey: string
  tags: { t: string; bg: string; c: string }[]
  title: string
  by: { name: string; i: string; bg: string }
  when: string
  status: { label: string; color: string; dot?: string }
  /** Status pill next to the key (team side). */
  pill?: { label: string; bg: string; c: string }
  /** "Mark as solved" toggle (team side). */
  solve?: { solved: boolean; toggle: () => void }
  photos: ChatFile[]
  thread: ChatMessage[]
  chatSub: string
  placeholder: string
  waiting: boolean
  waitLbl: string
  teamWait: boolean
  send: (m: ChatMessage) => void
  /** Edit of the viewer's own messages. Absent when the thread is read-only. */
  edit?: { canEdit: (c: ChatMessage, i: number) => boolean; save: (i: number, text: string) => void }
}

/** A question from the team, or a bug the client reported: the item on the left, the chat on the right. */
export function ConversationModal({ bugId, questionId }: { bugId?: TaskId; questionId?: number }) {
  const tasks = useScopedTasks() ?? []
  const questions = useScopedQuestions() ?? []
  const overlay = useOverlay()
  const close = () => overlay.close('bug', 'question')

  // Escape closes the window only when no edit is open in it (see escapeHold.ts).
  const holds = useRef(new Set<string>())
  const hold = useCallback<EscapeHold>((id, on) => {
    if (on) holds.current.add(id)
    else holds.current.delete(id)
  }, [])
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && holds.current.size === 0) close()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  const bug = bugId != null ? tasks.find(t => t.id === bugId && t.clientBug) : undefined
  const q = questionId != null ? questions.find(x => x.id === questionId) : undefined
  let body: ReactNode = null
  if (bug) body = <BugConversation bug={bug} close={close} />
  else if (q) body = <QuestionConversation q={q} close={close} />
  return <EscapeHoldContext.Provider value={hold}>{body}</EscapeHoldContext.Provider>
}

function QuestionConversation({ q, close }: { q: Question; close: () => void }) {
  const send = useActorSend()
  const me = useActorName()
  const { side, person } = usePage()
  const team = side === 'team'
  const st = clientQuestionState(q)
  const T = threadOf(q)
  const last = T[T.length - 1]
  const answered = T.some(c => c.side === 'client')
  // The team sees Waiting / Answered / Solved; the client sees what they need to do.
  const tst = q.solved ? 'Solved' : answered ? 'Answered' : 'Waiting'
  const TST: Record<string, [string, string, string, string]> = {
    Solved: ['#3F9079', '#FFFFFF', '#195040', '#3F9079'],
    Answered: ['#D6E9E2', '#195040', '#195040', '#3F9079'],
    Waiting: ['#FBEDC2', '#7A5C0E', '#7A5C0E', '#B98A2F'],
  }
  const [pBg, pC, sTx, sDot] = TST[tst]
  const m: Model = {
    kind: 'Question to client',
    kIc: '?',
    kBg: '#6E58C9',
    kSoft: '#F3F0FC',
    kC: '#3F2E94',
    qkey: 'Q-' + q.id,
    tags: questionTags(q),
    title: q.title || (q.text.length > 60 ? q.text.slice(0, 60).replace(/\s+\S*$/, '') + '…' : q.text),
    by: person(q.by),
    when: q.when,
    status: team ? { label: tst, color: sTx, dot: sDot } : { label: st.label, color: st.boxC },
    pill: team ? { label: tst, bg: pBg, c: pC } : undefined,
    solve: {
      solved: !!q.solved,
      toggle: () =>
        send({
          type: 'batch',
          cmds: [
            { type: 'question.update', id: q.id, patch: { solved: !q.solved } },
            {
              type: 'question.message',
              id: q.id,
              message: { who: me, side, text: q.solved ? 'Reopened the question' : 'Marked as solved', when: 'just now', files: [] },
            },
          ],
        }),
    },
    photos: q.photos || [],
    thread: T,
    chatSub: team ? 'Chat with the client · they reply from the Clients page' : 'Answer and attach documents for the Viljetech team',
    placeholder: team ? 'Message the client…' : 'Write your answer…',
    waiting: !answered,
    waitLbl: team ? 'Waiting for the client to answer' : 'The team is waiting for your answer',
    teamWait: !team && !!last && last.side === 'client',
    send: message => send({ type: 'question.message', id: q.id, message }),
    // An answer stored only as `answer` (seed data) is shown first as index -1, so comment indexes start after it.
    // An answer that came from the chat is its message in `comments`; editing it updates the answer too.
    edit: {
      canEdit: c => c.side === side && c.who === me,
      save: (i, text) => {
        const lead = answerShownFirst(q) ? 1 : 0
        send({ type: 'question.editMessage', id: q.id, index: i < lead ? -1 : i - lead, who: me, text })
      },
    },
  }
  return (
    <Shell m={m} close={close}>
      {q.text && (
        <>
          <div className="mt-[22px] text-[15px] font-extrabold text-ink">Details</div>
          <div className="mt-2 whitespace-pre-wrap text-[15px] leading-[1.65] text-ink [overflow-wrap:anywhere] [text-wrap:pretty]">{q.text}</div>
        </>
      )}
      <Photos
        photos={m.photos}
        emptyText={team ? 'No photos or files yet' : undefined}
        onAdd={
          team
            ? async files => {
                const F = await readFiles(files)
                if (F.length) send({ type: 'question.update', id: q.id, patch: { photos: [...(q.photos || []), ...F] } })
              }
            : undefined
        }
      />
    </Shell>
  )
}

function BugConversation({ bug, close }: { bug: Task; close: () => void }) {
  const ws = useScopedWorkspace()!
  const send = useActorSend()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const descRef = useRef<HTMLTextAreaElement>(null)
  useEscapeHold('desc', editing)
  // Start with the caret at the end of the existing text, not at position 0.
  useEffect(() => {
    const t = descRef.current
    if (!editing || !t) return
    t.focus()
    t.setSelectionRange(t.value.length, t.value.length)
  }, [editing])
  const st = statusOf(ws.statuses, bug.status)
  const ci = ws.statuses.findIndex(s => s.id === bug.status)
  const n = ws.statuses.length
  const d = bug.due ? diff(bug.due, TODAY) : null
  const overdue = d != null && d < 0 && bug.status !== 'done'
  const photos: (ChatFile & { i: number })[] = bug.atts.map((a, i) => ({
    name: a.name,
    size: a.size,
    url: a.url || '',
    img: isImageName(a.name),
    i,
  }))
  const update = (patch: Partial<Task>, log: string) => send({ type: 'task.update', id: bug.id, patch, log })
  // The client who reported it (the first history line), so the window names them.
  const reporter = bug.acts.find(a => a.what?.startsWith('reported this bug'))?.who || 'Client'

  const m: Model = {
    kind: 'Bug report',
    kIc: '!',
    kBg: '#C0392B',
    kSoft: '#FBE3DF',
    kC: '#A5502C',
    qkey: taskKey(bug),
    tags: [],
    title: bug.title,
    by: { name: reporter, i: initials(reporter), bg: '#56657A' },
    when: bug.clientBug?.reported || bug.atts[0]?.date || 'Today',
    status: { label: st.name, color: '#A5502C' },
    photos,
    thread: bug.clientBug?.chat || [],
    chatSub: 'Chat with the Viljetech team about this bug',
    placeholder: 'Message the team…',
    waiting: false,
    waitLbl: '',
    teamWait: false,
    send: message => send({ type: 'bug.message', id: bug.id, message }),
  }

  return (
    <Shell m={m} close={close}>
      <div className="mt-[18px] text-[15px] font-extrabold text-ink">Progress</div>
      <div className="mt-2.5 flex items-start">
        {ws.statuses.map((s, i) => {
          const dn = i < ci
          const cur = i === ci
          return (
            <div key={s.id} className="relative flex min-w-0 flex-1 flex-col items-center gap-1.5">
              <span className="absolute left-0 top-3 h-[3px] w-1/2" style={{ background: i === 0 ? 'transparent' : i <= ci ? '#3F9079' : '#E4EAF0' }} />
              <span className="absolute right-0 top-3 h-[3px] w-1/2" style={{ background: i === n - 1 ? 'transparent' : i < ci ? '#3F9079' : '#E4EAF0' }} />
              <span
                className="relative grid size-[26px] place-items-center rounded-full border-[2.5px] text-[12px] font-extrabold text-white"
                style={{
                  background: dn ? '#3F9079' : cur ? '#4870E8' : '#fff',
                  borderColor: dn ? '#3F9079' : cur ? '#4870E8' : '#C9D2DD',
                  boxShadow: cur ? '0 0 0 4px rgba(72,112,232,0.18)' : 'none',
                }}
              >
                {dn ? '✓' : cur ? String(i + 1) : ''}
              </span>
              <span className="text-center text-[12.5px]" style={{ fontWeight: cur ? 800 : 600, color: cur ? '#1B2D45' : dn ? '#195040' : '#3B4A5E' }}>
                {s.name}
              </span>
            </div>
          )
        })}
      </div>
      <div className="mt-4 grid gap-2.5" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.6fr)' }}>
        <div className="rounded-[14px] px-3.5 py-3 shadow-[0_0_0_1.5px_#D6DEE8]">
          <Label className="block">Due date</Label>
          <div className="mt-[5px] text-[16px] font-extrabold" style={{ color: overdue ? '#C0392B' : '#1B2D45' }}>
            {bug.due ? fmt(bug.due) : 'Not set yet'}
          </div>
          <div className="mt-0.5 text-[12px] text-muted">
            {bug.due && d != null
              ? overdue
                ? -d + ' days overdue'
                : d === 0
                  ? 'Due today'
                  : d > 0
                    ? 'In ' + d + ' days'
                    : 'Fixed'
              : 'The team will set a date'}
          </div>
        </div>
        <div className="rounded-[14px] px-3.5 py-3 shadow-[0_0_0_1.5px_#D6DEE8]">
          <Label className="block">Priority · you can change this</Label>
          <div className="mt-2 flex gap-1.5">
            {(['Low', 'Medium', 'High', 'Critical'] as ClientPriority[]).map(p => {
              const on = p === bug.prio
              const [c, bg] = PRIO_COLORS[p]
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => !on && update({ prio: p }, 'set priority to ' + p)}
                  className="h-8 flex-1 cursor-pointer rounded-lg border-[1.5px] text-[12.5px] font-bold"
                  style={{
                    borderColor: on ? (p === 'Critical' ? '#C0392B' : c) : '#C9D2DD',
                    background: on ? bg : '#fff',
                    color: on ? c : '#1B2D45',
                  }}
                >
                  {p}
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="mt-[22px] flex items-center">
        <span className="text-[15px] font-extrabold text-ink">Description</span>
        {!editing && (
          <button
            type="button"
            onClick={() => {
              setDraft(bug.desc || '')
              setEditing(true)
            }}
            className="ml-auto h-[30px] cursor-pointer rounded-lg border-[1.5px] border-line bg-white px-3 text-[12.5px] font-bold text-blue-ink hover:border-blue"
          >
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <>
          <textarea placeholder="Describe what you need from the client…"
            ref={descRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            rows={6}
            className="mt-2 w-full resize-y rounded-xl border-[1.5px] border-blue px-3 py-2.5 text-[14.5px] leading-[1.6] text-ink outline-0"
          />
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(false)} className="h-9 cursor-pointer rounded-[9px] border-[1.5px] border-faint bg-white px-3.5 text-[13px] font-semibold text-ink">
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                const v = draft.trim()
                if (v !== bug.desc) update({ desc: v }, 'updated the description')
                setEditing(false)
              }}
              className="h-9 cursor-pointer rounded-[9px] border-0 bg-blue px-4 text-[13px] font-bold text-white"
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="mt-2 whitespace-pre-wrap text-[15px] leading-[1.65] [overflow-wrap:anywhere] [text-wrap:pretty]" style={{ color: bug.desc ? '#1B2D45' : '#3B4A5E' }}>
          {bug.desc || 'No description yet.'}
        </div>
      )}

      <Photos
        photos={photos}
        onAdd={async files => {
          const F = await readFiles(files)
          if (!F.length) return
          const add: Attachment[] = F.map(x => ({ name: x.name, size: x.size, date: todayLabel(), url: x.url }))
          update({ atts: [...bug.atts, ...add] }, 'added ' + (add.length > 1 ? add.length + ' attachments' : 'an attachment'))
        }}
        onRemove={i => update({ atts: bug.atts.filter((_, j) => j !== i) }, 'removed ' + bug.atts[i].name)}
      />
    </Shell>
  )
}

function Photos({
  photos,
  onAdd,
  onRemove,
  emptyText = 'No photos or files yet. Attach yours in the chat.',
}: {
  photos: ChatFile[]
  onAdd?: (files: File[]) => void
  onRemove?: (i: number) => void
  emptyText?: string
}) {
  return (
    <>
      <div className="mt-[22px] flex items-center">
        <span className="text-[15px] font-extrabold text-ink">Photos &amp; files</span>
        <span className="tnum ml-2 text-[13px] text-ink-2">{photos.length}</span>
        {onAdd && (
          <span className="ml-auto flex">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-purple-soft px-3 text-[13px] font-bold text-purple-ink">
              <Icon d={PATHS.clip} size={16} sw={2.2} />
              Add
              <input
                type="file"
                multiple
                className="hidden"
                onChange={e => {
                  onAdd([...(e.target.files || [])])
                  e.target.value = ''
                }}
              />
            </label>
          </span>
        )}
      </div>
      {photos.length ? (
        <div className="mt-2.5 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))' }}>
          {photos.map((p, i) => (
            <a
              key={p.name + i}
              href={p.url || undefined}
              target="_blank"
              rel="noreferrer"
              download={p.name}
              className="block overflow-hidden rounded-xl bg-canvas text-ink no-underline shadow-[0_0_0_1.5px_#D6DEE8]"
            >
              {p.img && p.url ? (
                <span role="img" aria-label={p.name} className="block h-[110px] w-full bg-canvas bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url("${p.url}")` }} />
              ) : (
                <span className="grid h-[110px] place-items-center bg-red-soft text-[15px] font-extrabold text-rust">{fileExt(p.name)}</span>
              )}
              <span className="flex items-center gap-1 px-[9px] py-[7px] text-[12px] font-semibold">
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                {onRemove && (
                  <button
                    type="button"
                    onClick={e => {
                      e.preventDefault()
                      e.stopPropagation()
                      onRemove(i)
                    }}
                    title="Remove"
                    className="size-[22px] flex-none cursor-pointer rounded-md border-0 bg-rust-soft p-0 text-[14px] leading-none text-rust"
                  >
                    ×
                  </button>
                )}
              </span>
            </a>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-xl border-[1.5px] border-dashed border-line p-[18px] text-center text-[13px] text-muted">
          {emptyText}
        </div>
      )}
    </>
  )
}

function Shell({ m, close, children }: { m: Model; close: () => void; children: ReactNode }) {
  // The single grid row is bounded by the window, so each column scrolls on its own
  // and the chat column's header and composer stay in view.
  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[80] animate-fade-in bg-[rgba(27,45,69,0.45)]" />
      <div
        className="fixed bottom-5 left-1/2 top-5 z-[81] grid w-[min(1180px,calc(100vw-32px))] -translate-x-1/2 animate-pop-in overflow-hidden rounded-3xl border-[1.5px] border-line bg-white shadow-[0_40px_100px_rgba(27,45,69,0.35)]"
        style={{ gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,0.85fr)', gridTemplateRows: 'minmax(0,1fr)' }}
      >
        <div className="min-h-0 min-w-0 overflow-y-auto px-[30px] pb-[30px] pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded-[7px] pl-1 pr-[9px] text-[12px] font-extrabold" style={{ background: m.kSoft, color: m.kC }}>
              <span className="grid size-[18px] place-items-center rounded-[5px] text-[11px] text-white" style={{ background: m.kBg }}>
                {m.kIc}
              </span>
              {m.kind}
            </span>
            <span className="tnum rounded-md bg-lavender px-[7px] py-[3px] text-[12px] font-bold text-purple-ink">{m.qkey}</span>
            {m.pill && (
              <span className="inline-flex h-6 items-center gap-[5px] rounded-full pl-[7px] pr-[9px] text-[12px] font-bold" style={{ background: m.pill.bg, color: m.pill.c }}>
                <span className="size-1.5 rounded-full" style={{ background: m.pill.c }} />
                {m.pill.label}
              </span>
            )}
            {m.tags.map(g => (
              <span key={g.t} className="inline-flex h-6 items-center rounded-[7px] px-[9px] text-[12px] font-bold" style={{ background: g.bg, color: g.c }}>
                {g.t}
              </span>
            ))}
            {m.solve && (
              <button
                type="button"
                onClick={m.solve.toggle}
                className="ml-auto inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] px-3 text-[13px] font-bold"
                style={{
                  borderColor: m.solve.solved ? '#3F9079' : '#A9B6C5',
                  background: m.solve.solved ? '#D6E9E2' : '#FFFFFF',
                  color: m.solve.solved ? '#195040' : '#1B2D45',
                }}
              >
                <Icon d="M5 12l5 5 9-10" size={13} sw={2.8} />
                {m.solve.solved ? 'Solved · reopen' : 'Mark as solved'}
              </button>
            )}
          </div>
          <div className="mt-3.5 text-[26px] font-extrabold leading-[1.2] tracking-[-0.02em] text-ink [overflow-wrap:anywhere] [text-wrap:pretty]">{m.title}</div>
          <div className="mt-3.5 grid grid-cols-3 overflow-hidden rounded-[14px] shadow-[0_0_0_1.5px_#D6DEE8]">
            <div className="px-3.5 py-2.5">
              <Label className="block">Raised by</Label>
              <div className="mt-[5px] flex items-center gap-[7px] text-[14px] font-bold">
                <Avatar i={m.by.i} bg={m.by.bg} size={22} radius={6} font={9} className="!font-bold" />
                {m.by.name}
              </div>
            </div>
            <div className="border-l-[1.5px] border-line-2 px-3.5 py-2.5">
              <Label className="block">Raised</Label>
              <div className="mt-[5px] text-[14px] font-bold">{m.when}</div>
            </div>
            <div className="min-w-0 border-l-[1.5px] border-line-2 px-3.5 py-2.5">
              <Label className="block">Status</Label>
              <div className="mt-[5px] flex items-center gap-[7px] truncate text-[14px] font-bold" style={{ color: m.status.color }}>
                <span className="size-2 flex-none rounded-full" style={{ background: m.status.dot || m.status.color }} />
                {m.status.label}
              </div>
            </div>
          </div>
          {children}
        </div>
        <Chat m={m} close={close} />
      </div>
    </>
  )
}

function Chat({ m, close }: { m: Model; close: () => void }) {
  const { side: SIDE, person } = usePage()
  const me = useActorName()
  const [draft, setDraft] = useState('')
  const [pend, setPend] = useState<ChatFile[]>([])
  const [editing, setEditing] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  // Escape cancels an edit in progress instead of closing the window (see escapeHold.ts).
  useEscapeHold('edit', editing !== null)
  const list = useRef<HTMLDivElement>(null)
  // Scroll the message list itself. scrollIntoView would also scroll the window's
  // overflow-hidden panel and push its header off the top.
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [m.thread.length, m.waiting, m.teamWait])

  const ok = !!draft.trim() || pend.length > 0
  // An unsent draft is an edit in progress: Escape should not throw it away.
  useEscapeHold('composer', ok)
  const send = () => {
    if (!ok) return
    m.send({ who: me, side: SIDE, text: draft.trim(), when: 'just now', files: pend })
    setDraft('')
    setPend([])
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-col border-l-[1.5px] border-line-2 bg-canvas">
      <div className="flex items-center gap-2.5 border-b-[1.5px] border-line-2 bg-white px-[18px] py-4">
        <span className="grid size-8 place-items-center rounded-[9px] bg-green text-[12px] font-extrabold text-white">C</span>
        <div className="min-w-0">
          <div className="text-[15px] font-extrabold text-ink">Conversation</div>
          <div className="text-[12px] text-muted">{m.chatSub}</div>
        </div>
        <span className="ml-auto">
          <CloseButton onClick={close} />
        </span>
      </div>
      <div ref={list} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-4">
        {m.thread.map((c, i) => {
          const isC = c.side === 'client'
          const mine = c.side === SIDE
          const av = isC ? { i: 'C', bg: '#3F9079' } : person(c.who)
          return (
            <div key={i} className="flex min-w-0 items-end gap-2" style={{ flexDirection: mine ? 'row-reverse' : 'row' }}>
              <Avatar i={av.i} bg={av.bg} size={26} radius={7} font={9.5} className="!font-bold flex-none" />
              <div className="flex min-w-0 max-w-[82%] flex-col gap-1.5" style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
                <div className="min-w-0 max-w-full rounded-[14px] px-3 py-2.5 [overflow-wrap:anywhere]" style={{ background: isC ? '#EEF7F3' : '#F3F0FC', boxShadow: `inset 0 0 0 1.5px ${isC ? '#D6E9E2' : '#DCD3F5'}` }}>
                  <div className="flex min-w-0 gap-2 text-[11.5px] font-bold" style={{ color: isC ? '#195040' : '#3F2E94' }}>
                    {c.who}
                    <span className="font-medium text-muted">{c.when}</span>
                    {m.edit?.canEdit(c, i) && editing !== i && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditDraft(c.text)
                          setEditing(i)
                        }}
                        className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[11.5px] font-bold text-blue-ink"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                  {editing === i ? (
                    <div className="mt-1.5">
                      <textarea placeholder="Write your message…"
                        value={editDraft}
                        onChange={e => setEditDraft(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === 'Escape') {
                            e.stopPropagation()
                            setEditing(null)
                          }
                        }}
                        rows={3}
                        aria-label="Edit message"
                        className="w-full resize-y rounded-lg border-[1.5px] border-blue px-2.5 py-2 text-[14px] leading-normal text-ink outline-0"
                      />
                      <div className="mt-1.5 flex justify-end gap-1.5">
                        <button type="button" onClick={() => setEditing(null)} className="h-7 cursor-pointer rounded-lg border-[1.5px] border-faint bg-white px-2.5 text-[12px] font-semibold text-ink">
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const v = editDraft.trim()
                            if (v && v !== c.text) m.edit?.save(i, v)
                            setEditing(null)
                          }}
                          className="h-7 cursor-pointer rounded-lg border-0 bg-blue px-3 text-[12px] font-bold text-white"
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    c.text && <div className="mt-[3px] whitespace-pre-wrap text-[14px] leading-normal text-ink [overflow-wrap:anywhere]">{c.text}</div>
                  )}
                </div>
                {c.files?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                    {c.files.map((f, j) => (
                      <a
                        key={f.name + j}
                        href={f.url || undefined}
                        target="_blank"
                        rel="noreferrer"
                        download={f.name}
                        className="inline-flex max-w-[240px] items-center gap-2 rounded-[9px] bg-white px-2 py-1.5 text-ink no-underline shadow-[inset_0_0_0_1.5px_#D6DEE8]"
                      >
                        {f.img && f.url ? (
                          <span role="img" aria-label={f.name} className="size-10 flex-none rounded-md bg-canvas bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url("${f.url}")` }} />
                        ) : (
                          <span className="grid size-[34px] flex-none place-items-center rounded-[7px] bg-red-soft text-[9.5px] font-extrabold text-rust">{fileExt(f.name)}</span>
                        )}
                        <span className="min-w-0">
                          <span className="block truncate text-[12.5px] font-semibold">{f.name}</span>
                          <span className="block text-[11px] text-muted">{f.size}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {m.waiting && (
          <div className="rounded-[10px] border-[1.5px] border-dashed border-[#F0D58A] bg-[#FDF8EC] p-2.5 text-center text-[12.5px] font-semibold text-amber-ink">
            {m.waitLbl}
          </div>
        )}
        {m.teamWait && (
          <div className="rounded-[10px] border-[1.5px] border-dashed border-[#BFCDF5] bg-sky p-2.5 text-center text-[12.5px] font-semibold text-blue-ink">
            Sent. Waiting for the team to reply
          </div>
        )}
      </div>
      <div className="border-t-[1.5px] border-line-2 bg-white px-3.5 py-3">
        {pend.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pend.map((f, i) => (
              <span key={f.name + i} className="inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-purple-soft pl-[9px] pr-1.5 text-[12px] font-semibold text-purple-ink">
                {f.name}
                <button type="button" onClick={() => setPend(p => p.filter((_, j) => j !== i))} className="cursor-pointer border-0 bg-transparent px-0.5 text-[15px] leading-none text-purple-ink">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label title="Attach files" className="grid size-[38px] flex-none cursor-pointer place-items-center rounded-[10px] bg-purple-soft text-purple-ink">
            <Icon d={PATHS.clip} size={16} sw={2.2} />
            <input
              type="file"
              multiple
              className="hidden"
              onChange={async e => {
                const files = [...(e.target.files || [])]
                e.target.value = ''
                const F = await readFiles(files)
                setPend(p => [...p, ...F])
              }}
            />
          </label>
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={2}
            placeholder={m.placeholder}
            className="flex-1 resize-none rounded-xl border-[1.5px] border-line px-3 py-[9px] text-[14px] leading-[1.45] text-ink outline-0"
          />
          <button
            type="button"
            onClick={send}
            className="h-[38px] flex-none cursor-pointer rounded-[10px] border-0 bg-purple px-4 text-[13.5px] font-bold text-white"
            style={{ opacity: ok ? 1 : 0.45 }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
