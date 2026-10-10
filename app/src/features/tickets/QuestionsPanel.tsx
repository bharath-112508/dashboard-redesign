import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useQuestions, useSend, useWorkspace } from '../../api/queries'
import type { ChatFile, Question } from '../../api/types'
import { Avatar, Icon, PATHS, Scrim } from '../../components/ui'
import { readFiles } from '../../lib/files'
import { ME, questionTags } from '../../lib/theme'
import { threadOf } from '../../domain/questions'
import { sprintsOf } from '../../domain/tasks'
import { usePerson } from '../../state/page'
import { useOverlay } from '../../state/ui'

type Opt = { v: string; label: string; glyph: string; tile: string; ic: string }
const TYPE_OPTS: Opt[] = [
  { v: 'Blocker', label: 'Blocker', glyph: '!', tile: '#FBE3DF', ic: '#C0392B' },
  { v: 'Information', label: 'Information', glyph: 'i', tile: '#E7EEFB', ic: '#1F3FAF' },
  { v: 'Requirement', label: 'Requirement', glyph: '✓', tile: '#D6E9E2', ic: '#195040' },
  { v: 'custom', label: 'Custom…', glyph: '✎', tile: '#F3F0FC', ic: '#3F2E94' },
]
const PRIO_OPTS: Opt[] = [
  { v: 'Critical', label: 'Critical', glyph: '●', tile: '#C0392B', ic: '#FFFFFF' },
  { v: 'High', label: 'High', glyph: '↑', tile: '#FBEDC2', ic: '#7A5C0E' },
  { v: 'Medium', label: 'Medium', glyph: '=', tile: '#DCE5FA', ic: '#1F3FAF' },
  { v: 'Low', label: 'Low', glyph: '↓', tile: '#E7EEFB', ic: '#22354C' },
]

const schema = z
  .object({
    title: z.string(),
    text: z.string(),
    qtype: z.string(),
    custom: z.string(),
    qprio: z.string(),
    sprint: z.string(),
  })
  .refine(f => !!(f.title.trim() || f.text.trim()), { message: 'Add a title or details', path: ['title'] })
type Form = z.infer<typeof schema>
const EMPTY: Form = { title: '', text: '', qtype: '', custom: '', qprio: '', sprint: '' }

/** Messages in a question, counting the question itself (the panel's "3 messages"). */
const messageCount = (q: Question) => 1 + threadOf(q).length
const clientCount = (q: Question) => threadOf(q).filter(c => c.side === 'client').length
/** The team hasn't seen the client's latest messages. */
export const hasNewReply = (q: Question) => clientCount(q) > (q.seenT || 0)

/** "Questions to client" button in the epic bar and its panel: raise a question and see every question. */
export function QuestionsPanel({ epic }: { epic: string }) {
  const ws = useWorkspace().data!
  const questions = useQuestions().data ?? []
  const send = useSend()
  const person = usePerson()
  const overlay = useOverlay()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState(false)
  const [dd, setDd] = useState<'qt' | 'qp' | null>(null)
  const [pend, setPend] = useState<ChatFile[]>([])
  const { register, handleSubmit, watch, setValue, reset } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: EMPTY })
  const f = watch()
  const ok = !!(f.title.trim() || f.text.trim())

  const items = [...questions].sort((a, b) => Number(!!a.answer) - Number(!!b.answer))
  const waiting = items.filter(q => !q.answer).length
  const newN = items.filter(hasNewReply).length

  const openQ = (q: Question) => {
    setOpen(false)
    const seen = clientCount(q)
    if ((q.seenT || 0) !== seen) send({ type: 'tickets.question.seen', id: q.id, seen })
    overlay.open('question', q.id)
  }

  const onSubmit = (v: Form) => {
    const text = v.text.trim()
    const id = Math.max(0, ...questions.map(x => x.id)) + 1
    send({
      type: 'question.create',
      question: {
        id,
        by: ME,
        title: v.title.trim() || text.split('\n')[0].slice(0, 80),
        text,
        photos: pend,
        qtype: v.qtype === 'custom' ? v.custom.trim() : v.qtype,
        qprio: v.qprio,
        when: 'just now',
        task: null,
        sprint: v.sprint || null,
        answer: '',
        comments: [],
      },
    })
    reset(EMPTY)
    setPend([])
    setForm(false)
    setOpen(false)
    overlay.open('question', id)
  }

  const dropdown = (key: 'qt' | 'qp', field: 'qtype' | 'qprio', placeholder: string, list: Opt[]) => {
    const cur = f[field]
    const sel = list.find(o => o.v === cur)
    const isOpen = dd === key
    return (
      <span className="relative flex min-w-0 flex-1">
        <button
          type="button"
          onClick={() => setDd(isOpen ? null : key)}
          className="flex h-[34px] w-full cursor-pointer items-center gap-2 rounded-lg border-[1.5px] bg-white pl-1.5 pr-2.5 text-[13px] font-semibold text-ink"
          style={{ borderColor: sel ? (sel.ic === '#FFFFFF' ? sel.tile : sel.ic) : '#C9D2DD' }}
        >
          <span
            className="grid size-[22px] flex-none place-items-center rounded-md text-[11px] font-extrabold"
            style={{ background: sel ? sel.tile : '#EEF3FB', color: sel ? sel.ic : '#3B4A5E' }}
          >
            {sel ? sel.glyph : '+'}
          </span>
          <span className="min-w-0 flex-1 truncate text-left" style={{ color: sel ? '#1B2D45' : '#3B4A5E' }}>
            {sel ? sel.label : placeholder}
          </span>
          <Icon d={PATHS.chevron} size={11} sw={2.8} className="text-ink-2" />
        </button>
        {isOpen && (
          <>
            <Scrim onClick={() => setDd(null)} />
            <div className="absolute left-0 right-0 top-10 z-[41] rounded-xl border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]">
              {[{ v: '', label: 'None', glyph: '–', tile: '#EEF3FB', ic: '#3B4A5E' }, ...list].map(o => {
                const on = o.v === (cur || '')
                return (
                  <div
                    key={o.v || 'none'}
                    onClick={() => {
                      setValue(field, o.v)
                      setDd(null)
                    }}
                    className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-[7px] hover:!bg-canvas"
                    style={{ background: on ? '#F3F0FC' : 'transparent' }}
                  >
                    <span className="grid size-[22px] flex-none place-items-center rounded-md text-[11px] font-extrabold" style={{ background: o.tile, color: o.ic }}>
                      {o.glyph}
                    </span>
                    <span className="flex-1 text-[13px] font-semibold text-ink">{o.label}</span>
                    <span className="w-3.5 text-[12px] font-extrabold text-purple">{on ? '✓' : ''}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </span>
    )
  }

  const input = 'w-full border-[1.5px] border-line text-ink outline-0'

  return (
    <span className="relative order-[100] inline-flex">
      {newN > 0 && !open && (
        <span className="pointer-events-none absolute -right-[7px] -top-[7px] z-[2] inline-flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-purple px-1.5 text-[11px] font-bold text-white shadow-[0_0_0_2px_#F6F9FC]">
          {newN}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-purple-soft pl-2 pr-2.5 text-[13.5px] font-semibold text-purple-ink hover:!shadow-[0_0_0_1.5px_#6E58C9]"
        style={{ boxShadow: open ? '0 0 0 1.5px #6E58C9' : 'none' }}
      >
        <span className="grid size-5 place-items-center rounded-[5px] bg-purple text-[12px] font-extrabold text-white">?</span>
        Questions to client
        <span className="tnum text-[12.5px] text-purple-ink opacity-80">{items.length}</span>
        <Icon d={PATHS.chevron} size={11} sw={2.8} />
      </button>
      {open && (
        <>
          <Scrim onClick={() => setOpen(false)} z={30} />
          <div className="absolute right-0 top-[calc(100%+8px)] z-[31] max-h-[72vh] w-[420px] overflow-y-auto rounded-2xl border-[1.5px] border-line bg-white p-4 shadow-[0_18px_50px_rgba(27,45,69,0.18)]">
            <div className="flex items-center gap-2">
              <span className="grid size-[22px] place-items-center rounded-md bg-purple text-[12px] font-extrabold text-white">?</span>
              <span className="text-[15px] font-extrabold text-ink">Questions to client</span>
              <span className="ml-auto text-[12.5px] font-semibold text-purple-ink">{waiting ? waiting + ' waiting' : 'All answered'}</span>
            </div>
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setForm(!form)}
                className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] border-[1.5px] border-dashed px-3 text-[13.5px] font-bold text-purple-ink hover:!border-purple hover:!bg-purple-soft"
                style={{ borderColor: form ? '#6E58C9' : '#BBAEEA', background: form ? '#F3F0FC' : '#FFFFFF' }}
              >
                <span
                  className="grid size-5 flex-none place-items-center rounded-md bg-purple text-white transition-transform duration-[250ms]"
                  style={{ transform: `rotate(${form ? 45 : 0}deg)` }}
                >
                  <Icon d={PATHS.plus} size={12} sw={3} />
                </span>
                {form ? 'Close' : 'Raise a question'}
              </button>
              <div
                className="transition-[max-height,opacity] duration-[350ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                style={{ maxHeight: form ? 520 : 0, opacity: form ? 1 : 0, overflow: form ? 'visible' : 'hidden' }}
              >
                <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-2 pt-2.5">
                  <input
                    {...register('title')}
                    placeholder="Title, e.g. Which languages at launch?"
                    className={`${input} h-[38px] rounded-[10px] px-[11px] text-[14px] font-semibold`}
                  />
                  <textarea
                    {...register('text')}
                    rows={3}
                    placeholder="Describe what you need from the client…"
                    className={`${input} resize-y rounded-[10px] px-[11px] py-[9px] text-[13.5px] leading-normal`}
                  />
                  <div className="flex gap-2">
                    {dropdown('qt', 'qtype', 'Type (optional)', TYPE_OPTS)}
                    {dropdown('qp', 'qprio', 'Priority (optional)', PRIO_OPTS)}
                  </div>
                  {f.qtype === 'custom' && (
                    <input {...register('custom')} placeholder="Custom type, e.g. Design approval" className={`${input} h-[34px] rounded-lg px-2.5 text-[13px]`} />
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-purple-soft px-2.5 text-[12.5px] font-bold text-purple-ink">
                      + Photos
                      <input
                        type="file"
                        multiple
                        accept="image/*,.pdf,.doc,.docx,.xlsx"
                        className="hidden"
                        onChange={async e => {
                          const files = [...(e.target.files || [])]
                          e.target.value = ''
                          const F = await readFiles(files)
                          setPend(p => [...p, ...F])
                        }}
                      />
                    </label>
                    {pend.map((p, i) => (
                      <span key={p.name + i} className="inline-flex h-[26px] max-w-[140px] items-center gap-1 rounded-md bg-sky pl-2 pr-1 text-[12px] font-semibold text-ink">
                        <span className="truncate">{p.name}</span>
                        <button type="button" onClick={() => setPend(x => x.filter((_, j) => j !== i))} className="cursor-pointer border-0 bg-transparent px-0.5 text-[14px] text-muted">
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="relative inline-flex min-w-0 flex-1">
                      <select
                        {...register('sprint')}
                        className="h-8 w-full cursor-pointer appearance-none rounded-lg border-[1.5px] border-line bg-white pl-2.5 pr-[26px] text-[12.5px] font-semibold text-ink outline-0"
                      >
                        <option value="">No linked sprint</option>
                        {sprintsOf(ws.sprints, epic).map(x => (
                          <option key={x.id} value={x.id}>
                            {x.name + (x.state === 'active' ? ' · active' : '')}
                          </option>
                        ))}
                      </select>
                      <Icon d={PATHS.chevron} size={10} sw={2.8} className="pointer-events-none absolute right-[9px] top-1/2 -translate-y-1/2 text-ink-2" />
                    </span>
                    <button
                      type="submit"
                      className="h-8 flex-none cursor-pointer rounded-lg border-0 bg-purple px-3.5 text-[13px] font-bold text-white"
                      style={{ opacity: ok ? 1 : 0.45 }}
                    >
                      Raise question
                    </button>
                  </div>
                </form>
              </div>
            </div>
            <div className="mt-3.5 text-[11px] font-bold uppercase tracking-[0.06em] text-muted">Questions · {items.length}</div>
            <div className="mt-2 flex flex-col gap-1.5">
              {items.map(q => {
                const m = person(q.by)
                const ans = !!q.answer
                const st = q.solved ? 'Solved' : ans ? 'Answered' : 'Waiting'
                const [stBg, stC] = q.solved ? ['#3F9079', '#FFFFFF'] : ans ? ['#D6E9E2', '#195040'] : ['#FBEDC2', '#7A5C0E']
                const n = messageCount(q)
                return (
                  <div
                    key={q.id}
                    onClick={() => openQ(q)}
                    className="flex cursor-pointer flex-col gap-1.5 rounded-[10px] bg-canvas px-3 py-2.5 shadow-[inset_0_0_0_1.5px_#E4EAF0] hover:!bg-white hover:!shadow-[inset_0_0_0_1.5px_#6E58C9]"
                  >
                    <div className="flex items-center gap-2">
                      <span className="tnum rounded-[5px] bg-lavender px-1.5 py-0.5 text-[11.5px] font-bold text-purple-ink">Q-{q.id}</span>
                      <span className="inline-flex h-5 items-center rounded-[5px] px-[7px] text-[11px] font-bold" style={{ background: stBg, color: stC }}>
                        {st}
                      </span>
                      {questionTags(q).map(g => (
                        <span key={g.t} className="inline-flex h-5 items-center whitespace-nowrap rounded-[5px] px-[7px] text-[11px] font-bold" style={{ background: g.bg, color: g.c }}>
                          {g.t}
                        </span>
                      ))}
                      {hasNewReply(q) && (
                        <span className="inline-flex h-5 items-center rounded-[5px] bg-purple px-[7px] text-[11px] font-bold text-white">New reply</span>
                      )}
                      <span className="ml-auto text-[12px] text-muted">{q.when}</span>
                    </div>
                    <div className="clamp-2 text-[13.5px] font-semibold leading-[1.45] text-ink">{q.title || q.text}</div>
                    <div className="flex items-center gap-1.5 text-[12px] text-ink-2">
                      <Avatar i={m.i} bg={m.bg} size={18} radius={5} font={8} className="!font-bold" />
                      {q.by}
                      <span className="ml-auto">{n + ' message' + (n === 1 ? '' : 's')}</span>
                    </div>
                  </div>
                )
              })}
              {!items.length && <div className="p-4 text-center text-[13px] text-muted">No questions raised yet.</div>}
            </div>
          </div>
        </>
      )}
    </span>
  )
}
