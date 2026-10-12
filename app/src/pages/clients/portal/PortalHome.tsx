import { useNavigate, useSearchParams } from 'react-router'
import { useClientTeam, useCompanies, useWorkspace } from '../../../api/queries'
import type { ClientProject, Company, ProjectState, Workspace } from '../../../api/types'
import { Icon, PATHS } from '../../../components/ui'
import { fmt } from '../../../lib/dates'
import { useIsClient } from '../../../state/access'
import { clientsPath, useUi } from '../../../state/ui'
import { useSession } from '../../../api/session/store'
import { TeamPanel } from './TeamPanel'
import { LiveProjectCard } from '../../../features/invoice-match/LiveProjectCard'
import { IM_PROJECT_ID } from '../../../features/invoice-match/data'

const PROJECT_STATE: Record<ProjectState, [string, string, string]> = {
  active: ['Active', '#1F3FAF', '#DCE5FA'],
  planned: ['Planned', '#22354C', '#E7EEFB'],
  hold: ['On hold', '#7A5C0E', '#FBEDC2'],
  maint: ['Maintenance', '#1F6F6E', '#DFF1F0'],
  done: ['Done', '#195040', '#D6E9E2'],
}

/**
 * The first open epic of a project, by its target date: the next thing the
 * client can expect. Epics without a target date are not milestones.
 */
const nextMilestone = (p: ClientProject, ws: Workspace | undefined) => {
  if (!ws) return undefined
  const epicState = new Map(p.epics.map(e => [e.id, e.state]))
  return ws.epics
    .filter(e => epicState.has(e.id) && epicState.get(e.id) !== 'done' && e.target)
    .sort((a, b) => ((a.target ?? '') < (b.target ?? '') ? -1 : 1))[0]
}

/** "Your projects": the project cards of the client, and the client's team. */
export function PortalHome() {
  const session = useSession()
  const isClient = useIsClient()
  const navigate = useNavigate()
  const ui = useUi()
  const [params] = useSearchParams()
  const companiesQ = useCompanies()
  const teamQ = useClientTeam()
  const wsQ = useWorkspace()
  const companies = (companiesQ.data ?? []).filter(c => !c.archived)

  if (!companiesQ.data || !teamQ.data || !wsQ.data) {
    return (
      <main className="px-7 pb-14 pt-6">
        <div role="status" aria-busy="true" className="p-12 text-center text-[14px] text-muted">Loading…</div>
      </main>
    )
  }

  // A client sees their own company. Team roles pick one with ?client=; the first with projects is the default.
  const company: Company | undefined = isClient
    ? companies.find(c => c.id === session?.orgId)
    : companies.find(c => c.id === params.get('client')) ?? companies.find(c => c.projects.length) ?? companies[0]
  const members = company ? teamQ.data.filter(m => m.companyId === company.id) : []
  const projects = company?.projects ?? []
  const count = projects.length

  /** Shows the project's board, filtered to its epics. The project is kept in the URL (?project=), so a reload keeps it. */
  const openProject = (p: ClientProject) => {
    const ids = p.epics.map(e => e.id).filter(id => wsQ.data.epics.some(x => x.id === id))
    if (ids.length) ui.setEpics(ids)
    navigate(clientsPath('board', p.id))
  }

  return (
    <main className="flex flex-col gap-5 px-7 pb-14 pt-6">
      <header className="flex flex-wrap items-end gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-bold uppercase tracking-[0.08em] text-muted">{isClient ? 'Project portal' : 'Clients'}</div>
          <h1 className="mt-1 text-[26px] font-extrabold tracking-[-0.02em] text-ink">Your projects</h1>
          {company && (
            <div className="mt-1 text-[14px] text-ink-2">
              {company.name} · {count} {count === 1 ? 'project' : 'projects'}
            </div>
          )}
        </div>
        {!isClient && companies.length > 0 && (
          <label className="flex items-center gap-2 text-[13px] font-semibold text-ink-2">
            Client
            <select
              value={company?.id ?? ''}
              onChange={e => navigate({ search: '?client=' + encodeURIComponent(e.target.value) }, { replace: true })}
              className="h-[34px] rounded-lg border-[1.5px] border-line bg-white px-2.5 text-[13.5px] font-semibold text-ink"
            >
              {companies.map(c => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {company && (
          <button
            type="button"
            onClick={() => navigate('/clients/board?report=1')}
            className="inline-flex h-[34px] cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-red pl-2 pr-3 text-[13.5px] font-semibold text-white hover:bg-red-600"
          >
            <span className="grid size-5 place-items-center rounded-[5px] bg-white/[.18]">
              <Icon d={PATHS.bug} size={12} />
            </span>
            Report a bug
          </button>
        )}
      </header>

      {!company ? (
        <div role="status" className="rounded-[14px] border-[1.5px] border-dashed border-line p-8 text-center text-[14px] text-ink-2">
          {isClient ? 'Your account is not linked to a client company yet. Ask your Viljetech contact to add you.' : 'No client companies yet.'}
        </div>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-label="Projects" className="grid gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))' }}>
            {count === 0 && (
              <div className="rounded-[14px] border-[1.5px] border-dashed border-line p-8 text-center text-[14px] text-ink-2 [grid-column:1/-1]">
                No projects yet.
              </div>
            )}
            {projects.map(p => {
              // v5: Daco's delivered InvoiceMatch project has its own card, with its live app.
              if (p.id === IM_PROJECT_ID) return <LiveProjectCard key={p.id} project={p} onOpen={() => openProject(p)} />
              const [label, ink, soft] = PROJECT_STATE[p.state]
              const ms = nextMilestone(p, wsQ.data)
              return (
                <article key={p.id} aria-label={p.name} className="flex flex-col gap-3 rounded-2xl bg-white p-5 shadow-[0_0_0_1.5px_#D6DEE8]">
                  <div className="flex items-start gap-2.5">
                    <h2 className="min-w-0 flex-1 text-[17px] font-bold leading-snug text-ink">{p.name}</h2>
                    <span className="inline-flex h-[22px] flex-none items-center rounded-md px-2 text-[12px] font-bold" style={{ background: soft, color: ink }}>
                      {label}
                    </span>
                  </div>
                  {p.desc && <p className="clamp-2 text-[13.5px] leading-normal text-ink-2">{p.desc}</p>}
                  <div>
                    <div className="flex items-center justify-between text-[12.5px] font-semibold text-ink-2">
                      <span>Progress</span>
                      <span className="tnum">{p.pct}%</span>
                    </div>
                    <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-sky-3">
                      <div className="h-full rounded-full bg-blue" style={{ width: p.pct + '%' }} />
                    </div>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-[13px]">
                    <div className="min-w-0">
                      <dt className="text-[12px] font-semibold text-muted">Next milestone</dt>
                      <dd className="mt-0.5 truncate font-semibold text-ink">{ms ? `${ms.name} · ${fmt(ms.target ?? '')}` : 'None set'}</dd>
                    </div>
                    <div className="min-w-0">
                      <dt className="text-[12px] font-semibold text-muted">Due</dt>
                      <dd className="mt-0.5 font-semibold text-ink">{p.due ? fmt(p.due) : 'Not set'}</dd>
                    </div>
                  </dl>
                  <button
                    type="button"
                    onClick={() => openProject(p)}
                    className="mt-auto h-9 cursor-pointer self-start rounded-[10px] border-[1.5px] border-line bg-white px-3.5 text-[13px] font-bold text-blue-ink hover:border-blue"
                  >
                    Open project ›
                  </button>
                </article>
              )
            })}
          </section>

          <TeamPanel company={company} members={members} canManage={isClient && session?.role === 'cadmin'} />
        </div>
      )}
    </main>
  )
}
