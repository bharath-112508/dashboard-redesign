import { NavLink, Outlet, useLocation, useNavigate } from 'react-router'
import { useEntries, useQuestions, useRequests, useTasks, useWorkspace } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { Avatar, Icon, PATHS } from '../../components/ui'
import { usePerson } from '../../state/page'
import { Overlays } from '../../features/Overlays'
import { Toolbar } from '../clients/Toolbar'
import { useTeamPeople } from '../../features/tickets/useMe'
import { TicketsEpicBar } from './TicketsEpicBar'
import { DeployToast } from '../../features/tickets/DeployToast'

export const TICKET_VIEWS = [
  { id: 'overview', label: 'Overview', icon: 'M12 3l2.2 5.3L20 9.2l-4.3 3.9 1.2 5.9L12 16l-4.9 3 1.2-5.9L4 9.2l5.8-.9z' },
  { id: 'board', label: 'Board', icon: 'M4 4h16v16H4zM9.5 4v16M14.5 4v16' },
  { id: 'tasks', label: 'Tasks', icon: 'M3 7h18v3a2 2 0 000 4v3H3v-3a2 2 0 000-4zM15 7v10' },
  { id: 'backlog', label: 'Backlog', icon: 'M4 6l2 2 3-3M12 7h8M4 13l2 2 3-3M12 14h8M12 20h8' },
  { id: 'plan', label: 'Epics & sprints', icon: 'M4 5h7v5H4zM13 7h7M8 10v4h5M13 14h7M8 14v5h5M13 19h7' },
  { id: 'timeline', label: 'Timeline', icon: 'M12 7v5l3 2M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
  { id: 'timesheet', label: 'Timesheet', icon: 'M10 2h4M12 13V9M20 14a8 8 0 11-16 0 8 8 0 0116 0z' },
  { id: 'files', label: 'Files', icon: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6' },
] as const

export type TicketViewId = (typeof TICKET_VIEWS)[number]['id']

/** Moves to another tab of the Tickets page, remembering where we came from for the Back button. */
export const useGoView = () => {
  const loc = useLocation()
  const navigate = useNavigate()
  const view = (loc.pathname.split('/')[2] || 'board') as TicketViewId
  const stack = (loc.state as { stack?: TicketViewId[] } | null)?.stack ?? []
  return (to: TicketViewId, search = '') => {
    if (to === view && !search) return
    navigate('/tickets/' + to + search, { state: { stack: to === view ? stack : [...stack, view] } })
  }
}

/** The Tickets page: title, tabs, epic bar and the selected view. */
export function TicketsLayout() {
  const loc = useLocation()
  const navigate = useNavigate()
  const person = usePerson()
  const view = (loc.pathname.split('/')[2] || 'board') as TicketViewId
  // Tabs visited before this one, like the prototype's page stack.
  const stack = (loc.state as { stack?: TicketViewId[] } | null)?.stack ?? []
  const from = stack[stack.length - 1]
  const fromLabel = from && TICKET_VIEWS.find(v => v.id === from)?.label

  // Load everything the page needs up front.
  const team = useTeamPeople()
  const loading = [useWorkspace(), useTasks(), useEntries(), useQuestions(), useRequests(), usePeople()]
  const error = loading.find(q => q.isError)
  const ready = loading.every(q => q.data)

  const showEpicBar = view !== 'plan' && view !== 'overview'
  const goView = useGoView()
  const showToolbar = view === 'board' || view === 'tasks'

  return (
    <main data-page="tickets" className="flex flex-col px-7 pb-14 pt-5">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => from && navigate('/tickets/' + from, { state: { stack: stack.slice(0, -1) } })}
          title={fromLabel ? 'Back to ' + fromLabel : 'Back'}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-lg border-[1.5px] border-line bg-white pl-1.5 pr-2.5 text-[12.5px] font-semibold text-ink hover:border-blue hover:text-blue-ink"
          style={{ cursor: from ? 'pointer' : 'default', opacity: from ? 1 : 0.45 }}
        >
          <Icon d={PATHS.back} size={14} sw={2.6} />
          {fromLabel ? 'Back to ' + fromLabel : 'Back'}
        </button>
      </div>
      <div className="mt-1 flex items-center gap-2.5">
        <span className="grid size-[26px] place-items-center rounded-[7px] bg-blue text-[12px] font-bold text-white">P</span>
        <h1 className="m-0 text-[22px] font-bold tracking-[-0.02em] text-ink">Project Management tool</h1>
        <div className="ml-1.5 flex">
          {team.map(p => {
            const m = person(p.name)
            return <Avatar key={p.id} i={m.i} bg={m.bg} size={24} radius={6} font={9.5} title={p.name} ring="0 0 0 2px #F6F9FC" style={{ marginRight: -5 }} />
          })}
        </div>
      </div>
      <div className="mt-3.5 flex items-end gap-[22px] overflow-x-auto shadow-[inset_0_-1.5px_0_#D6DEE8]">
        {TICKET_VIEWS.map(v => (
          <NavLink
            key={v.id}
            to={'/tickets/' + v.id}
            state={v.id === view ? loc.state : { stack: [...stack, view] }}
            replace={v.id === view}
            className={({ isActive }) =>
              `inline-flex flex-none items-center gap-[7px] whitespace-nowrap px-0.5 tracking-normal pb-[11px] pt-2 text-[14px] font-semibold no-underline hover:!text-ink ${
                isActive ? '!text-ink shadow-[inset_0_-2px_0_#4870E8]' : '!text-muted'
              }`
            }
          >
            <Icon d={v.icon} size={15} sw={2} />
            {v.label}
          </NavLink>
        ))}
      </div>

      {ready && showEpicBar && <TicketsEpicBar showSprints={view === 'board' || view === 'tasks' || view === 'timesheet'} />}
      {ready && showToolbar ? <Toolbar /> : <div className="h-5" />}

      {error ? (
        <div className="rounded-[14px] border-[1.5px] border-dashed border-line p-8 text-center text-[14px] text-ink-2">
          Couldn't load the project. Reload the page to try again.
        </div>
      ) : ready ? (
        <>
          <Outlet />
          <Overlays />
          <DeployToast showEpicBar={() => !showEpicBar && goView('board')} />
        </>
      ) : (
        <div className="p-12 text-center text-[14px] text-muted">Loading…</div>
      )}
    </main>
  )
}
