import { useEffect, useRef, useState } from 'react'
import { useQuestions, useSend } from '../../api/queries'
import type { ChatFile, ChatMessage, Question } from '../../api/types'
import { threadOf } from '../../domain/questions'
import { fileExt } from '../../domain/tasks'
import { readFiles } from '../../lib/files'
import { questionTags } from '../../lib/theme'
import { useDv } from './ctx'
import { member } from './model'
import { questionStatus } from './OtherTabs'

/** DevOps is the team side: its messages sit on the right. */
const SIDE = 'team'

const STATUS_BOX: Record<string, [string, string]> = {
  Solved: ['#195040', '#3F9079'],
  Answered: ['#195040', '#3F9079'],
  Waiting: ['#7A5C0E', '#B98A2F'],
}

/** A question DevOps raised to the client: the question on the left, the chat on the right. */
export function QuestionWindow({ id }: { id: number }) {
  const q = (useQuestions().data ?? []).find(x => x.id === id)
  if (!q) return null
  return <Inner q={q} />
}

function Inner({ q }: { q: Question }) {
  const { open, me } = useDv()
  const send = useSend()
  const [draft, setDraft] = useState('')
  const [pend, setPend] = useState<ChatFile[]>([])
  const end = useRef<HTMLDivElement>(null)
  const T = threadOf(q)
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [T.length])
  const close = () => open({ question: null }, true)
  const [st, stBg, stC] = questionStatus(q)
  const [boxTx, boxDot] = STATUS_BOX[st]
  const sv = !!q.solved
  const by = member(q.by)
  const photos = q.photos || []
  const ok = !!draft.trim() || pend.length > 0
  const msg = (text: string, files: ChatFile[] = []): ChatMessage => ({ who: me, side: SIDE, text, when: 'just now', files })

  const sendMsg = () => {
    if (!ok) return
    send({ type: 'question.message', id: q.id, message: msg(draft.trim(), pend) })
    setDraft('')
    setPend([])
  }
  const toggleSolved = () =>
    send({
      type: 'batch',
      cmds: [
        { type: 'question.update', id: q.id, patch: { solved: !sv } },
        { type: 'question.message', id: q.id, message: msg(sv ? 'Reopened the question' : 'Marked as solved') },
      ],
    })

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[80] animate-fade-in bg-[rgba(27,45,69,0.45)]" />
      <div
        data-testid="question-window"
        className="fixed bottom-5 left-1/2 top-5 z-[81] grid w-[min(1180px,calc(100vw-32px))] -translate-x-1/2 animate-pop-in overflow-hidden rounded-3xl border-[1.5px] border-line bg-white font-normal text-ink shadow-[0_40px_100px_rgba(27,45,69,0.35)]"
        style={{ gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,0.85fr)' }}
      >
        <div className="min-w-0 overflow-y-auto px-[30px] pb-[30px] pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[7px] bg-purple-soft pl-1 pr-[9px] text-[12px] font-extrabold text-purple-ink">
              <span className="grid size-[18px] place-items-center rounded-[5px] bg-purple text-[11px] text-white">?</span>
              Question to client
            </span>
            <span className="tnum rounded-md bg-lavender px-[7px] py-[3px] text-[12px] font-bold text-purple-ink">Q-{q.id}</span>
            <span className="inline-flex h-6 items-center gap-[5px] rounded-full pl-[7px] pr-[9px] text-[12px] font-bold" style={{ background: stBg, color: stC }}>
              <span className="size-1.5 rounded-full" style={{ background: stC }} />
              {st}
            </span>
            {questionTags(q).map(g => (
              <span key={g.t} className="inline-flex h-6 items-center rounded-[7px] px-[9px] text-[12px] font-bold" style={{ background: g.bg, color: g.c }}>
                {g.t}
              </span>
            ))}
            <button
              type="button"
              onClick={toggleSolved}
              className="ml-auto inline-flex h-[30px] cursor-pointer items-center gap-1.5 rounded-lg border-[1.5px] px-3 text-[13px] font-bold"
              style={{ borderColor: sv ? '#3F9079' : '#A9B6C5', background: sv ? '#D6E9E2' : '#FFFFFF', color: sv ? '#195040' : '#1B2D45' }}
            >
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12l5 5 9-10" />
              </svg>
              {sv ? 'Solved · reopen' : 'Mark as solved'}
            </button>
          </div>
          <div className="mt-3.5 text-[26px] font-extrabold leading-[1.2] tracking-[-0.02em] text-ink [text-wrap:pretty]">
            {q.title || (q.text.length > 60 ? q.text.slice(0, 60).replace(/\s+\S*$/, '') + '…' : q.text)}
          </div>
          <div className="mt-3.5 grid grid-cols-3 overflow-hidden rounded-[14px] shadow-[0_0_0_1.5px_#D6DEE8]">
            <div className="px-3.5 py-2.5">
              <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Raised by</div>
              <div className="mt-[5px] flex items-center gap-[7px] text-[14px] font-bold">
                <span className="grid size-[22px] place-items-center rounded-md text-[9px] font-bold text-white" style={{ background: by.bg }}>
                  {by.i}
                </span>
                {q.by}
              </div>
            </div>
            <div className="border-l-[1.5px] border-line-2 px-3.5 py-2.5">
              <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Raised</div>
              <div className="mt-[5px] text-[14px] font-bold">{q.when}</div>
            </div>
            <div className="min-w-0 border-l-[1.5px] border-line-2 px-3.5 py-2.5">
              <div className="text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Status</div>
              <div className="mt-[5px] flex items-center gap-[7px] truncate text-[14px] font-bold" style={{ color: boxTx }}>
                <span className="size-2 flex-none rounded-full" style={{ background: boxDot }} />
                {st}
              </div>
            </div>
          </div>
          {q.text && (
            <>
              <div className="mt-[22px] text-[15px] font-extrabold text-ink">Details</div>
              <div className="mt-2 whitespace-pre-wrap text-[15px] leading-[1.65] text-ink [text-wrap:pretty]">{q.text}</div>
            </>
          )}
          <div className="mt-[22px] flex items-center">
            <span className="text-[15px] font-extrabold text-ink">Photos &amp; files</span>
            <span className="tnum ml-2 text-[13px] text-ink-2">{photos.length}</span>
            <span className="ml-auto flex">
              <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-purple-soft px-3 text-[13px] font-bold text-purple-ink">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
                </svg>
                Add
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={async e => {
                    const files = [...(e.target.files || [])]
                    e.target.value = ''
                    const F = await readFiles(files)
                    if (F.length) send({ type: 'question.update', id: q.id, patch: { photos: [...photos, ...F] } })
                  }}
                />
              </label>
            </span>
          </div>
          {photos.length ? (
            <div className="mt-2.5 grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))' }}>
              {photos.map((p, i) => (
                <a key={p.name + i} href={p.url || undefined} target="_blank" rel="noreferrer" download={p.name} className="block overflow-hidden rounded-xl bg-canvas text-ink no-underline shadow-[0_0_0_1.5px_#D6DEE8]">
                  {p.img && p.url ? (
                    <span role="img" aria-label={p.name} className="block h-[110px] w-full bg-canvas bg-cover bg-center bg-no-repeat" style={{ backgroundImage: `url("${p.url}")` }} />
                  ) : (
                    <span className="grid h-[110px] place-items-center bg-red-soft text-[15px] font-extrabold text-rust">{fileExt(p.name)}</span>
                  )}
                  <span className="block truncate px-[9px] py-[7px] text-[12px] font-semibold">{p.name}</span>
                </a>
              ))}
            </div>
          ) : (
            <div className="mt-2.5 rounded-xl border-[1.5px] border-dashed border-line p-[18px] text-center text-[13px] text-muted">No photos or files yet</div>
          )}
        </div>

        <div className="flex min-w-0 flex-col border-l-[1.5px] border-line-2 bg-canvas">
          <div className="flex items-center gap-2.5 border-b-[1.5px] border-line-2 bg-white px-[18px] py-4">
            <span className="grid size-8 place-items-center rounded-[9px] bg-green text-[12px] font-extrabold text-white">C</span>
            <div className="min-w-0">
              <div className="text-[15px] font-extrabold text-ink">Conversation</div>
              <div className="text-[12px] text-muted">Chat with the client · they reply from the Clients page</div>
            </div>
            <span className="ml-auto">
              <button type="button" onClick={close} title="Close" className="grid size-8 cursor-pointer place-items-center rounded-lg border border-rust-line bg-rust-soft p-0 text-rust">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
              </button>
            </span>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-[18px] py-4">
            {T.map((c, i) => {
              const isC = c.side === 'client'
              const mine = c.side === SIDE
              const av = isC ? { i: 'C', bg: '#3F9079' } : member(c.who)
              return (
                <div key={i} className="flex items-end gap-2" style={{ flexDirection: mine ? 'row-reverse' : 'row' }}>
                  <span className="grid size-[26px] flex-none place-items-center rounded-[7px] text-[9.5px] font-bold text-white" style={{ background: av.bg }}>
                    {av.i}
                  </span>
                  <div className="flex max-w-[82%] flex-col gap-1.5" style={{ alignItems: mine ? 'flex-end' : 'flex-start' }}>
                    <div className="rounded-[14px] px-3 py-2.5" style={{ background: isC ? '#EEF7F3' : '#F3F0FC', boxShadow: `inset 0 0 0 1.5px ${isC ? '#D6E9E2' : '#DCD3F5'}` }}>
                      <div className="flex gap-2 text-[11.5px] font-bold" style={{ color: isC ? '#195040' : '#3F2E94' }}>
                        {c.who}
                        <span className="font-medium text-muted">{c.when}</span>
                      </div>
                      {c.text && <div className="mt-[3px] whitespace-pre-wrap text-[14px] leading-normal text-ink">{c.text}</div>}
                    </div>
                    {c.files?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5" style={{ justifyContent: mine ? 'flex-end' : 'flex-start' }}>
                        {c.files.map((f, j) => (
                          <a key={f.name + j} href={f.url || undefined} target="_blank" rel="noreferrer" download={f.name} className="inline-flex max-w-[240px] items-center gap-2 rounded-[9px] bg-white px-2 py-1.5 text-ink no-underline shadow-[inset_0_0_0_1.5px_#D6DEE8]">
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
            {!T.some(c => c.side === 'client') && (
              <div className="rounded-[10px] border-[1.5px] border-dashed border-[#F0D58A] bg-[#FDF8EC] p-2.5 text-center text-[12.5px] font-semibold text-amber-ink">
                Waiting for the client to answer
              </div>
            )}
            <div ref={end} />
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
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
                </svg>
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
                    sendMsg()
                  }
                }}
                rows={2}
                placeholder="Message the client…"
                className="flex-1 resize-none rounded-xl border-[1.5px] border-line px-3 py-[9px] text-[14px] leading-[1.45] text-ink outline-0"
              />
              <button type="button" onClick={sendMsg} className="h-[38px] flex-none cursor-pointer rounded-[10px] border-0 bg-purple px-4 text-[13.5px] font-bold text-white" style={{ opacity: ok ? 1 : 0.45 }}>
                Send
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
