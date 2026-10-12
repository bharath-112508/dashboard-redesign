import { useEffect } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useEntries, useQuestions, useRequests, useTasks, useWorkspace } from '../../api/queries'
import { Avatar, Icon, PATHS } from '../../components/ui'
import { PEOPLE, person } from '../../lib/theme'
import { EpicBar } from './EpicBar'
import { Toolbar } from './Toolbar'
import { Overlays } from '../../features/Overlays'
import { ScopeContext } from '../../state/access'
import { useUi } from '../../state/ui'
import { ImModeContext, useProjectScope } from './useClientScope'
import { IM_BASE, IM_NAME } from '../../features/invoice-match/data'

export const VIEWS = [
  { id: 'board', label: 'Board', icon: 'M4 4h16v16H4zM9.5 4v16M14.5 4v16' },
  { id: 'plan', label: 'Epics & sprints', icon: 'M4 5h7v5H4zM13 7h7M8 10v4h5M13 14h7M8 14v5h5M13 19h7' },
  { id: 'timeline', label: 'Timeline', icon: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
] as const

export type ViewId = (typeof VIEWS)[number]['id']

/** The Clients page: title, tabs, epic bar and the selected view. */
export function ClientsLayout() {
  const loc = useLocation()
  const navigate = useNavigate()
  const view = (loc.pathname.split('/')[2] || 'board') as ViewId
  // Tabs visited before this one, like the prototype's page stack.
  const stack = (loc.state as { stack?: ViewId[] } | null)?.stack ?? []
  const from = stack[stack.length - 1]
  const fromLabel = from && VIEWS.find(v => v.id === from)?.label

  // Load everything the page needs up front.
  const loading = [useWorkspace(), useTasks(), useEntries(), useQuestions(), useRequests()]
  const error = loading.find(q => q.isError)
  const ready = loading.every(q => q.data)

  // Client users only see their company's epics. Keep the picked epic inside them.
  // v5: the delivered InvoiceMatch project narrows the page to its own epics.
  const { im, scope } = useProjectScope()
  const ui = useUi()
  useEffect(() => {
    if (scope && scope.epicIds.length && !scope.epicIds.includes(ui.epic)) ui.setEpics(scope.epicIds)
  }, [scope, ui.epic])

  return (
    <ScopeContext.Provider value={scope}>
      <ImModeContext.Provider value={im}>
        <main className="flex flex-col px-7 pb-14 pt-5">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => from && navigate('/clients/' + from, { state: { stack: stack.slice(0, -1) } })}
              title={fromLabel ? 'Back to ' + fromLabel : 'Back'}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink"
              style={{ cursor: from ? 'pointer' : 'default', opacity: from ? 1 : 0.45 }}
            >
              <Icon d={PATHS.back} size={14} sw={2.6} />
              {fromLabel ? 'Back to ' + fromLabel : 'Back'}
            </button>
          </div>
          <div className="mt-1 flex items-center gap-2.5">
            {im ? (
              <>
                <span className="grid size-[26px] place-items-center rounded-[7px] bg-[#1D4ED8] text-[11px] font-extrabold text-white">IM</span>
                <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em] text-ink">{IM_NAME}</h1>
                <span className="ml-1 inline-flex h-6 flex-none items-center gap-1.5 whitespace-nowrap rounded-full bg-[#D6E9E2] pl-[7px] pr-[9px] text-[12px] font-bold text-[#195040]">
                  <span className="size-1.5 rounded-full bg-[#3F9079]" />
                  Completed
                </span>
                <button
                  type="button"
                  onClick={() => navigate(IM_BASE + '/inbox')}
                  className="ml-1.5 inline-flex h-8 flex-none cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-lg border-0 bg-[#195040] px-3 text-[13px] font-bold text-white hover:bg-[#14402F]"
                >
                  <span className="size-[7px] rounded-full bg-[#7FE0B5]" />
                  Live app ↗
                </button>
              </>
            ) : (
              <>
                <span className="grid size-[26px] place-items-center rounded-[7px] bg-blue text-[12px] font-bold text-white">P</span>
                <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em] text-ink">Project Management tool</h1>
              </>
            )}
            <div className="ml-1.5 flex">
              {PEOPLE.map(n => {
                const m = person(n)
                return (
                  <Avatar key={n} i={m.i} bg={m.bg} size={24} radius={6} font={9.5} title={n} ring="0 0 0 2px #F6F9FC" style={{ marginRight: -5 }} />
                )
              })}
            </div>
          </div>
          <div className="mt-3.5 flex items-end gap-[22px] overflow-x-auto shadow-[inset_0_-1.5px_0_#D6DEE8]">
            {VIEWS.map(v => (
              <NavLink
                key={v.id}
                to={'/clients/' + v.id}
                state={v.id === view ? loc.state : { stack: [...stack, view] }}
                replace={v.id === view}
                className={({ isActive }) =>
                  `inline-flex flex-none items-center gap-[7px] whitespace-nowrap px-0.5 pb-[11px] pt-2 text-[14px] font-semibold no-underline hover:!text-ink ${
                    isActive ? '!text-ink shadow-[inset_0_-2px_0_#4870E8]' : '!text-muted'
                  }`
                }
              >
                <Icon d={v.icon} size={15} sw={2} />
                {v.label}
              </NavLink>
            ))}
          </div>

          {view !== 'plan' && <EpicBar showSprints={view === 'board'} />}
          {view === 'board' ? <Toolbar /> : <div className="h-5" />}

          {error ? (
            <div role="status" className="rounded-[14px] border-[1.5px] border-dashed border-line p-8 text-center text-[14px] text-ink-2">
              Couldn't load the project. Reload the page to try again.
            </div>
          ) : ready ? (
            <>
              <Outlet />
              <Overlays />
            </>
          ) : (
            <div role="status" aria-busy="true" className="p-12 text-center text-[14px] text-muted">Loading…</div>
          )}
        </main>
      </ImModeContext.Provider>
    </ScopeContext.Provider>
  )
}
