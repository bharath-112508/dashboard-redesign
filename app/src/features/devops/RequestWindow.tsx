import { useState, type ReactNode } from 'react'
import { useRequests, useSend } from '../../api/queries'
import type { DevopsRequest, Priority } from '../../api/types'
import { Markdown } from '../../components/Markdown'
import { DescriptionEditor } from '../ticket/DescriptionEditor'
import { focusField } from '../../lib/focusField'
import { useDv } from './ctx'
import { diffD, member, ownerColor, TODAY } from './model'
import { REQ_PRIO, REQ_STATUS } from './OtherTabs'

const FLOW = ['Open', 'In progress', 'Done'] as const
const TYPES = ['Deployment', 'Environment', 'Access', 'Bug in infra', 'Other']
const MONn = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fd = (iso?: string) => {
  if (!iso) return ''
  const [y, m, d] = iso.split('-')
  return +d + ' ' + MONn[+m - 1] + ' ' + y
}
const dif = (iso: string) => diffD(iso, TODAY)
const rh = (n: number) => Math.round(n * 10) / 10 + 'h'

const lockSvg = (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#3B4A5E" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V7a4 4 0 018 0v4" />
  </svg>
)
const plusSvg = (s = 10) => (
  <svg viewBox="0 0 24 24" width={s} height={s} fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round">
    <path d="M12 5v14M5 12h14" />
  </svg>
)
const chev = (
  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
    <path d="M6 9l6 6 6-6" />
  </svg>
)

/** A DevOps request (raised from Tickets), as the DevOps team works on it. */
export function RequestWindow({ id }: { id: number }) {
  const r = (useRequests().data ?? []).find(x => x.id === id)
  if (!r) return null
  return <Inner r={r} key={r.id} />
}

function Inner({ r }: { r: DevopsRequest }) {
  const { db, open, me } = useDv()
  const send = useSend()
  const [tab, setTab] = useState<'ov' | 'act'>('ov')
  const [editing, setEditing] = useState(false)
  const [cDraft, setCDraft] = useState('')
  const [asAll, setAsAll] = useState(false)
  const [est, setEst] = useState(r.est || '')
  const [hr, setHr] = useState(0)
  const [min, setMin] = useState(0)
  const back = () => open({ request: null }, true)
  const upd = (patch: Partial<DevopsRequest>, what?: string, addLog?: NonNullable<DevopsRequest['logs']>[number]) =>
    send({ type: 'request.update', id: r.id, patch, log: what ? { by: me, text: what } : undefined, ...(addLog ? { addLog } : {}) })
  const post = () => {
    const t = cDraft.trim()
    if (!t) return
    send({ type: 'request.comment', id: r.id, comment: { by: me, text: t, when: 'just now', side: 'devops' } })
    setCDraft('')
  }

  const st = r.status || 'Open'
  const ci = FLOW.indexOf(st)
  const nx = FLOW[ci + 1]
  const stc = REQ_STATUS[st] || REQ_STATUS.Open
  const pc = REQ_PRIO[r.prio] || REQ_PRIO.Medium
  const lg = (r.logs || []).reduce((a, x) => a + x.h, 0)
  const en = parseFloat(r.est || '') || 0
  const dd = r.due ? dif(r.due) : null
  const late = dd != null && dd < 0 && st !== 'Done'
  const over = !!en && lg > en
  const sd = r.start ? dif(r.start) : null
  const hist = [...(r.history || []), { by: r.by, text: 'raised this ticket', when: r.when }]
  const raisedVal = r.raised ? fd(r.raised) : r.when
  const raisedSub = r.raised
    ? (x => (x <= 0 ? 'Today' : x + ' day' + (x > 1 ? 's' : '') + ' ago') + ' · by ' + r.by)(-dif(r.raised))
    : 'by ' + r.by
  const A = r.to ? [r.to] : []
  const av = (n: string) => member(n)
  // The estimate locks once it is set (on blur), like the due date.
  const estLocked = !!r.est

  const statBox = 'flex min-w-0 flex-col gap-1.5 rounded-xl bg-white px-3.5 py-3 shadow-[0_0_0_1.5px_#C9D2DD]'
  const clickBox = statBox + ' cursor-pointer transition-shadow duration-150 hover:!shadow-[0_0_0_1.5px_#4870E8]'
  const lbl = 'text-[11px] font-bold uppercase tracking-[0.05em] text-muted'
  const sel = 'h-[30px] max-w-[150px] cursor-pointer appearance-none rounded-md border-0 pl-2.5 pr-6 text-[12px] font-semibold outline-0 shadow-[inset_0_0_0_1.5px_rgba(27,45,69,0.14)]'
  const row = (label: ReactNode, value: ReactNode, first = false, sub?: ReactNode) => (
    <div className={`flex min-h-[46px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3 ${first ? '' : 'border-t-[1.5px] border-line'}`}>
      {sub ? (
        <div className="min-w-0">
          <div className="text-[13px] text-ink-2">{label}</div>
          <div className="mt-px text-[11.5px] font-semibold">{sub}</div>
        </div>
      ) : (
        <span className="text-[13px] text-ink-2">{label}</span>
      )}
      {value}
    </div>
  )
  const dateRow = 'flex min-h-[50px] items-center justify-between gap-2.5 border-t-[1.5px] border-line px-3.5 py-1.5'
  const tnum = 'tnum font-sans text-[12.5px]'

  return (
    <>
      <div onClick={back} className="fixed inset-0 z-[60] bg-[rgba(27,45,69,0.38)]" />
      <aside
        data-testid="request-window"
        className="fixed bottom-3 right-3 top-3 z-[61] flex w-[min(1080px,calc(100vw-24px))] overflow-hidden rounded-[28px] border-[1.5px] border-line bg-white font-normal text-ink shadow-[0_30px_90px_rgba(27,45,69,0.25)]"
      >
        <button
          type="button"
          onClick={back}
          title="Close"
          className="absolute right-4 top-4 z-[5] grid size-8 cursor-pointer place-items-center rounded-lg border border-rust-line bg-rust-soft p-0 text-rust"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto px-8 pb-8 pt-[18px]">
          <button
            type="button"
            onClick={back}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 self-start rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink"
          >
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 6l-6 6 6 6" />
            </svg>
            Back to tickets
          </button>
          <div className="mt-3 flex items-center gap-1.5 pr-11">
            <span className="tnum rounded-md bg-sky-2 px-2 py-[3px] font-sans text-[12px] font-semibold text-blue-ink">{r.rkey}</span>
            <span className="text-[12px] text-ink-2">Request from Tickets · {r.pname}</span>
          </div>
          <div className="mt-2 text-[22px] font-bold leading-[1.3] tracking-[-0.015em] text-ink">{r.text}</div>

          <div className="mt-4 rounded-2xl border-[1.5px] border-line bg-canvas px-4 py-3.5">
            <div className="flex items-center gap-2.5">
              <div className="flex min-w-[220px] flex-1 gap-1">
                {FLOW.map((n, i) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => n !== st && upd({ status: n }, 'changed status to ' + n)}
                    className="flex flex-1 cursor-pointer flex-col gap-1.5 border-0 bg-transparent p-0 text-left"
                  >
                    <span className="h-[5px] rounded-[3px]" style={{ background: i <= ci ? (st === 'Done' ? '#3F9079' : '#4870E8') : '#DDE3E8' }} />
                    <span className="text-[12px]" style={{ fontWeight: i === ci ? 700 : 500, color: i === ci ? '#1B2D45' : '#3B4A5E' }}>
                      {n}
                    </span>
                  </button>
                ))}
              </div>
              {nx ? (
                <button
                  type="button"
                  onClick={() => upd({ status: nx }, 'changed status to ' + nx)}
                  className="h-[34px] cursor-pointer rounded-[10px] border-0 bg-blue px-3.5 text-[13px] font-bold text-white"
                >
                  Move to {nx} →
                </button>
              ) : (
                <span className="inline-flex h-[34px] items-center rounded-[10px] bg-green-soft px-3 text-[13px] font-bold text-green-ink">✓ Done</span>
              )}
            </div>
            <div className="mt-3.5 grid gap-2" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) minmax(0,1.5fr) minmax(0,1fr)' }}>
              <div className={statBox}>
                <span className={lbl}>Raised</span>
                <span className="truncate text-[16px] font-bold text-ink">{raisedVal}</span>
                <span className="truncate text-[12px] font-semibold text-muted">{raisedSub}</span>
              </div>
              <div onClick={() => !r.due && focusField('rq-due')} className={clickBox}>
                <span className={lbl}>Due</span>
                <span className="truncate text-[16px] font-bold" style={{ color: late ? '#C0392B' : '#1B2D45' }}>
                  {r.due ? fd(r.due) : 'Not set'}
                </span>
                <span
                  className="inline-flex h-[22px] items-center self-start rounded-md px-[9px] text-[12px] font-bold"
                  style={{ background: late ? '#F6DDD0' : r.due ? '#DCE5FA' : '#E7EEFB', color: late ? '#7A3818' : r.due ? '#1F3FAF' : '#3B4A5E' }}
                >
                  {r.due && dd != null ? (late ? -dd + 'd overdue' : dd === 0 ? 'Today' : 'in ' + dd + 'd') : 'Add date'}
                </span>
              </div>
              <div onClick={() => focusField('rq-log')} className={clickBox}>
                <div className="flex items-center gap-2">
                  <span className={lbl}>Time</span>
                  <span className="ml-auto inline-flex h-[22px] items-center gap-[5px] rounded-md bg-sky-2 px-2 text-[12px] font-bold text-blue-ink">
                    {plusSvg()}Log
                  </span>
                </div>
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <span className="text-[16px] font-bold" style={{ color: over ? '#A5502C' : '#1B2D45' }}>
                    {lg ? rh(lg) : '0h'}
                  </span>
                  <span className="whitespace-nowrap text-[13px] font-semibold text-muted">{en ? 'of ' + en + 'h estimate' : 'no estimate'}</span>
                </div>
                <div className="flex h-1.5 overflow-hidden rounded-[3px] bg-sky-2">
                  <span
                    className="h-full rounded-[3px]"
                    style={{ width: (en ? Math.min(100, Math.round((lg / en) * 100)) : lg ? 100 : 0) + '%', background: over ? '#D2724A' : '#3F9079' }}
                  />
                </div>
                <span className="truncate text-[12px] font-semibold" style={{ color: over ? '#A5502C' : '#3B4A5E' }}>
                  {over ? rh(lg - en) + ' over estimate' : en ? rh(en - lg) + ' left' : 'Set an estimate'}
                </span>
              </div>
              <div className={statBox + ' relative'}>
                <span className={lbl}>{A.length > 1 ? 'Assignees' : 'Assignee'}</span>
                <div onClick={() => focusField('rq-to')} title="Edit assignees" className="flex min-h-7 cursor-pointer items-center">
                  {A.length ? (
                    A.slice(0, 4).map(n => (
                      <span
                        key={n}
                        title={n}
                        className="-mr-1.5 grid size-7 place-items-center rounded-[7px] text-[11px] font-bold text-white shadow-[0_0_0_2px_#fff]"
                        style={{ background: av(n).bg }}
                      >
                        {av(n).i}
                      </span>
                    ))
                  ) : (
                    <span title="Unassigned" className="grid size-7 place-items-center rounded-[7px] bg-white text-[11px] font-bold text-muted shadow-[0_0_0_2px_#fff,inset_0_0_0_1.5px_#A9B6C5]">
                      +
                    </span>
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
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.8" strokeLinecap="round" style={{ transform: `rotate(${asAll ? '180deg' : '0deg'})` }}>
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>
                {asAll && (
                  <>
                    <div onClick={() => setAsAll(false)} className="fixed inset-0 z-[58]" />
                    <div className="absolute right-0 top-[calc(100%+6px)] z-[59] w-[250px] rounded-[14px] bg-white p-1.5 shadow-[0_14px_40px_rgba(27,45,69,0.18),0_0_0_1.5px_#C9D2DD]">
                      <div className="px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">People on this ticket</div>
                      {(A.length ? A.map(n => ({ name: n, ...av(n), role: 'Assignee · primary' })) : [{ name: 'Nobody assigned', i: '–', bg: '#A9B6C5', role: 'Use Edit assignees' }]).map(x => (
                        <div key={x.name} className="flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] hover:bg-sky">
                          <span className="grid size-7 flex-none place-items-center rounded-[7px] text-[11px] font-bold text-white" style={{ background: x.bg }}>
                            {x.i}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13.5px] font-semibold text-ink">{x.name}</span>
                            <span className="block text-[11.5px] font-semibold text-muted">{x.role}</span>
                          </span>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => {
                          setAsAll(false)
                          focusField('rq-to')
                        }}
                        className="mt-1 h-8 w-full cursor-pointer rounded-lg border-0 bg-sky text-[12.5px] font-bold text-blue-ink"
                      >
                        Edit assignees
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="mt-[18px] flex gap-6 shadow-[inset_0_-1.5px_0_#C9D2DD]">
            {(
              [
                ['ov', 'Overview', (r.comments || []).length],
                ['act', 'Activity', hist.length],
              ] as const
            ).map(([k, label, n]) => {
              const on = tab === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setTab(k)}
                  className="inline-flex cursor-pointer items-center gap-[7px] border-0 bg-transparent px-0 pb-3 pt-0 text-[14px]"
                  style={{ fontWeight: on ? 700 : 500, color: on ? '#1B2D45' : '#3B4A5E', boxShadow: `inset 0 -2px 0 ${on ? '#4870E8' : 'transparent'}` }}
                >
                  {label}
                  <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-sky-2 px-[5px] text-[11px] font-semibold text-blue-ink">{n}</span>
                </button>
              )
            })}
          </div>

          {tab === 'ov' ? (
            <>
              <div className="mt-[18px]">
                <div className="mb-2 flex items-center">
                  <span className="text-[15px] font-bold">Description</span>
                  {!editing && (
                    <button type="button" onClick={() => setEditing(true)} className="ml-auto cursor-pointer border-0 bg-transparent p-0 text-[13px] font-semibold text-blue-ink">
                      Edit
                    </button>
                  )}
                </div>
                {editing ? (
                  <DescriptionEditor
                    initial={r.desc || ''}
                    onCancel={() => setEditing(false)}
                    onImage={() => {}}
                    onSave={v => {
                      if (v !== (r.desc || '')) upd({ desc: v }, 'updated the description')
                      setEditing(false)
                    }}
                  />
                ) : (
                  <div
                    onClick={() => setEditing(true)}
                    className="-mx-2.5 cursor-text whitespace-pre-wrap rounded-[10px] px-2.5 py-1.5 text-[14.5px] leading-[1.65] hover:bg-canvas"
                    style={{ color: r.desc ? '#1B2D45' : '#3B4A5E' }}
                  >
                    {r.desc ? <Markdown src={r.desc} /> : 'No description yet. Add what DevOps needs to know.'}
                  </div>
                )}
              </div>
              <div className="mt-[22px] border-t-[1.5px] border-line pt-[18px] text-[15px] font-bold">Comments</div>
              <div className="mt-2.5 flex flex-col gap-2">
                {(r.comments || []).map((c, i) => (
                  <div key={i} className="rounded-xl border-[1.5px] border-line bg-canvas px-3 py-2.5 text-[14px] leading-normal">
                    <b>{c.by}</b> <span className="text-[12px] text-muted">· {c.when}</span>
                    <div className="mt-[3px]">{c.text}</div>
                  </div>
                ))}
                {!(r.comments || []).length && <div className="text-[13.5px] text-muted">No replies yet.</div>}
              </div>
              <div className="mt-2.5 flex gap-2">
                <input
                  value={cDraft}
                  onChange={e => setCDraft(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      post()
                    }
                  }}
                  placeholder="Reply to the team…"
                  className="h-10 flex-1 rounded-[10px] border-[1.5px] border-line bg-white px-3 text-[14px] text-ink outline-0"
                />
                <button type="button" onClick={post} className="h-10 cursor-pointer rounded-[10px] border-0 bg-blue px-4 text-[13.5px] font-bold text-white">
                  Send
                </button>
              </div>
            </>
          ) : (
            <div className="mt-3.5 flex flex-col">
              {hist.map((a, i) => (
                <div key={i} className="flex gap-2.5 border-b-[1.5px] border-line-3 py-[9px] text-[13.5px] text-ink-2">
                  <span className="grid size-6 flex-none place-items-center rounded-md text-[10px] font-semibold text-white" style={{ background: ownerColor(a.by) === '#A9B6C5' ? '#56657A' : ownerColor(a.by) }}>
                    {(a.by || '?')[0]}
                  </span>
                  <span>
                    <b className="text-ink">{a.by}</b> {a.text} <span className="text-muted">· {a.when}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-[0_0_308px] overflow-y-auto border-l-[1.5px] border-line bg-canvas px-[18px] pb-7 pt-16">
          <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">Ticket details</div>
          <div className="rounded-[14px] bg-white shadow-[0_0_0_1.5px_#C9D2DD]">
            {row(
              'Status',
              <span className="inline-flex items-center gap-1.5 rounded-md py-1 pl-2 pr-2.5 text-[12px] font-bold" style={{ background: stc[1], color: stc[0] }}>
                <span className="size-1.5 rounded-full" style={{ background: stc[0] }} />
                {st}
              </span>,
              true,
            )}
            {row(
              'Priority',
              <span className="relative inline-flex">
                <select
                  value={r.prio || 'Medium'}
                  onChange={e => upd({ prio: e.target.value as Priority }, 'set priority to ' + e.target.value)}
                  className={sel}
                  style={{ background: pc[1], color: pc[0] }}
                >
                  {['Low', 'Medium', 'High', 'Urgent'].map(v => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                {chev}
              </span>,
            )}
            {row(
              'Type',
              <span className="relative inline-flex">
                <select value={r.type} onChange={e => upd({ type: e.target.value }, 'changed type to ' + e.target.value)} className={sel} style={{ background: '#E6DFFA', color: '#3F2E94' }}>
                  {TYPES.map(v => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                {chev}
              </span>,
            )}
            {row(
              'Assignee',
              <span className="inline-flex items-center gap-1.5">
                <span className="grid size-[22px] place-items-center rounded-[5px] text-[9.5px] font-semibold text-white" style={{ background: r.to ? ownerColor(r.to) : '#A9B6C5' }}>
                  {r.to ? r.to[0] : '+'}
                </span>
                <span className="relative inline-flex">
                  <select
                    id="rq-to"
                    value={r.to || ''}
                    onChange={e => {
                      const v = e.target.value
                      upd({ to: v }, v ? 'assigned it to ' + v : 'unassigned it')
                    }}
                    className={sel}
                    style={{ background: '#EEF3FB', color: '#1B2D45' }}
                  >
                    <option value="">Unassigned</option>
                    {db.settings.people.map(v => (
                      <option key={v} value={v}>
                        {v}
                      </option>
                    ))}
                  </select>
                  {chev}
                </span>
              </span>,
            )}
            {row(
              'Raised by',
              <span className="text-[12.5px] font-semibold text-ink">
                {r.by} · {r.when}
              </span>,
            )}
          </div>
          <div className="px-1 pb-2 pt-6 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">Dates</div>
          <div className="rounded-[14px] bg-white px-3.5 pb-3.5 pt-4 shadow-[0_0_0_1.5px_#C9D2DD]">
            <div className="text-[12px] text-ink-2">Due date</div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-2">
              <span className="text-[24px] font-bold tracking-[-0.02em]" style={{ color: late ? '#A5502C' : r.due ? '#1B2D45' : '#3B4A5E' }}>
                {r.due ? fd(r.due) : 'No due date'}
              </span>
              <span className="text-[12px] font-semibold" style={{ color: late ? '#A5502C' : r.due ? '#1B2D45' : '#3B4A5E' }}>
                {r.due && dd != null ? (late ? -dd + ' days overdue' : dd === 0 ? 'Today' : 'In ' + dd + ' days') : ''}
              </span>
            </div>
          </div>
          <div className="mt-2.5 rounded-[14px] bg-white shadow-[0_0_0_1.5px_#C9D2DD]">
            <div className="flex min-h-[50px] items-center justify-between gap-2.5 px-3.5 py-1.5">
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Issue raised</div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">{raisedSub}</div>
              </div>
              <span className={`${tnum} font-semibold text-ink`}>{raisedVal}</span>
            </div>
            <div className={dateRow}>
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Start</div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">
                  {r.start && sd != null ? (sd === 0 ? 'Today' : sd > 0 ? 'in ' + sd + ' days' : -sd + ' days ago') : 'Not set'}
                </div>
              </div>
              <input
                type="date"
                value={r.start || ''}
                onChange={e => {
                  const v = e.target.value
                  upd({ start: v }, v ? 'set start date to ' + fd(v) : 'cleared the start date')
                }}
                className={`${tnum} border-0 bg-transparent text-right text-ink outline-0`}
              />
            </div>
            <div className={dateRow}>
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Due</div>
                <div className="mt-px text-[11.5px] font-semibold" style={{ color: late ? '#A5502C' : '#3B4A5E' }}>
                  {r.due && dd != null ? 'Fixed · ' + (late ? -dd + ' days overdue' : dd === 0 ? 'Today' : 'in ' + dd + ' days') : 'Not set'}
                </div>
              </div>
              {r.due ? (
                <span className={`${tnum} inline-flex items-center gap-1.5 font-semibold text-ink`}>
                  {lockSvg}
                  {fd(r.due)}
                </span>
              ) : (
                <input
                  id="rq-due"
                  type="date"
                  value=""
                  onChange={e => {
                    const v = e.target.value
                    if (v) upd({ due: v }, 'set due date to ' + fd(v))
                  }}
                  className={`${tnum} border-0 bg-transparent text-right text-ink outline-0`}
                />
              )}
            </div>
            <div className={dateRow}>
              <div className="min-w-0">
                <div className="text-[13px] text-ink-2">Estimate</div>
                <div className="mt-px text-[11.5px] font-semibold" style={{ color: en && lg > en ? '#A5502C' : '#3B4A5E' }}>
                  {!en ? 'Not set' : lg > en ? lg - en + ' hours over' : en - lg + 'h left'}
                </div>
              </div>
              {estLocked ? (
                <span className={`${tnum} inline-flex items-center gap-1.5 font-semibold text-ink`}>
                  {lockSvg}
                  {r.est}h
                </span>
              ) : (
                <span className="inline-flex items-center gap-1">
                  <input
                    id="rq-est"
                    value={est}
                    onChange={e => setEst(e.target.value)}
                    onBlur={() => est.trim() && upd({ est: est.trim() }, 'set estimate to ' + est.trim() + 'h')}
                    placeholder="e.g. 4"
                    className={`${tnum} w-[60px] border-0 bg-transparent text-right text-ink outline-0`}
                  />
                  <span className="text-[12px] text-muted">h</span>
                </span>
              )}
            </div>
            <div className={dateRow}>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-[13px] text-ink-2">
                  Hours
                  <span onClick={() => focusField('rq-log')} title="Log hours" className="inline-grid size-[18px] cursor-pointer place-items-center rounded-[5px] bg-blue align-middle text-white">
                    {plusSvg()}
                  </span>
                </div>
                <div className="mt-px text-[11.5px] font-semibold text-muted">{(r.logs || []).length ? (r.logs || []).length + ' entries' : 'Nothing logged yet'}</div>
              </div>
              <span className={`${tnum} text-[13px] font-semibold`} style={{ color: en && lg > en ? '#A5502C' : '#1B2D45' }}>
                {lg ? lg + 'h' : '0h'}
              </span>
            </div>
            <div data-fx="1" className="flex items-center gap-2 rounded-b-[14px] border-t-[1.5px] border-line bg-canvas px-3.5 py-2.5">
              <span className="flex-1 text-[13px] font-semibold text-ink">Log time</span>
              <span className="relative inline-flex">
                <select
                  id="rq-log"
                  aria-label="Hours"
                  value={String(hr)}
                  onChange={e => setHr(+e.target.value)}
                  className="tnum h-8 cursor-pointer appearance-none rounded-lg border-[1.5px] border-line bg-white pl-[9px] pr-[22px] font-sans text-[13px] font-semibold text-ink outline-0"
                >
                  {Array.from({ length: 25 }, (_, i) => (
                    <option key={i} value={i}>
                      {i}h
                    </option>
                  ))}
                </select>
                {chev}
              </span>
              <span className="relative inline-flex">
                <select
                  aria-label="Minutes"
                  value={String(min)}
                  onChange={e => setMin(+e.target.value)}
                  className="tnum h-8 cursor-pointer appearance-none rounded-lg border-[1.5px] border-line bg-white pl-[9px] pr-[22px] font-sans text-[13px] font-semibold text-ink outline-0"
                >
                  {[0, 5, 10, 15, 30, 45].map(m => (
                    <option key={m} value={m}>
                      {m}m
                    </option>
                  ))}
                </select>
                {chev}
              </span>
              <button
                type="button"
                onClick={() => {
                  const v = Math.round((hr + min / 60) * 100) / 100
                  if (!v) return
                  const l = ((hr ? hr + 'h' : '') + (min ? ' ' + min + 'm' : '')).trim()
                  const entry = { h: v, by: me, when: 'just now', date: TODAY }
                  upd({ logs: [...(r.logs || []), entry] }, 'logged ' + l, entry)
                  setHr(0)
                  setMin(0)
                }}
                className="h-8 cursor-pointer rounded-lg border-0 bg-blue px-3 text-[12.5px] font-bold text-white"
              >
                Add
              </button>
            </div>
          </div>
          {(r.logs || []).length > 0 && (
            <div className="mt-2.5 rounded-[14px] bg-white px-3.5 py-2 shadow-[0_0_0_1.5px_#C9D2DD]">
              {(r.logs || [])
                .slice()
                .reverse()
                .map((l, i) => (
                  <div key={i} className="flex justify-between py-[5px] text-[12.5px] text-ink-2">
                    <span>
                      {l.by} · {l.when}
                    </span>
                    <span className="tnum font-sans font-semibold text-ink">{l.h}h</span>
                  </div>
                ))}
            </div>
          )}
        </div>
      </aside>
    </>
  )
}
