import { useQuestions, useRequests } from '../../api/queries'
import type { DvProject } from '../../api/devops/types'
import { useDv } from './ctx'
import { PRIO_ICON, tileName, tileOf, tileText, tone } from './model'
import { FollowUpsTab } from './FollowUpsTab'
import { PhasesTab } from './PhasesTab'
import { ActivityTab, ClientChatTab, TicketsTab } from './OtherTabs'
import { Sidebar } from './Sidebar'
import { PrioIcon } from './ui'

type Tab = 'follow' | 'phases' | 'log' | 'tickets' | 'cchat'

/** The panel that slides in when a project is opened (?project=OPS-101&tab=…). */
export function ProjectPanel({ p }: { p: DvProject }) {
  const { get, open } = useDv()
  const requests = useRequests().data ?? []
  const questions = useQuestions().data ?? []
  const tab = (get('tab') as Tab) || 'follow'
  const myReqs = requests.filter(r => r.key === p.key)
  const nQ = questions.filter(q => q.project === p.key).length
  const close = () => open({ project: null, tab: null })

  const tabs: [Tab, string][] = [
    ['follow', 'Follow-ups'],
    ['phases', 'Phases'],
    ['log', 'Activity' + (p.logs.length ? ' ' + p.logs.length : '')],
    ['tickets', 'Tickets' + (myReqs.length ? ' ' + myReqs.length : '')],
    ['cchat', 'Client chat' + (nQ ? ' ' + nQ : '')],
  ]

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-30 animate-fade-in bg-[rgba(27,45,69,0.38)]" />
      <aside
        data-testid="project-panel"
        className="dv-slide fixed bottom-3 right-3 top-3 z-[31] flex w-[920px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[28px] border border-line-3 bg-white font-normal text-ink shadow-[0_30px_90px_rgba(0,0,0,0.2),0_0_0_0.5px_rgba(0,0,0,0.08)]"
      >
        <button
          type="button"
          onClick={close}
          title="Close"
          className="absolute right-4 top-4 z-[5] grid size-8 cursor-pointer place-items-center rounded-lg border border-rust-line bg-rust-soft p-0 text-rust transition-colors hover:border-[#E8B39C] hover:bg-peach"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-9 pt-7">
            <div className="flex items-center justify-between gap-4 pr-11">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div
                  className="flex size-8 flex-none items-center justify-center rounded-md text-[12px] font-bold text-white"
                  style={{ background: tileOf(tileName(p)) }}
                >
                  {tileText(tileName(p))}
                </div>
                <div className="min-w-0 flex-1">
                  <h2 title={p.name} className="m-0 truncate whitespace-nowrap text-[22px] font-bold leading-[1.2] tracking-[-0.02em]">
                    {p.name}
                  </h2>
                  {p.client && <div className="mt-0.5 text-[13px] text-muted">{p.client}</div>}
                </div>
              </div>
              <div className="flex flex-none items-center gap-2.5">
                {(() => {
                  const st = tone(p.infra)
                  const crit = p.prio === 'Critical'
                  return (
                    <>
                      <span className="max-w-[200px] truncate whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-semibold" style={{ background: st[1], color: st[0] }}>
                        {p.infra || 'Not set'}
                      </span>
                      <span
                        data-crit={crit ? '1' : undefined}
                        className="inline-flex flex-none items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[12px] font-semibold"
                        style={{
                          background: crit ? '#F6DDD0' : '#F3F5F8',
                          color: PRIO_ICON[p.prio]?.[0] ?? '#56657A',
                          animation: crit ? 'critPulse 1.6s ease-in-out infinite' : undefined,
                        }}
                      >
                        <PrioIcon p={p.prio} size={13} sw={2.2} />
                        {p.prio}
                      </span>
                    </>
                  )
                })()}
                <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-2 py-1 font-sans text-[12px] font-medium text-blue-ink">{p.key}</span>
              </div>
            </div>
            <div className="mt-6 flex gap-[26px] border-b-[0.5px] border-black/10">
              {tabs.map(([id, label]) => {
                const on = tab === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => open({ tab: id === 'follow' ? null : id }, true)}
                    className="-mb-[0.5px] cursor-pointer border-0 border-b-2 bg-transparent px-0 pb-3 pt-0 text-[14px]"
                    style={{ fontWeight: on ? 600 : 500, color: on ? '#1B2D45' : '#3B4A5E', borderBottomColor: on ? '#1B2D45' : 'transparent', borderBottomStyle: 'solid' }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-9 pb-9 pt-7">
            {tab === 'follow' && <FollowUpsTab p={p} />}
            {tab === 'phases' && <PhasesTab p={p} />}
            {tab === 'log' && <ActivityTab p={p} />}
            {tab === 'tickets' && <TicketsTab requests={myReqs} />}
            {tab === 'cchat' && <ClientChatTab p={p} questions={questions} />}
          </div>
        </div>
        <Sidebar p={p} />
      </aside>
    </>
  )
}
