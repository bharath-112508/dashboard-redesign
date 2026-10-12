import { useState } from 'react'
import { useSearchParams } from 'react-router'
import { useCompanies, useEntries, useInternalProjects, useTasks, useWeekSubmissions } from '../../api/queries'
import { findPerson, usePeople } from '../../api/people/directory'
import { useSession } from '../../api/session/store'
import { clientValue, findProject, internalValue, projectOptions } from '../../api/timesheet/projects'
import { weekStart } from '../../api/timesheet/week'
import { TODAY } from '../../lib/dates'
import { HistoryView, type HistoryScope } from './HistoryView'
import { WeekView } from './WeekView'
import type { TimeCtx } from './model'

type Tab = 'week' | 'history'

/**
 * My timesheet (/timesheet). Shows the signed-in person's time from the shared
 * time store: the week view with the log form and week submit, and the history.
 * A Companies or Projects "Timesheet" link (`?company=<id>` or `?project=<id>`, with an optional
 * `name`) opens the history as the page itself, limited to that company's projects or that one project.
 */
export function TimesheetPage() {
  const session = useSession()
  const [params, setParams] = useSearchParams()
  const companyId = params.get('company')
  const projectId = companyId ? null : params.get('project')
  const [tab, setTab] = useState<Tab>('week')
  const [week, setWeek] = useState(() => weekStart(TODAY))

  const people = usePeople().data
  const entries = useEntries().data
  const tasks = useTasks().data
  const companies = useCompanies().data
  const internal = useInternalProjects().data
  const submissions = useWeekSubmissions().data

  if (!session) return null // The shell sends signed-out users to sign-in.
  if (!people || !entries || !tasks || !companies || !internal || !submissions) {
    return <p className="px-7 py-10 text-[14px] text-ink-2">Loading your timesheet…</p>
  }
  const me = findPerson(people, session.personId)
  if (!me) {
    return (
      <main className="px-7 pb-14 pt-10">
        <div className="mx-auto max-w-[520px] rounded-2xl border-[1.5px] border-line-2 bg-white p-8 text-center text-[14px] text-ink-2">
          Your account is not in the people directory, so there is no timesheet to show.
        </div>
      </main>
    )
  }

  const ctx: TimeCtx = {
    me,
    freelancer: session.emp === 'freelancer' || me.emp === 'freelancer',
    today: TODAY,
    tasks,
    companies,
    internal,
    mine: entries.filter(e => e.userId === me.id),
    submissions,
    companyId,
  }
  const projects = projectOptions(companies, internal, companyId)

  const scope = scopeOf(params, companyId, projectId, ctx)
  if (scope) {
    const leave = () => {
      for (const k of ['company', 'project', 'projects', 'name']) params.delete(k)
      setTab('week')
      setParams(params, { replace: true })
    }
    return (
      <main className="flex flex-col gap-4 px-7 pb-10 pt-5">
        <header className="min-w-0">
          <h1 className="font-serif text-[30px] leading-tight text-ink">Timesheets · {scope.name}</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {me.name} · {session.org}
          </p>
        </header>
        {!scope.values.length && (
          <div className="rounded-[12px] border-[1.5px] border-line-2 bg-white px-4 py-2.5 text-[13px] text-ink-2">
            No {projectId ? 'project' : 'company'} matches this link, so no time is shown.
          </div>
        )}
        <HistoryView key={params.toString()} ctx={ctx} scope={scope} onLeaveScope={leave} />
      </main>
    )
  }

  const tabBtn = (id: Tab, label: string) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`h-9 cursor-pointer rounded-[9px] border-0 px-4 text-[13.5px] font-semibold ${
        tab === id ? 'bg-white text-ink shadow-[0_1px_2px_rgba(27,45,69,0.12)]' : 'bg-transparent text-ink-2'
      }`}
    >
      {label}
    </button>
  )

  return (
    <main className="flex flex-col gap-5 px-7 pb-14 pt-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="font-serif text-[30px] leading-tight text-ink">My timesheet</h1>
          <p className="mt-1 text-[13.5px] text-ink-2">
            {me.name} · {session.org}
          </p>
        </div>
        <div role="tablist" aria-label="Timesheet views" className="flex gap-1 rounded-[11px] bg-sky-2 p-1">
          {tabBtn('week', 'This week')}
          {tabBtn('history', 'History')}
        </div>
      </header>

      {tab === 'week' ? (
        <WeekView ctx={ctx} projects={projects} week={week} setWeek={setWeek} />
      ) : (
        <HistoryView ctx={ctx} />
      )}
    </main>
  )
}

/** The scope of a Companies (`?company=`) or Projects (`?project=`) link, or null for the plain page. */
function scopeOf(params: URLSearchParams, companyId: string | null, projectId: string | null, ctx: TimeCtx): HistoryScope | null {
  const name = params.get('name')
  if (companyId) {
    const co = ctx.companies.find(c => c.id === companyId)
    const fromUrl = (params.get('projects') || '').split(',').filter(Boolean)
    const ids = fromUrl.length ? fromUrl : co ? co.projects.map(p => p.id) : []
    return { name: name || co?.name || companyId, values: ids.map(clientValue), single: false }
  }
  if (projectId) {
    const client = findProject(clientValue(projectId), ctx.companies, ctx.internal)
    const own = client ?? findProject(internalValue(projectId), ctx.companies, ctx.internal)
    // "Daco · Daco platform" for a client project, the bare name for an internal one.
    const label = own ? (client ? own.label : own.label.replace(/^Internal · /, '')) : projectId
    return { name: name || label, values: own ? [own.value] : [], single: true }
  }
  return null
}
