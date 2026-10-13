import { useEffect, useState, type ReactNode } from 'react'
import { useActorName, useActorSend, useIsClient, useScopedRequests, useScopedWorkspace } from '../../state/access'
import { Markdown } from '../../components/Markdown'
import { Avatar, Backdrop, CloseButton, CountPill, Icon, Label, PATHS, TabButton } from '../../components/ui'
import { diff, fmt, TODAY } from '../../lib/dates'
import { PRIO, REQUEST_STATUS } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { useOverlay, useUi } from '../../state/ui'
import { rh } from '../../domain/tasks'

const FLOW = ['Open', 'In progress', 'Done'] as const

const lockIcon = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d={PATHS.lock} />
  </svg>
)

/** A DevOps request linked to this project. Managed by DevOps; the team can only add comments here, and clients only read it. */
export function RequestDrawer({ id }: { id: number }) {
  const person = usePerson()
  const r = (useScopedRequests() ?? []).find(x => x.id === id)
  const ws = useScopedWorkspace()!
  const ui = useUi()
  const send = useActorSend()
  const me = useActorName()
  const isClient = useIsClient()
  const overlay = useOverlay()
  const [tab, setTab] = useState<'ov' | 'act'>('ov')
  const [draft, setDraft] = useState('')
  const close = () => overlay.close('request')

  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  if (!r) return null
  const st = r.status || 'Open'
  const ci = FLOW.indexOf(st)
  const [stC, stBg] = REQUEST_STATUS[st] || REQUEST_STATUS.Open
  const [pC, pBg] = PRIO[r.prio] || PRIO.Medium
  const lg = (r.logs || []).reduce((a, x) => a + x.h, 0)
  const en = parseFloat(r.est || '') || 0
  const dd = r.due ? diff(r.due, TODAY) : null
  const late = dd != null && dd < 0 && st !== 'Done'
  const over = en > 0 && lg > en
  const a = r.to ? person(r.to) : { i: 'D', bg: '#9F89E5' }
  const raisedVal = r.raised ? fmt(r.raised) : r.when
  const raisedSub = r.raised
    ? (x => (x === 0 ? 'Today' : x + ' day' + (x > 1 ? 's' : '') + ' ago') + ' · by ' + r.by)(diff(TODAY, r.raised))
    : 'by ' + r.by
  const hist = [...(r.history || []), { by: r.by, text: 'raised this ticket', when: r.when }]
  const comments = r.comments || []
  const epicName = ws.epics.find(e => e.id === ui.epic)?.name

  const post = () => {
    const t = draft.trim()
    if (!t || isClient) return
    send({ type: 'request.comment', id: r.id, comment: { by: me, text: t, when: 'just now', side: 'tickets' } })
    setDraft('')
  }

  const box = 'flex min-w-0 flex-col gap-1.5 rounded-xl bg-white px-3.5 py-3 shadow-[0_0_0_1.5px_#C9D2DD]'
  const row = (label: string, value: ReactNode, first = false) => (
    <div className={`flex min-h-[46px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3 ${first ? '' : 'border-t-[1.5px] border-line'}`}>
      <span className="text-[13px] text-ink-2">{label}</span>
      {value}
    </div>
  )
  const chip = (v: string, bg: string, c: string) => (
    <span className="inline-flex max-w-[160px] items-center gap-1.5 truncate whitespace-nowrap rounded-md py-1 pl-2 pr-2.5 text-[12px] font-bold" style={{ background: bg, color: c }}>
      {v}
    </span>
  )
  const mono = (v: string, color?: string) => (
    <span className="tnum text-[12.5px] font-semibold" style={{ color }}>
      {v}
    </span>
  )

  return (
    <>
      <Backdrop onClick={close} z={60} />
      <aside className="fixed bottom-3 right-3 top-3 z-[61] flex w-[min(1080px,calc(100vw-24px))] animate-pop-in overflow-hidden rounded-[28px] border-[1.5px] border-line bg-white shadow-[0_30px_90px_rgba(27,45,69,0.25)]">
        <CloseButton onClick={close} className="absolute right-4 top-4 z-[5]" />
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pb-8 pt-[18px]">
          <button type="button" onClick={close} className="inline-flex h-7 cursor-pointer items-center gap-1.5 self-start rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink">
            <Icon d={PATHS.back} size={13} sw={2.6} />
            Back to board
          </button>
          <div className="mt-3 flex flex-wrap items-center gap-2 pr-11">
            <span className="tnum rounded-md bg-sky-2 px-2 py-[3px] text-[12px] font-semibold text-blue-ink">{r.rkey}</span>
            <span className="text-[12.5px] text-ink-2">
              DevOps request · {r.pname} · {epicName}
            </span>
            <span className="inline-flex items-center gap-[5px] text-[12px] font-semibold text-muted">
              {lockIcon}
              Managed by DevOps
            </span>
          </div>
          <div className="mt-2 text-[22px] font-bold leading-[1.3] tracking-[-0.015em] text-ink">{r.text}</div>
          <div className="mt-4 rounded-2xl border-[1.5px] border-line bg-canvas px-4 py-3.5">
            <div className="flex gap-1">
              {FLOW.map((n, i) => (
                <div key={n} className="flex flex-1 flex-col gap-1.5">
                  <span className="h-[5px] rounded-[3px]" style={{ background: i <= ci ? (st === 'Done' ? '#3F9079' : '#4870E8') : '#DDE3E8' }} />
                  <span className="text-[12px]" style={{ fontWeight: i === ci ? 700 : 500, color: i === ci ? '#1B2D45' : '#3B4A5E' }}>
                    {n}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-3.5 grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr)' }}>
              <div className={box}>
                <Label>Raised</Label>
                <span className="truncate text-[16px] font-bold text-ink">{raisedVal}</span>
                <span className="truncate text-[12px] font-semibold text-muted">{raisedSub}</span>
              </div>
              <div className={box}>
                <Label>Due</Label>
                <span className="text-[16px] font-bold" style={{ color: late ? '#C0392B' : '#1B2D45' }}>
                  {r.due ? fmt(r.due) : 'Not set'}
                </span>
                <span
                  className="inline-flex h-[22px] items-center self-start rounded-md px-[9px] text-[12px] font-bold"
                  style={{ background: late ? '#F6DDD0' : '#DCE5FA', color: late ? '#7A3818' : '#1F3FAF' }}
                >
                  {r.due && dd != null ? (late ? -dd + 'd overdue' : dd === 0 ? 'Today' : 'in ' + dd + 'd') : 'No date yet'}
                </span>
              </div>
              <div className={box}>
                <Label>Time</Label>
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[16px] font-bold" style={{ color: over ? '#A5502C' : '#1B2D45' }}>
                    {lg ? rh(lg) : '0h'}
                  </span>
                  <span className="text-[13px] font-semibold text-muted">{en ? 'of ' + en + 'h estimate' : 'no estimate'}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-[3px] bg-sky-2">
                  <div className="h-full" style={{ width: (en ? Math.min(100, Math.round((lg / en) * 100)) : lg ? 100 : 0) + '%', background: over ? '#D2724A' : '#3F9079' }} />
                </div>
                <span className="text-[12px] font-semibold" style={{ color: over ? '#A5502C' : '#3B4A5E' }}>
                  {over ? rh(lg - en) + ' over estimate' : en ? rh(en - lg) + ' left' : 'Not estimated yet'}
                </span>
              </div>
              <div className={box}>
                <Label>Assignee</Label>
                <div className="flex items-center gap-2">
                  <Avatar i={a.i} bg={a.bg} size={28} radius={7} font={11} className="!font-bold" />
                  <span className="truncate text-[14px] font-bold text-ink">{r.to || 'DevOps team'}</span>
                </div>
                <span className="text-[12px] font-semibold text-muted">DevOps team</span>
              </div>
            </div>
          </div>
          <div className="mt-[18px] flex gap-6 shadow-[inset_0_-1.5px_0_#C9D2DD]">
            <TabButton on={tab === 'ov'} onClick={() => setTab('ov')}>
              Overview
              <CountPill n={comments.length} />
            </TabButton>
            <TabButton on={tab === 'act'} onClick={() => setTab('act')}>
              Activity
              <CountPill n={hist.length} />
            </TabButton>
          </div>
          {tab === 'ov' ? (
            <>
              <div className="mt-[18px] text-[15px] font-bold">Description</div>
              <div className="mt-2 text-[14.5px] leading-[1.65]" style={{ color: r.desc ? '#1B2D45' : '#3B4A5E' }}>
                {r.desc ? <Markdown src={r.desc} /> : 'No description added by DevOps yet.'}
              </div>
              <div className="mt-[22px] flex items-center gap-2 border-t-[1.5px] border-line pt-[18px]">
                <span className="text-[15px] font-bold">Comments</span>
                <span className="tnum text-[12px] text-ink-2">{comments.length}</span>
              </div>
              <div className="mt-2.5 flex flex-col gap-2">
                {comments.map((c, i) => {
                  const dv = c.side === 'devops'
                  const m = person(c.by)
                  return (
                    <div key={i} className="flex gap-2.5">
                      <Avatar i={m.i} bg={m.bg} size={28} radius={7} font={11} className="!font-bold" />
                      <div className="min-w-0 flex-1 rounded-xl border-[1.5px] border-line px-3 py-2.5 text-[14px] leading-normal" style={{ background: dv ? '#FFFFFF' : '#F6F9FC' }}>
                        <b>{c.by}</b>{' '}
                        <span className="rounded-[5px] px-1.5 py-px text-[11px] font-bold" style={{ background: dv ? '#E6DFFA' : '#DCE5FA', color: dv ? '#3F2E94' : '#1F3FAF' }}>
                          {dv ? 'DevOps' : 'Tickets'}
                        </span>{' '}
                        <span className="text-[12px] text-muted">· {c.when}</span>
                        <div className="mt-[3px]">{c.text}</div>
                      </div>
                    </div>
                  )
                })}
                {!comments.length && <div className="text-[13.5px] text-muted">No comments yet.</div>}
              </div>
              {!isClient && <div className="mt-3 rounded-[14px] border-[1.5px] border-line bg-canvas p-1">
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
                  placeholder="Write a comment to DevOps…"
                  className="w-full resize-y border-0 bg-transparent px-3 py-2.5 text-[14px] leading-normal text-ink outline-0"
                />
                <div className="flex items-center px-1.5 pb-1.5">
                  <span className="text-[12px] font-medium text-ink-2">Enter posts · Shift+Enter new line</span>
                  <button
                    type="button"
                    onClick={post}
                    className="ml-auto h-8 cursor-pointer rounded-lg border-0 bg-blue px-3.5 text-[13px] font-bold text-white"
                    style={{ opacity: draft.trim() ? 1 : 0.45 }}
                  >
                    Comment
                  </button>
                </div>
              </div>}
            </>
          ) : (
            <div className="mt-3 flex flex-col">
              {hist.map((h, i) => {
                const m = person(h.by)
                return (
                  <div key={i} className="flex gap-2.5 border-b-[1.5px] border-line-3 py-2.5 text-[13.5px] text-ink-2">
                    <Avatar i={m.i} bg={m.bg} size={24} radius={6} font={10} className="!font-bold" />
                    <span>
                      <b className="text-ink">{h.by}</b> {h.text} <span className="text-muted">· {h.when}</span>
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
        <div className="flex-[0_0_308px] overflow-y-auto border-l-[1.5px] border-line bg-canvas px-[18px] pb-7 pt-16">
          <div className="px-1 pb-2 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Ticket details</div>
          <div className="rounded-[14px] bg-white shadow-[0_0_0_1.5px_#C9D2DD]">
            {row('Status', chip(st, stBg, stC), true)}
            {row('Priority', chip(r.prio || 'Medium', pBg, pC))}
            {row('Type', chip(r.type, '#E6DFFA', '#3F2E94'))}
            {row(
              'Assignee',
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-bold text-ink">
                <Avatar i={a.i} bg={a.bg} size={22} radius={5} font={9.5} className="!font-bold" />
                {r.to || 'DevOps team'}
              </span>,
            )}
            {row(
              'Raised by',
              <span className="text-[12.5px] font-bold text-ink">
                {r.by} · {r.when}
              </span>,
            )}
          </div>
          <div className="px-1 pb-2 pt-6 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Dates</div>
          <div className="rounded-[14px] bg-white shadow-[0_0_0_1.5px_#C9D2DD]">
            <div className="flex min-h-[50px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3">
              <div>
                <div className="text-[13px] text-ink-2">Issue raised</div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">{raisedSub}</div>
              </div>
              {mono(raisedVal)}
            </div>
            {row('Start', mono(r.start ? fmt(r.start) : '—'))}
            {row('Due', mono(r.due ? fmt(r.due) : 'Not set'))}
            {row('Estimate', mono(en ? en + 'h' : '—'))}
            {row('Hours', mono(lg ? rh(lg) : '0h', over ? '#A5502C' : '#1B2D45'))}
          </div>
          <div className="flex items-center gap-1.5 px-1 pt-3.5 text-[12px] font-semibold text-muted">
            {lockIcon}
            Only comments can be added from Tickets
          </div>
        </div>
      </aside>
    </>
  )
}
