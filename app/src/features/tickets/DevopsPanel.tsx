import { useState } from 'react'
import { useRequests, useSend, useWorkspace } from '../../api/queries'
import type { DevopsRequest, Priority } from '../../api/types'
import { Icon, PATHS, Scrim } from '../../components/ui'
import { TODAY } from '../../lib/dates'
import { devopsTone, ME, PRIO } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { useOverlay } from '../../state/ui'
import { Caret } from '../ticket/PillDropdown'

const LADDER = ['Waiting for client', 'Reminder 1', 'Reminder 2', 'Reminder 3', 'Inform Marcus', 'Escalate']
const REQ_TYPES = ['Deployment', 'Environment', 'Access', 'Bug in infra', 'Other']
const TYPE_DOT: Record<string, string> = { Deployment: '#4870E8', Environment: '#3E908F', Access: '#B98A2F', 'Bug in infra': '#D2724A', Other: '#9F89E5' }
const REQ_PRIOS: Priority[] = ['Low', 'Medium', 'High', 'Urgent', 'Critical']
/** People a DevOps request can be tagged to. */
const TEAM = ['Rahul', 'Chary', 'Vivek', 'Ganesh', 'Raj']
const STATUS_C: Record<string, string> = { Open: '#7A5C0E', 'In progress': '#1F3FAF', Done: '#195040' }

/** DevOps replies and status changes the team hasn't seen yet. */
export const unreadOf = (r: DevopsRequest) =>
  Math.max(0, r.comments.filter(c => c.side === 'devops').length - (r.seenT || 0)) + ((r.status || 'Open') !== (r.statusSeen || 'Open') ? 1 : 0)

/** Marks a request as read and opens it. */
export const useOpenRequest = () => {
  const send = useSend()
  const overlay = useOverlay()
  return (r: DevopsRequest) => {
    if (unreadOf(r) > 0)
      send({
        type: 'request.update',
        id: r.id,
        patch: { seenT: r.comments.filter(c => c.side === 'devops').length, statusSeen: r.status || 'Open' },
      })
    overlay.open('request', r.id)
  }
}

type Draft = { type: string; prio: Priority; to: string; text: string }

/** The DevOps button in the epic bar and its panel: project status and requests to the DevOps team. */
export function DevopsPanel({ epic, epicName }: { epic: string; epicName: string }) {
  const ws = useWorkspace().data!
  const requests = useRequests().data ?? []
  const send = useSend()
  const person = usePerson()
  const openRequest = useOpenRequest()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'status' | 'req'>('status')
  const [form, setForm] = useState(false)
  const [dd, setDd] = useState<string | null>(null)
  const [rq, setRq] = useState<Draft>({ type: 'Deployment', prio: 'Medium', to: '', text: '' })

  const p = ws.devops.find(x => x.key === ws.devopsLinks[epic]) || ws.devops[0]
  const [c, bg, dot] = devopsTone(p.infra)
  const reqs = requests.filter(r => r.key === p.key)
  const unread = reqs.reduce((a, r) => a + unreadOf(r), 0)

  const sendReq = () => {
    const text = rq.text.trim()
    if (!text) return
    const id = Math.max(0, ...requests.map(r => r.id)) + 1
    send({
      type: 'request.create',
      request: {
        id,
        key: p.key,
        pname: p.name,
        rkey: 'REQ-' + (requests.length + 1),
        type: rq.type,
        prio: rq.prio,
        to: rq.to || p.owner || '',
        text,
        by: ME,
        when: 'just now',
        raised: TODAY,
        status: 'Open',
        comments: [],
      },
    })
    setRq({ ...rq, text: '' })
    setForm(false)
  }

  const rows: { label: string; value: string; tone: [string, string, string] }[] = [
    { label: 'Status', value: p.infra, tone: devopsTone(p.infra) },
    { label: 'Deployment', value: p.deploy || '—', tone: devopsTone(p.deploy || '') },
    { label: 'Est. deployment', value: p.due || 'Not set', tone: ['#1B2D45', '#EEF3FB', '#4870E8'] },
  ]
  const step = p.step ?? null

  const pc = PRIO[rq.prio] || PRIO.Medium
  const toM = rq.to ? person(rq.to) : null
  const pickers = [
    {
      k: 'type',
      label: 'Type',
      value: rq.type,
      tone: ['#3F2E94', '#E6DFFA', TYPE_DOT[rq.type] || '#9F89E5'],
      menu: REQ_TYPES.map(v => ({ v, label: v, dot: TYPE_DOT[v] })),
      set: (v: string) => setRq({ ...rq, type: v }),
      cur: rq.type,
    },
    {
      k: 'prio',
      label: 'Priority',
      value: rq.prio,
      tone: [pc[0], pc[1], pc[0]],
      menu: REQ_PRIOS.map(v => ({ v, label: v, dot: v === 'Critical' ? '#C0392B' : PRIO[v][0] })),
      set: (v: string) => setRq({ ...rq, prio: v as Priority }),
      cur: rq.prio,
    },
    {
      k: 'to',
      label: 'Tag',
      value: rq.to ? '@' + rq.to : p.owner ? p.owner + ' (owner)' : 'Anyone',
      tone: ['#1B2D45', '#EEF3FB', toM ? toM.bg : '#A9B6C5'],
      menu: [{ v: '', label: p.owner ? p.owner + ' (owner)' : 'Anyone', dot: '#A9B6C5' }, ...TEAM.map(v => ({ v, label: '@' + v, dot: person(v).bg }))],
      set: (v: string) => setRq({ ...rq, to: v }),
      cur: rq.to,
    },
  ]

  const tabs: ['status' | 'req', string, string][] = [
    ['status', 'Status', '·'],
    ['req', 'Tickets', unread ? unread + ' new' : String(reqs.length)],
  ]

  return (
    <span className="relative order-[99] ml-auto inline-flex">
      {unread > 0 && (
        <span className="pointer-events-none absolute -right-[7px] -top-[7px] z-[2] inline-flex h-5 min-w-5 items-center justify-center rounded-[10px] bg-[#D2724A] px-1.5 text-[11px] font-bold text-white shadow-[0_0_0_2px_#F6F9FC]">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 pl-3 pr-2.5 text-[13.5px] font-semibold"
        style={{
          background: bg,
          color: c,
          boxShadow: open ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1.5px rgba(27,45,69,0.12)',
        }}
        onMouseEnter={e => !open && (e.currentTarget.style.boxShadow = '0 0 0 1.5px ' + c)}
        onMouseLeave={e => !open && (e.currentTarget.style.boxShadow = 'inset 0 0 0 1.5px rgba(27,45,69,0.12)')}
      >
        <span className="text-[11px] font-bold uppercase tracking-[0.05em] opacity-80">DevOps</span>
        <span className="size-[7px] rounded-full" style={{ background: dot }} />
        {p.infra}
        <Icon d={PATHS.chevron} size={11} sw={2.8} />
      </button>
      {open && (
        <>
          <Scrim onClick={() => setOpen(false)} z={30} />
          <div className="absolute right-0 top-[calc(100%+8px)] z-[31] w-[380px] rounded-2xl border-[1.5px] border-line bg-white p-4 shadow-[0_18px_50px_rgba(27,45,69,0.18)]">
            <div className="flex items-center gap-2">
              <span className="tnum rounded-md bg-sky-2 px-[7px] py-[3px] text-[11.5px] font-semibold text-blue-ink">{p.key}</span>
              <span className="text-[15px] font-bold text-ink">{p.name}</span>
            </div>
            <div className="mt-1 text-[12.5px] text-ink-2">Linked to epic {epicName}</div>
            <div className="mt-3 flex gap-[18px] shadow-[inset_0_-1.5px_0_#C9D2DD]">
              {tabs.map(([id, label, n]) => {
                const on = tab === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 pb-[9px] pt-0 text-[13.5px]"
                    style={{ fontWeight: on ? 700 : 500, color: on ? '#1B2D45' : '#22354C', boxShadow: `inset 0 -2px 0 ${on ? '#4870E8' : 'transparent'}` }}
                  >
                    {label}
                    <span className="inline-flex h-[17px] min-w-[18px] items-center justify-center rounded-[9px] bg-sky-2 px-[5px] text-[10.5px] font-bold text-blue-ink">{n}</span>
                  </button>
                )
              })}
            </div>

            {tab === 'status' && (
              <>
                <div className="mt-3.5 overflow-hidden rounded-xl border-[1.5px] border-line">
                  {rows.map((r, i) => (
                    <div key={r.label} className="flex min-h-10 items-center justify-between gap-2.5 px-3 py-1.5" style={{ borderTop: i ? '1.5px solid #E4EAF0' : '0' }}>
                      <span className="text-[13px] text-ink-2">{r.label}</span>
                      <span
                        className="inline-flex max-w-[200px] items-center gap-1.5 truncate whitespace-nowrap rounded-full py-0.5 pl-2 pr-[9px] text-[12.5px] font-semibold"
                        style={{ background: r.tone[1], color: r.tone[0] }}
                      >
                        <span className="size-1.5 flex-none rounded-full" style={{ background: r.tone[2] }} />
                        {r.value}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-2.5 overflow-hidden rounded-xl border-[1.5px] border-line bg-canvas">
                  <div className="flex min-h-11 items-center justify-between gap-2.5 px-3 py-1.5">
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink-2">CI/CD</div>
                      <div className="text-[11.5px] font-semibold text-muted">{p.cicd ? 'Pipeline set up' : 'No pipeline yet'}</div>
                    </div>
                    <span
                      title="Managed by DevOps"
                      className="relative h-6 w-10 flex-none cursor-not-allowed rounded-full opacity-85"
                      style={{ background: p.cicd ? '#3F9079' : '#C9D2DD' }}
                    >
                      <span className="absolute top-0.5 size-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)]" style={{ left: p.cicd ? 18 : 2 }} />
                    </span>
                  </div>
                  <div className="border-t-[1.5px] border-line-3 px-3 pb-2.5 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] text-ink-2">Client follow-up</span>
                      <span className="text-[11.5px] font-semibold" style={{ color: step != null && step >= 4 ? '#A5502C' : '#1F3FAF' }}>
                        {step != null ? LADDER[step] + ' · step ' + (step + 1) + ' of ' + LADDER.length : 'No follow-up running'}
                      </span>
                    </div>
                    {step != null && (
                      <div className="mt-[7px] flex gap-[3px]">
                        {LADDER.map((n, i) => (
                          <span key={n} className="h-1 flex-1 rounded-sm" style={{ background: i <= step ? (step >= 4 ? '#D2724A' : '#4870E8') : '#DDE3E8' }} />
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 border-t-[1.5px] border-line-3 px-3 py-1.5 text-[11.5px] font-semibold text-muted">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="11" width="14" height="10" rx="2" />
                      <path d={PATHS.lock} />
                    </svg>
                    Read only · updated by the DevOps team
                  </div>
                </div>
              </>
            )}

            {tab === 'req' && (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={() => setForm(!form)}
                  className="flex h-10 w-full cursor-pointer items-center gap-2 rounded-[10px] border-[1.5px] border-dashed px-3 text-[13.5px] font-bold text-blue-ink hover:!border-blue hover:!bg-sky"
                  style={{ borderColor: form ? '#4870E8' : '#A9B6C5', background: form ? '#EEF3FB' : '#FFFFFF' }}
                >
                  <span
                    className="grid size-5 flex-none place-items-center rounded-md bg-blue text-white transition-transform duration-[250ms]"
                    style={{ transform: `rotate(${form ? 45 : 0}deg)` }}
                  >
                    <Icon d={PATHS.plus} size={12} sw={3} />
                  </span>
                  {form ? 'Close' : 'Raise a ticket'}
                </button>
                <div
                  className="transition-[max-height,opacity] duration-[350ms] ease-[cubic-bezier(0.16,1,0.3,1)]"
                  style={{ maxHeight: form ? 420 : 0, opacity: form ? 1 : 0, overflow: dd ? 'visible' : 'hidden' }}
                >
                  <div className="pt-2.5">
                    <div className="mt-2 grid grid-cols-3 gap-1.5">
                      {pickers.map(f => {
                        const isOpen = dd === f.k
                        return (
                          <div key={f.k} className="relative flex min-w-0 flex-col gap-1">
                            <span className="text-[11px] font-semibold text-ink-2">{f.label}</span>
                            <button
                              type="button"
                              onClick={() => setDd(isOpen ? null : f.k)}
                              className="flex w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-0 py-[5px] pl-[9px] pr-1.5 text-[12px] font-semibold"
                              style={{ background: f.tone[1], color: f.tone[0], boxShadow: isOpen ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1.5px rgba(27,45,69,0.14)' }}
                            >
                              <span className="size-1.5 flex-none rounded-full" style={{ background: f.tone[2] }} />
                              <span className="min-w-0 flex-1 truncate text-left">{f.value}</span>
                              <Caret />
                            </button>
                            {isOpen && (
                              <>
                                <Scrim onClick={() => setDd(null)} z={32} />
                                <div className="absolute left-0 top-[calc(100%+6px)] z-[33] w-[200px] rounded-[14px] bg-white/[.97] p-1.5 shadow-[0_14px_40px_rgba(27,45,69,0.18),0_0_0_1px_rgba(27,45,69,0.12)]">
                                  <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">{f.label}</div>
                                  {f.menu.map(o => {
                                    const sel = o.v === f.cur
                                    return (
                                      <button
                                        key={o.v || 'none'}
                                        type="button"
                                        onClick={() => {
                                          setDd(null)
                                          f.set(o.v)
                                        }}
                                        className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left text-[13px] text-ink hover:!bg-sky-2"
                                        style={{ background: sel ? '#EEF3FB' : 'transparent', fontWeight: sel ? 600 : 400 }}
                                      >
                                        <span className="size-2 flex-none rounded-full" style={{ background: o.dot }} />
                                        <span className="min-w-0 flex-1 truncate">{o.label}</span>
                                        <span className="text-[13px] font-bold text-blue" style={{ opacity: sel ? 1 : 0 }}>
                                          ✓
                                        </span>
                                      </button>
                                    )
                                  })}
                                </div>
                              </>
                            )}
                          </div>
                        )
                      })}
                    </div>
                    <textarea
                      value={rq.text}
                      onChange={e => setRq({ ...rq, text: e.target.value })}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          sendReq()
                        }
                      }}
                      rows={2}
                      placeholder="e.g. Please deploy Sprint 2 build to the test environment"
                      className="mt-2 w-full resize-y rounded-[10px] border-[1.5px] border-line bg-canvas px-[11px] py-[9px] text-[13.5px] leading-normal text-ink outline-0"
                    />
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[12px] font-medium text-ink-2">
                        Sends to {rq.to ? '@' + rq.to : p.owner ? '@' + p.owner + ' (owner)' : 'the DevOps team'}
                      </span>
                      <button
                        type="button"
                        onClick={sendReq}
                        className="ml-auto h-8 cursor-pointer rounded-lg border-0 bg-blue px-3.5 text-[13px] font-bold text-white"
                        style={{ opacity: rq.text.trim() ? 1 : 0.45 }}
                      >
                        Send request
                      </button>
                    </div>
                  </div>
                </div>
                {reqs.length > 0 && (
                  <div className="mt-3 flex flex-col gap-1.5">
                    {reqs.map(r => {
                      const pc2 = PRIO[r.prio] || PRIO.Medium
                      const n = unreadOf(r)
                      const st = r.status || 'Open'
                      return (
                        <div
                          key={r.id}
                          onClick={() => {
                            setOpen(false)
                            openRequest(r)
                          }}
                          className="flex cursor-pointer items-start gap-2 rounded-[10px] border-[1.5px] border-line-3 bg-canvas px-2.5 py-2 hover:!border-blue"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="tnum text-[11px] font-semibold text-blue-ink">{r.rkey}</span>
                              <span className="rounded-full bg-lavender px-[7px] py-px text-[11px] font-bold text-purple-ink">{r.type}</span>
                              <span className="rounded-full px-[7px] py-px text-[11px] font-bold" style={{ background: pc2[1], color: pc2[0] }}>
                                {r.prio}
                              </span>
                              <span className="text-[11.5px] font-semibold text-blue-ink">{r.to ? '@' + r.to.split(' ')[0] : 'Unassigned'}</span>
                              {n > 0 && (
                                <span className="ml-auto inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[#D2724A] px-[5px] text-[10.5px] font-bold text-white">
                                  {n}
                                </span>
                              )}
                              <span className="ml-auto text-[11px] font-bold" style={{ color: STATUS_C[st] || STATUS_C.Open }}>
                                {st}
                              </span>
                            </div>
                            <div className="mt-1 text-[13px] leading-[1.4] text-ink">{r.text}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </span>
  )
}

