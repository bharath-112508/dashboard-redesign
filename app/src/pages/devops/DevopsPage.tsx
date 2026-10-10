import { useMemo, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { HeaderSlot } from '../../components/HeaderSlot'
import type { DvProject } from '../../api/devops/types'
import { useDv } from '../../features/devops/ctx'
import { FILTERS, type FilterId } from '../../features/devops/model'
import { DevopsWindows } from '../../features/devops/Windows'
import { HoverPopover, usePopover } from '../../features/devops/HoverPopover'
import { ListView, type Sort } from './ListView'
import { BoardView } from './BoardView'

const PAGE_CSS = `
@keyframes critPulse{0%,100%{background-color:#FBF3EF}50%{background-color:#F6DDD0}}
@keyframes dvSlideIn{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}
`

/** Colours of each filter tab: [badge bg, ink, underline]. */
const TAB_C: Record<FilterId, [string, string, string]> = {
  all: ['#DCE5FA', '#1F3FAF', '#4870E8'],
  due: ['#F6DDD0', '#7A3818', '#D2724A'],
  client: ['#DCE5FA', '#1F3FAF', '#4870E8'],
  internal: ['#E6DFFA', '#3F2E94', '#9F89E5'],
  esc: ['#FBEDC2', '#7A5C0E', '#B98A2F'],
  moved: ['#DFF1F0', '#1F6F6E', '#3E908F'],
}

type Scope = 'all' | 'client' | 'internal'

export function DevopsPage() {
  const { view } = useParams()
  const loc = useLocation()
  const nav = useNavigate()
  const dv = useDv()
  const { projects, settings } = dv.db
  const [filter, setFilter] = useState<FilterId>('all')
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>('all')
  const [sort, setSort] = useState<Sort>(null)
  const pop = usePopover()

  const live = useMemo(() => projects.filter(p => scope === 'all' || (p.kind || 'client') === scope), [projects, scope])
  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([id, , f]) => [id, live.filter(p => f(p, settings)).length])) as Record<FilterId, number>,
    [live, settings],
  )
  const list = useMemo(() => {
    const fn = FILTERS.find(f => f[0] === filter)![2]
    const qq = q.trim().toLowerCase()
    return live
      .filter(p => fn(p, settings))
      .filter(p => !qq || [p.name, p.phase, p.next, p.owner, p.key].join(' ').toLowerCase().includes(qq))
  }, [live, filter, q, settings])

  if (view !== 'board' && view !== 'list') return <Navigate to={{ pathname: '/devops/board', search: loc.search }} replace />
  const isList = view === 'list'
  const dueCount = counts.due
  const openProject = (p: DvProject) => dv.open({ project: p.key, tab: null })
  const setView = (v: 'board' | 'list') => nav({ pathname: '/devops/' + v, search: loc.search })

  return (
    <div className="font-normal">
      <style>{PAGE_CSS}</style>
      <HeaderSlot>
        <span className="relative ml-auto flex min-w-[150px] flex-[0_1_300px] items-center">
          <span className="absolute left-[13px] top-1/2 flex -translate-y-1/2 text-muted">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
          </span>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search projects, owners, notes…"
            className="h-[34px] w-full rounded-[10px] border-0 bg-white pl-[38px] pr-3 text-[13.5px] font-normal text-ink outline-0 shadow-[0_1px_0_rgba(27,45,69,0.03),0_1px_2px_rgba(27,45,69,0.05),0_8px_20px_-12px_rgba(27,45,69,0.08)]"
          />
        </span>
        <button
          type="button"
          onClick={() => setFilter('due')}
          title="Due now"
          className="relative grid size-[34px] flex-none cursor-pointer place-items-center rounded-[10px] border-0 bg-white text-ink-2 shadow-[0_1px_0_rgba(27,45,69,0.03),0_1px_2px_rgba(27,45,69,0.05),0_8px_20px_-12px_rgba(27,45,69,0.08)] transition-colors hover:text-blue-ink"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 10-12 0c0 7-3 8-3 8h18s-3-1-3-8" />
            <path d="M10.3 21a2 2 0 003.4 0" />
          </svg>
          {dueCount > 0 && (
            <span className="absolute -right-1 -top-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-[#D2724A] px-[5px] text-[11px] font-semibold text-white shadow-[0_0_0_2px_#F6F9FC]">
              {dueCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => dv.open({ settings: 'seq' })}
          title="Settings"
          className="grid size-[34px] flex-none cursor-pointer place-items-center rounded-[10px] border-0 bg-white text-ink-2 shadow-[0_1px_0_rgba(27,45,69,0.03),0_1px_2px_rgba(27,45,69,0.05),0_8px_20px_-12px_rgba(27,45,69,0.08)] transition-colors hover:text-blue-ink"
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 11-4 0v-.09a1.65 1.65 0 00-1-1.51 1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 110-4h.09a1.65 1.65 0 001.51-1 1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 112.83-2.83l.06.06a1.65 1.65 0 001.82.33h0a1.65 1.65 0 001-1.51V3a2 2 0 114 0v.09a1.65 1.65 0 001 1.51h0a1.65 1.65 0 001.82-.33l.06-.06a2 2 0 112.83 2.83l-.06.06a1.65 1.65 0 00-.33 1.82v0a1.65 1.65 0 001.51 1H21a2 2 0 110 4h-.09a1.65 1.65 0 00-1.51 1z" />
          </svg>
        </button>
      </HeaderSlot>

      <main className="mx-auto flex w-full max-w-[1680px] flex-col gap-[22px] px-8 pb-14 pt-10 text-[14px] tracking-[-0.005em]">
        <div className="flex flex-wrap items-center justify-between gap-5">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-baseline gap-2.5">
              <h1 className="m-0 font-sans text-[28px] font-bold leading-[1.1] tracking-[-0.025em] text-ink">Projects</h1>
              <span className="font-mono text-[13px] text-slate">{counts.all}</span>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-[13px] text-muted">
              {(
                [
                  ['due', 'overdue', '#D2724A'],
                  ['client', 'with client', '#4870E8'],
                  ['internal', 'with dev team', '#9F89E5'],
                ] as [FilterId, string, string][]
              ).map(([id, l, dot]) => (
                <span key={id} className="inline-flex items-center gap-[7px]">
                  <span className="size-1.5 rounded-full" style={{ background: dot }} />
                  <b className="tnum font-semibold text-ink">{counts[id]}</b>
                  {l}
                </span>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <span className="inline-flex gap-0.5 rounded-[10px] bg-sky-2 p-[3px]">
              {(['list', 'board'] as const).map(v => {
                const on = view === v
                return (
                  <button
                    key={v}
                    type="button"
                    title={v === 'list' ? 'List' : 'Board'}
                    onClick={() => setView(v)}
                    className="grid h-7 w-8 cursor-pointer place-items-center rounded-lg border-0 transition-colors"
                    style={{ background: on ? '#fff' : 'transparent', color: on ? '#1B2D45' : '#3B4A5E', boxShadow: on ? '0 1px 2px rgba(27,45,69,0.10)' : 'none' }}
                  >
                    {v === 'list' ? (
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                        <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinejoin="round">
                        <rect x="3" y="4" width="5" height="16" rx="1.5" />
                        <rect x="10" y="4" width="5" height="11" rx="1.5" />
                        <rect x="17" y="4" width="4" height="7" rx="1.5" />
                      </svg>
                    )}
                  </button>
                )
              })}
            </span>
            <button
              type="button"
              onClick={() => dv.open({ new: '1' })}
              className="inline-flex h-9 cursor-pointer items-center gap-[7px] rounded-[10px] border-0 bg-blue pl-3 pr-3.5 text-[13.5px] font-semibold text-white shadow-[0_1px_2px_rgba(27,45,69,0.12),inset_0_1px_0_rgba(255,255,255,0.18)] transition-colors hover:bg-blue-600"
            >
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
              New project
            </button>
          </div>
        </div>

        <div className="-mt-1 flex items-end gap-4 shadow-[inset_0_-1px_0_#E4EAF0]">
          <div className="flex min-w-0 flex-wrap items-end gap-[22px]">
            {FILTERS.map(([id, l]) => {
              const on = filter === id
              const c = TAB_C[id]
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                  className="inline-flex cursor-pointer items-center gap-[7px] border-0 bg-transparent px-0 pb-3 pt-2.5 text-[13.5px] leading-none transition-[color,box-shadow] hover:!text-ink"
                  style={{ fontWeight: on ? 700 : 500, color: on ? c[1] : '#22354C', boxShadow: `inset 0 -2px 0 ${on ? c[2] : 'transparent'}` }}
                >
                  {l}
                  <span
                    className="tnum inline-flex h-[18px] min-w-5 items-center justify-center rounded-[9px] px-1.5 text-[11.5px] font-semibold"
                    style={{ background: c[0], color: c[1] }}
                  >
                    {counts[id]}
                  </span>
                </button>
              )
            })}
          </div>
          <span className="mb-[7px] ml-auto inline-flex items-center gap-2 text-[12.5px] text-muted">
            Sequence
            <span className="inline-flex gap-0.5 rounded-lg bg-sky-2 p-0.5">
              {(
                [
                  ['all', 'All'],
                  ['client', 'Client'],
                  ['internal', 'Internal'],
                ] as [Scope, string][]
              ).map(([id, l]) => {
                const on = scope === id
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setScope(id)}
                    className="h-6 cursor-pointer rounded-md border-0 px-2.5 text-[12.5px] font-medium leading-none"
                    style={{ background: on ? '#4870E8' : 'transparent', color: on ? '#fff' : '#1F3FAF', boxShadow: on ? '0 1px 2px rgba(27,45,69,0.10)' : 'none' }}
                  >
                    {l}
                  </button>
                )
              })}
            </span>
          </span>
        </div>

        {isList ? (
          list.length ? (
            <ListView projects={list} sort={sort} setSort={setSort} onOpen={openProject} pop={pop} />
          ) : (
            <div className="py-20 text-center text-[15px] text-muted">No projects match these filters.</div>
          )
        ) : (
          <BoardView projects={list} onOpen={openProject} />
        )}
      </main>
      <footer className="mx-auto w-fit max-w-[1600px] px-8 pb-10 pt-2 text-[12px] text-slate">
        Data is stored in this browser only. Never exported.{' '}
        <a
          href="#"
          onClick={e => {
            e.preventDefault()
            const blob = new Blob([JSON.stringify(dv.db, null, 2)], { type: 'application/json' })
            const a = document.createElement('a')
            a.href = URL.createObjectURL(blob)
            a.download = 'devops-board-backup.json'
            a.click()
            URL.revokeObjectURL(a.href)
          }}
          className="hover:underline"
        >
          Export a backup
        </a>
      </footer>

      {!dv.get('project') && <HoverPopover pop={pop} />}
      <DevopsWindows />
    </div>
  )
}
