import { useState } from 'react'
import { useSend } from '../../api/queries'
import type { ChatFile, DevopsRequest, Question } from '../../api/types'
import type { DvProject } from '../../api/devops/types'
import { readFiles } from '../../lib/files'
import { threadOf } from '../../domain/questions'
import { useDv } from './ctx'
import { DV_ME, T } from './model'

/* ───────────── Activity ───────────── */

const LOG_TONE: Record<string, [string, string, string]> = {
  'Phase change': T.purple,
  'Follow-up': T.blue,
  Action: T.orange,
  Note: T.gray,
  'Action update': T.teal,
  'Field change': T.green,
}

export function ActivityTab({ p }: { p: DvProject }) {
  const { update } = useDv()
  const [draft, setDraft] = useState('')
  const [type, setType] = useState('Follow-up')
  return (
    <>
      <div className="rounded-2xl bg-canvas p-1">
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="Write an update…"
          rows={2}
          className="w-full resize-y rounded-xl border-0 bg-transparent px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
        />
        <div className="flex items-center gap-1 px-1.5 pb-1.5">
          {['Follow-up', 'Action', 'Note'].map(t => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className="cursor-pointer rounded-md border-0 px-[9px] py-1 text-[12px] font-medium"
              style={{ background: type === t ? '#fff' : 'transparent', color: type === t ? '#1B2D45' : '#3B4A5E' }}
            >
              {t}
            </button>
          ))}
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              const t = draft.trim()
              if (!t) return
              update(p.key, {}, { type, text: t })
              setDraft('')
            }}
            className="cursor-pointer rounded-lg border-0 bg-blue px-3.5 py-1.5 text-[12px] font-medium text-white"
          >
            Post
          </button>
        </div>
      </div>
      <div className="mt-7 flex flex-col gap-[22px]">
        {p.logs.map((l, i) => (
          <div key={i} className="grid grid-cols-[26px_1fr] gap-3">
            <div className="flex size-[26px] items-center justify-center rounded-md bg-blue text-[11px] font-semibold text-white">R</div>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 text-[12px] text-muted">
                <span className="text-[13px] font-semibold text-ink">{l.by}</span>
                <span className="font-medium" style={{ color: (LOG_TONE[l.type] || T.gray)[0] }}>
                  {l.type}
                </span>
                <span className="ml-auto">{l.when}</span>
              </div>
              <div className="mt-[3px] text-[14px] leading-normal [text-wrap:pretty]">{l.text}</div>
              {l.detail && <div className="mt-[3px] text-[12px] leading-[1.45] text-slate">{l.detail}</div>}
            </div>
          </div>
        ))}
        {!p.logs.length && <div className="text-[13px] text-muted">No updates yet.</div>}
      </div>
    </>
  )
}

/* ───────────── Tickets (DevOps requests) ───────────── */

export const REQ_STATUS: Record<string, [string, string]> = {
  Open: ['#7A5C0E', '#FBEDC2'],
  'In progress': ['#1F3FAF', '#DCE5FA'],
  Done: ['#195040', '#D6E9E2'],
}
export const REQ_PRIO: Record<string, [string, string]> = {
  Urgent: ['#7A3818', '#F6DDD0'],
  High: ['#7A5C0E', '#FBEDC2'],
  Medium: ['#1F3FAF', '#DCE5FA'],
  Low: ['#22354C', '#E7EEFB'],
}

export function TicketsTab({ requests }: { requests: DevopsRequest[] }) {
  const { open } = useDv()
  return (
    <>
      <div className="mb-3 text-[13px] text-ink-2">Requests raised from Tickets for this project.</div>
      <div className="flex flex-col gap-2">
        {requests.map(r => {
          const st = REQ_STATUS[r.status || 'Open'] || REQ_STATUS.Open
          const pc = REQ_PRIO[r.prio] || REQ_PRIO.Medium
          return (
            <div
              key={r.id}
              onClick={() => open({ request: String(r.id) })}
              data-request={r.rkey}
              className="cursor-pointer rounded-xl border-[1.5px] border-line bg-white px-3.5 py-3 hover:border-blue"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="tnum font-sans text-[11.5px] font-semibold text-blue-ink">{r.rkey}</span>
                <span className="rounded-full bg-lavender px-[7px] py-px text-[11px] font-bold text-purple-ink">{r.type}</span>
                <span className="rounded-full px-[7px] py-px text-[11px] font-bold" style={{ background: pc[1], color: pc[0] }}>
                  {r.prio}
                </span>
                <span className="text-[12px] font-semibold text-blue-ink">{r.to ? '@' + r.to : 'DevOps team'}</span>
                <span
                  className="ml-auto inline-flex items-center gap-1.5 rounded-full py-0.5 pl-[7px] pr-[9px] text-[12px] font-bold"
                  style={{ background: st[1], color: st[0] }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: st[0] }} />
                  {r.status || 'Open'}
                </span>
              </div>
              <div className="mt-1.5 text-[14px] font-semibold leading-[1.4]">{r.text}</div>
              <div className="mt-1 text-[12px] text-muted">
                From {r.by} · {r.when}
              </div>
            </div>
          )
        })}
        {!requests.length && (
          <div className="rounded-xl border-[1.5px] border-dashed border-line p-7 text-center text-[13.5px] text-ink-2">
            No tickets yet. Teams can raise requests from the Tickets page.
          </div>
        )}
      </div>
    </>
  )
}

/* ───────────── Client chat (questions to the client) ───────────── */

const Q_TYPE: Record<string, [string, string]> = {
  Blocker: ['#FBE3DF', '#C0392B'],
  Information: ['#E7EEFB', '#1F3FAF'],
  Requirement: ['#D6E9E2', '#195040'],
}
const Q_PRIO: Record<string, [string, string]> = {
  Critical: ['#C0392B', '#FFFFFF'],
  High: ['#FBEDC2', '#7A5C0E'],
  Medium: ['#DCE5FA', '#1F3FAF'],
  Low: ['#E7EEFB', '#22354C'],
}

/** Waiting / Answered / Solved, as the team sees it: [label, bg, ink]. */
export const questionStatus = (q: Question): [string, string, string] =>
  q.solved
    ? ['Solved', '#3F9079', '#FFFFFF']
    : threadOf(q).some(x => x.side === 'client')
      ? ['Answered', '#D6E9E2', '#195040']
      : ['Waiting', '#FBEDC2', '#7A5C0E']

const SelectBox = ({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: [string, string][] }) => (
  <span className="relative inline-flex min-w-0 flex-1">
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="h-9 w-full cursor-pointer appearance-none rounded-[9px] border-[1.5px] border-line bg-white pl-2.5 pr-7 text-[13px] font-semibold text-ink outline-0"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
    <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-2">
      <path d="M6 9l6 6 6-6" />
    </svg>
  </span>
)

export function ClientChatTab({ p, questions }: { p: DvProject; questions: Question[] }) {
  const { open } = useDv()
  const send = useSend()
  const [form, setForm] = useState(false)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [qtype, setQtype] = useState('')
  const [qprio, setQprio] = useState('')
  const [pend, setPend] = useState<ChatFile[]>([])
  const mine = questions.filter(q => q.project === p.key)
  const ti = title.trim()

  const raise = () => {
    if (!ti) return
    const id = Math.max(0, ...questions.map(x => x.id)) + 1
    send({
      type: 'question.create',
      question: {
        id,
        by: DV_ME,
        title: ti,
        text: text.trim(),
        photos: pend,
        qtype,
        qprio,
        project: p.key,
        fromDevops: true,
        when: 'just now',
        task: null,
        answer: '',
        comments: [],
      },
    })
    setTitle('')
    setText('')
    setQtype('')
    setQprio('')
    setPend([])
    setForm(false)
    open({ question: String(id) })
  }

  return (
    <>
      <div className="mb-3 text-[13px] text-ink-2">Raise a ticket straight to the client. They see it in "Questions to client" on the Clients page.</div>
      <button
        type="button"
        onClick={() => setForm(!form)}
        className="flex h-[42px] w-full cursor-pointer items-center gap-2 rounded-[10px] border-[1.5px] border-dashed px-3 text-[13.5px] font-bold text-purple-ink hover:!border-purple hover:!bg-purple-soft"
        style={{ borderColor: form ? '#6E58C9' : '#BBAEEA', background: form ? '#F3F0FC' : '#FFFFFF' }}
      >
        <span
          className="grid size-5 flex-none place-items-center rounded-md bg-purple text-white transition-transform duration-[250ms]"
          style={{ transform: `rotate(${form ? '45deg' : '0deg'})` }}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </span>
        {form ? 'Close' : 'Raise a question to the client'}
      </button>
      {form && (
        <div className="mt-2.5 flex flex-col gap-2 rounded-[14px] border-[1.5px] border-purple-line bg-purple-soft p-3.5">
          <input
            autoFocus
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title, e.g. Need DNS access for the new domain"
            className="h-10 w-full rounded-[10px] border-[1.5px] border-line bg-white px-[11px] py-[9px] text-[14px] font-semibold text-ink outline-0"
          />
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            rows={3}
            placeholder="Details for the client…"
            className="w-full resize-y rounded-[10px] border-[1.5px] border-line bg-white px-[11px] py-[9px] text-[14px] leading-normal text-ink outline-0"
          />
          <div className="flex gap-2">
            <SelectBox
              value={qtype}
              onChange={setQtype}
              options={[
                ['', 'Type (optional)'],
                ['Blocker', 'Blocker'],
                ['Information', 'Information'],
                ['Requirement', 'Requirement'],
              ]}
            />
            <SelectBox
              value={qprio}
              onChange={setQprio}
              options={[
                ['', 'Priority (optional)'],
                ['Critical', 'Critical'],
                ['High', 'High'],
                ['Medium', 'Medium'],
                ['Low', 'Low'],
              ]}
            />
            <button
              type="button"
              onClick={raise}
              className="h-9 flex-none cursor-pointer rounded-[9px] border-0 bg-purple px-4 text-[13px] font-bold text-white"
              style={{ opacity: ti ? 1 : 0.45 }}
            >
              Raise to client
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-white px-2.5 text-[12.5px] font-bold text-purple-ink shadow-[inset_0_0_0_1.5px_#DCD3F5]">
              + Photos &amp; files
              <input
                type="file"
                multiple
                className="hidden"
                onChange={async e => {
                  const files = [...(e.target.files || [])]
                  e.target.value = ''
                  const F = await readFiles(files)
                  setPend(x => [...x, ...F])
                }}
              />
            </label>
            {pend.map((f, i) => (
              <span key={f.name + i} className="inline-flex h-[26px] items-center gap-1 rounded-md bg-white pl-2 pr-1 text-[12px] font-semibold text-ink">
                {f.name}
                <button type="button" onClick={() => setPend(x => x.filter((_, j) => j !== i))} className="cursor-pointer border-0 bg-transparent px-0.5 text-[14px] text-muted">
                  ×
                </button>
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="mt-4 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Client tickets · {mine.length}</div>
      <div className="mt-2 flex flex-col gap-1.5">
        {mine
          .slice()
          .reverse()
          .map(q => {
            const st = questionStatus(q)
            const n = threadOf(q).length
            const tags: [string, string, string][] = []
            if (q.qtype) tags.push([q.qtype, ...(Q_TYPE[q.qtype] || ['#F3F0FC', '#3F2E94'])])
            if (q.qprio && Q_PRIO[q.qprio]) tags.push([q.qprio, ...Q_PRIO[q.qprio]])
            return (
              <div
                key={q.id}
                onClick={() => open({ question: String(q.id) })}
                data-question={q.id}
                className="cursor-pointer rounded-[10px] bg-canvas px-3 py-2.5 shadow-[inset_0_0_0_1.5px_#E4EAF0] hover:!bg-white hover:!shadow-[inset_0_0_0_1.5px_#6E58C9]"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="rounded-[5px] bg-lavender px-1.5 py-0.5 text-[11.5px] font-bold text-purple-ink">Q-{q.id}</span>
                  <span className="inline-flex h-5 items-center rounded-[5px] px-[7px] text-[11px] font-bold" style={{ background: st[1], color: st[2] }}>
                    {st[0]}
                  </span>
                  {tags.map(([t, bg, c]) => (
                    <span key={t} className="inline-flex h-5 items-center rounded-[5px] px-[7px] text-[11px] font-bold" style={{ background: bg, color: c }}>
                      {t}
                    </span>
                  ))}
                  <span className="ml-auto text-[12px] text-muted">
                    {q.when} · {n} message{n === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-1.5 text-[14px] font-bold text-ink">{q.title || q.text}</div>
              </div>
            )
          })}
        {!mine.length && <div className="p-4 text-center text-[13px] text-muted">No client tickets for this project yet.</div>}
      </div>
    </>
  )
}
