import { useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useCompanies, useSendAsync } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { companyState, companyStats } from '../../domain/companies'
import { dueLabel, sortProjects, STATE_TONE } from '../../domain/projects'
import { fmt } from '../../lib/dates'
import { PersonDot, ProgressRing, StatePill, TextPill } from '../../components/Bits'
import { Icon, PATHS } from '../../components/ui'
import { useToast } from '../shell/toast'
import { CompanyFormModal } from './CompanyFormModal'
import { ContactDialog } from './ContactDialog'
import { ResponsibleDialog } from './ResponsibleDialog'
import { ArchiveDialog } from './ArchiveDialog'
import { LogoField } from './LogoField'
import { NewProjectDialog } from '../projects/NewProjectDialog'

type Modal =
  | { kind: 'edit'; focus?: 'web' }
  | { kind: 'archive' }
  | { kind: 'contact'; index: number | null }
  | { kind: 'responsible'; personId: number | null }
  | { kind: 'project' }

type ProjectFilter = 'all' | 'ongoing' | 'done'
const PROJECT_TABS: { id: ProjectFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ongoing', label: 'Ongoing' },
  { id: 'done', label: 'Done' },
]

/** One company: its header, KPIs, projects, client contacts, responsibilities and notes. */
export function CompanyDetailPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const companies = useCompanies().data
  const people = usePeople().data ?? []
  const send = useSendAsync()
  const toast = useToast()
  const [modal, setModal] = useState<Modal | null>(null)
  const [pf, setPf] = useState<ProjectFilter>('all')

  if (!companies) return <p className="px-7 pt-6 text-[13.5px] text-muted">Loading company…</p>
  const c = companies.find(x => x.id === id)
  if (!c) {
    return (
      <main className="px-7 pb-14 pt-4">
        <Link to="/companies" className="text-[13px] font-semibold text-blue-ink">
          ‹ Back to Companies
        </Link>
        <p className="mt-6 text-[14px] text-muted">This company does not exist, or it was removed.</p>
      </main>
    )
  }

  const state = companyState(c)
  const stats = companyStats(c)
  const vtPeople = people.filter(p => p.org === 'vt' && p.active)
  const responsible = Object.keys(c.ourRoles).map(Number)
  const visibleProjects = sortProjects(c.projects).filter(p => pf === 'all' || (pf === 'done' ? p.state === 'done' : p.state !== 'done'))
  const timesheetsHref = `/timesheet?company=${encodeURIComponent(c.id)}&name=${encodeURIComponent(c.name)}&projects=${encodeURIComponent(c.projects.map(p => p.id).join(','))}`

  const setLogo = async (logo: string) => {
    try {
      await send({ type: 'company.update', id: c.id, patch: { logo } })
      toast(logo ? 'Logo saved' : 'Logo removed')
    } catch {
      toast('The logo could not be saved. Try again.')
    }
  }

  const restore = async () => {
    try {
      await send({ type: 'company.archive', id: c.id, archived: false, at: null })
      toast(`${c.name} is restored`)
    } catch {
      toast('The company could not be restored. Try again.')
    }
  }

  return (
    <main className="px-7 pb-14 pt-4">
      <Link to="/companies" className="inline-flex items-center gap-1 text-[13px] font-semibold text-blue-ink hover:underline">
        <Icon d={PATHS.back} size={13} sw={2.6} />
        Back to Companies
      </Link>

      {/* Header */}
      <section className={`mt-4 rounded-2xl border-[1.5px] border-line bg-white p-5 ${c.archived ? 'opacity-90' : ''}`}>
        <div className="flex flex-wrap items-start gap-5">
          <LogoField name={c.name} p={c.p} value={c.logo ?? ''} onChange={setLogo} size={72} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 text-[26px] font-extrabold tracking-[-0.01em]">{c.name}</h1>
              <StateTag state={state} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px] text-muted">
              {c.industry && <span>{c.industry}</span>}
              {c.country && <span>{c.country}</span>}
              {c.web ? (
                <a href={`https://${c.web}`} target="_blank" rel="noreferrer" className="font-semibold text-blue-ink hover:underline">
                  {c.web}
                </a>
              ) : (
                <button
                  type="button"
                  onClick={() => setModal({ kind: 'edit', focus: 'web' })}
                  className="cursor-pointer font-semibold text-blue-ink hover:underline"
                >
                  + Website
                </button>
              )}
              <Link to={timesheetsHref} className="font-semibold text-blue-ink hover:underline">
                Timesheets
              </Link>
            </div>
            {c.archived && (
              <p className="mt-3 rounded-[10px] bg-amber-soft px-3 py-2 text-[12.5px] font-semibold text-amber-ink">
                {`Archived on ${c.archivedAt ? fmt(c.archivedAt) : 'an earlier date'}. It is hidden from the company list and can be restored at any time.`}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setModal({ kind: 'edit' })} className={pillBtn}>
              Edit
            </button>
            {!c.archived && (
              <button type="button" onClick={() => setModal({ kind: 'project' })} className="h-9 cursor-pointer rounded-[10px] bg-blue px-4 text-[13px] font-bold text-white hover:bg-blue-600">
                Start new project
              </button>
            )}
            {c.archived ? (
              <button type="button" onClick={restore} className={pillBtn}>
                Restore company
              </button>
            ) : (
              <button type="button" onClick={() => setModal({ kind: 'archive' })} className={pillBtn}>
                Archive
              </button>
            )}
          </div>
        </div>
      </section>

      {/* KPIs */}
      <dl className="mt-4 grid grid-cols-5 gap-3 max-[900px]:grid-cols-3 max-[560px]:grid-cols-2">
        <Kpi label="Active projects" value={String(stats.active)} />
        <Kpi label="All projects" value={String(stats.projects)} />
        <Kpi label="Avg. progress" value={stats.avgPct === null ? '—' : `${stats.avgPct}%`} />
        <Kpi label="Overdue" value={String(stats.overdue)} tone={stats.overdue ? 'text-red' : undefined} />
        <Kpi label="People on it" value={String(stats.people.length)} />
      </dl>

      <div className="mt-4 grid items-start gap-4 [grid-template-columns:minmax(0,1fr)_340px] max-[980px]:grid-cols-1">
        {/* Projects */}
        <Panel
          title="Projects"
          aside={
            <div className="flex gap-1 rounded-[9px] bg-canvas p-0.5" role="tablist" aria-label="Filter projects">
              {PROJECT_TABS.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={pf === t.id}
                  onClick={() => setPf(t.id)}
                  className={`h-7 cursor-pointer rounded-[7px] px-2.5 text-[12px] font-semibold ${pf === t.id ? 'bg-white text-ink shadow-[0_1px_2px_rgba(27,45,69,0.12)]' : 'text-muted'}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        >
          {c.projects.length === 0 ? (
            <Empty>No projects with {c.name} yet.</Empty>
          ) : visibleProjects.length === 0 ? (
            <Empty>No projects in this view.</Empty>
          ) : (
            <ul className="m-0 list-none divide-y divide-line-3 p-0">
              {visibleProjects.map(p => {
                const due = dueLabel(p.due, p.state, p.sup)
                return (
                  <li key={p.id}>
                    <Link to="/tickets/board" className="flex items-center gap-4 py-3 text-ink no-underline hover:text-blue-ink">
                      <ProgressRing pct={p.pct} size={40} color={STATE_TONE[p.state].dot} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] font-bold">{p.name}</span>
                        <span className="block truncate text-[12.5px] text-muted">{p.desc || 'No description'}</span>
                      </span>
                      <span className="hidden flex-col items-end gap-1 sm:flex">
                        <StatePill state={p.state} />
                        <span className={`text-[11.5px] font-semibold ${DUE_TONE[due.tone]}`}>{due.text}</span>
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
        </Panel>

        <div className="flex flex-col gap-4">
          {/* Client contacts */}
          <Panel title="Client contacts" action={<AddButton onClick={() => setModal({ kind: 'contact', index: null })} />}>
            {c.contacts.length === 0 ? (
              <Empty>Nobody added yet.</Empty>
            ) : (
              <ul className="m-0 list-none p-0">
                {c.contacts.map((k, i) => (
                  <li key={`${k.name}-${i}`}>
                    <button
                      type="button"
                      onClick={() => setModal({ kind: 'contact', index: i })}
                      className="flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-canvas"
                    >
                      <span className="grid size-8 flex-none place-items-center rounded-[8px] bg-line-3 text-[11px] font-bold text-slate">
                        {k.name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold">
                          {k.name}
                          {k.admin && <span className="ml-1.5 rounded-full bg-sky-3 px-1.5 text-[10.5px] text-blue-ink">Admin</span>}
                        </span>
                        <span className="block truncate text-[12px] text-muted">{[k.role, k.email].filter(Boolean).join(' · ') || 'No role or email'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          {/* Responsible from Viljetech */}
          <Panel title="Responsible from Viljetech" action={<AddButton onClick={() => setModal({ kind: 'responsible', personId: null })} />}>
            {responsible.length === 0 ? (
              <Empty>Nobody added yet.</Empty>
            ) : (
              <ul className="m-0 list-none p-0">
                {responsible.map(pid => {
                  const person = people.find(p => p.id === pid)
                  if (!person) return null
                  const role = c.ourRoles[pid]
                  const count = c.projects.filter(p => p.team.includes(pid)).length
                  return (
                    <li key={pid}>
                      <button
                        type="button"
                        onClick={() => setModal({ kind: 'responsible', personId: pid })}
                        className="flex w-full cursor-pointer items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-canvas"
                      >
                        <PersonDot name={person.name} colour={person.colour} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold">{person.name}</span>
                          <span className="block text-[12px] text-muted">{`${role} · ${count} ${count === 1 ? 'project' : 'projects'}`}</span>
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Panel>

          {/* About */}
          <Panel title="About">
            {c.notes ? (
              <p className="m-0 whitespace-pre-line text-[13.5px] leading-[1.6] text-ink-2">{c.notes}</p>
            ) : (
              <Empty>Nothing written yet.</Empty>
            )}
          </Panel>
        </div>
      </div>

      {modal?.kind === 'edit' && <CompanyFormModal mode="edit" company={c} focus={modal.focus} onClose={() => setModal(null)} />}
      {modal?.kind === 'archive' && (
        <ArchiveDialog
          company={c}
          activeCount={stats.active}
          onClose={() => setModal(null)}
          onArchived={() => {
            setModal(null)
            toast(`${c.name} is archived`)
            navigate('/companies')
          }}
        />
      )}
      {modal?.kind === 'contact' && (
        <ContactDialog
          companyId={c.id}
          projects={c.projects}
          contact={modal.index === null ? null : c.contacts[modal.index] ?? null}
          index={modal.index}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.kind === 'responsible' && (
        <ResponsibleDialog company={c} people={vtPeople} personId={modal.personId} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'project' && (
        <NewProjectDialog companyId={c.id} onClose={() => setModal(null)} onCreated={() => toast(`Project started for ${c.name}`)} />
      )}
    </main>
  )
}

const pillBtn = 'h-9 cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white px-3.5 text-[13px] font-semibold text-ink hover:border-blue hover:text-blue-ink'

const DUE_TONE: Record<'overdue' | 'soon' | 'normal' | 'none', string> = {
  overdue: 'text-red',
  soon: 'text-amber-ink',
  normal: 'text-muted',
  none: 'text-muted',
}

function StateTag({ state }: { state: ReturnType<typeof companyState> }) {
  const style: Record<typeof state, [string, string]> = {
    Active: [STATE_TONE.active.ink, STATE_TONE.active.soft],
    New: [STATE_TONE.planned.ink, STATE_TONE.planned.soft],
    'No active work': [STATE_TONE.hold.ink, STATE_TONE.hold.soft],
    Archived: ['#3B4A5E', '#E4EAF0'],
  }
  const [ink, soft] = style[state]
  return <TextPill ink={ink} soft={soft}>{state}</TextPill>
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-[14px] border-[1.5px] border-line bg-white px-4 py-3">
      <dt className="text-[11.5px] font-semibold text-muted">{label}</dt>
      <dd className={`m-0 mt-1 text-[22px] font-extrabold tnum ${tone ?? 'text-ink'}`}>{value}</dd>
    </div>
  )
}

function Panel({ title, action, aside, children }: { title: string; action?: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-2xl border-[1.5px] border-line bg-white p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="m-0 min-w-0 flex-1 text-[15px] font-extrabold">{title}</h2>
        {aside}
        {action}
      </div>
      {children}
    </section>
  )
}

function AddButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="h-7 cursor-pointer rounded-[8px] border-[1.5px] border-line bg-white px-2.5 text-[12px] font-semibold text-blue-ink hover:border-blue">
      + Add
    </button>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 py-3 text-[13px] text-muted">{children}</p>
}
