import { useEffect, useRef, useState } from 'react'
import { useSend } from '../../api/queries'
import type { ChatFile, Task } from '../../api/types'
import { Avatar, Icon, PATHS } from '../../components/ui'
import { readFiles } from '../../lib/files'
import { ME } from '../../lib/theme'
import { usePerson } from '../../state/page'

/**
 * The "Client chat" tab of a client-reported bug, seen by the team. It is the
 * same conversation the client has in their bug window on the Clients page.
 */
export function ClientChat({ bug }: { bug: Task }) {
  const send = useSend()
  const person = usePerson()
  const [draft, setDraft] = useState('')
  const [pend, setPend] = useState<ChatFile[]>([])
  const thread = bug.clientBug?.chat || []
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [thread.length])

  const ok = !!draft.trim() || pend.length > 0
  const post = () => {
    if (!ok) return
    send({ type: 'bug.message', id: bug.id, message: { who: ME, side: 'team', text: draft.trim(), when: 'just now', files: pend } })
    setDraft('')
    setPend([])
  }

  return (
    <div className="overflow-hidden rounded-[14px] border-[1.5px] border-line bg-canvas">
      <div className="flex items-center gap-2.5 border-b-[1.5px] border-line-2 bg-white px-3.5 py-3">
        <span className="grid size-7 place-items-center rounded-lg bg-green text-[11px] font-extrabold text-white">C</span>
        <div>
          <div className="text-[14px] font-extrabold text-ink">Chat with the client</div>
          <div className="text-[12px] text-muted">The client sees this on the Clients page</div>
        </div>
      </div>
      <div ref={box} className="flex max-h-[420px] flex-col gap-2.5 overflow-y-auto p-3.5">
        {thread.map((c, i) => {
          const isC = c.side === 'client'
          const av = isC ? { i: 'C', bg: '#3F9079' } : person(c.who)
          return (
            <div key={i} className="flex items-end gap-2" style={{ flexDirection: isC ? 'row' : 'row-reverse' }}>
              <Avatar i={av.i} bg={av.bg} size={26} radius={7} font={9.5} className="!font-bold" />
              <div className="flex max-w-[78%] flex-col gap-1.5" style={{ alignItems: isC ? 'flex-start' : 'flex-end' }}>
                <div
                  className="rounded-[14px] px-3 py-[9px]"
                  style={{ background: isC ? '#EEF7F3' : '#E7EEFB', boxShadow: `inset 0 0 0 1.5px ${isC ? '#D6E9E2' : '#DCE5FA'}` }}
                >
                  <div className="flex gap-2 text-[11.5px] font-bold" style={{ color: isC ? '#195040' : '#1F3FAF' }}>
                    {c.who}
                    <span className="font-medium text-muted">{c.when}</span>
                  </div>
                  {c.text && <div className="mt-[3px] whitespace-pre-wrap text-[14px] leading-normal text-ink">{c.text}</div>}
                </div>
                {c.files?.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {c.files.map((f, j) => (
                      <a
                        key={f.name + j}
                        href={f.url || undefined}
                        target="_blank"
                        rel="noreferrer"
                        download={f.name}
                        className="inline-flex h-[30px] items-center gap-1.5 rounded-lg bg-white px-2.5 text-[12.5px] font-semibold text-ink no-underline shadow-[inset_0_0_0_1.5px_#D6DEE8]"
                      >
                        <Icon d={PATHS.clip} size={16} sw={2.2} />
                        {f.name}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {!thread.length && <div className="p-4 text-center text-[13px] text-muted">No messages yet. Ask the client for more details about this bug.</div>}
      </div>
      <div className="border-t-[1.5px] border-line-2 bg-white px-3 py-2.5">
        {pend.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {pend.map((f, i) => (
              <span key={f.name + i} className="inline-flex h-7 items-center gap-1.5 rounded-[7px] bg-sky pl-[9px] pr-1.5 text-[12px] font-semibold">
                {f.name}
                <button type="button" onClick={() => setPend(p => p.filter((_, j) => j !== i))} className="cursor-pointer border-0 bg-transparent px-0.5 text-[15px]">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <label title="Attach files" className="grid size-[38px] flex-none cursor-pointer place-items-center rounded-[10px] bg-sky text-blue-ink">
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
                post()
              }
            }}
            rows={2}
            placeholder="Message the client…"
            className="flex-1 resize-none rounded-xl border-[1.5px] border-line px-3 py-[9px] text-[14px] leading-[1.45] text-ink outline-0"
          />
          <button
            type="button"
            onClick={post}
            className="h-[38px] flex-none cursor-pointer rounded-[10px] border-0 bg-blue px-4 text-[13.5px] font-bold text-white"
            style={{ opacity: ok ? 1 : 0.45 }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  )
}
