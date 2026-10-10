import { useMemo, useState, type DragEvent } from 'react'
import { Link } from 'react-router'
import { useCompanies, useInternalProjects, useSend } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { useSession } from '../../api/session/store'
import type { ProjectRef, ProjectState } from '../../api/types'
import { Icon, PATHS, CountPill, TabButton } from '../../components/ui'
import { PersonDot, ProgressRing, SearchGlyph, StatePill } from '../../components/Bits'
import { STATE_COLUMNS, STATE_LABEL, STATE_TONE, dueLabel, isOverdue, projectItems, refKey, sortProjects, type ProjectItem } from '../../domain/projects'
import { plural } from '../../lib/dates'
import { NewProjectDialog } from './NewProjectDialog'

type Kind = 'all' | 'client' | 'internal'
type StateFilter = 'any' | ProjectState
type View = 'board' | 'list'

const STATE_OPTIONS: { value: StateFilter; label: string }[] = [
  { value: 'any', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'planned', label: 'Planned' },
  { value: 'hold', label: 'On hold' },
  { value: 'done', label: 'Done' },
]

const DUE_TONE = { overdue: 'text-red', soon: 'text-amber-ink', normal: 'text-muted', none: 'text-muted' } as const

/**
 * Projects: client projects (under their companies) and internal projects on
 * one board or list. Developers see only the projects they are on.
 */
export function ProjectsPage() {
  const companies = useCompanies().data
  const internal = useInternalProjects().data
  const people = usePeople().data ?? []
  const session = useSession()
  const move = useSend()
  const [kind, setKind] = useState<Kind>('all')
  const [st, setSt] = useState<StateFilter>('any')
  const [q, setQ] = useState('')
  const [view, setView] = useState<View>('board')
  const [creating, setCreating] = useState<{ state?: ProjectState } | null>(null)
  const [dragOver, setDragOver] = useState<ProjectState | null>(null)

  const isDev = session?.role === 'dev'
  const everything = useMemo(() => projectItems(companies ?? [], internal ?? []), [companies, internal])
  const mine = useMemo(
    () => (isDev && session ? everything.filter(p => p.team.includes(session.personId)) : everything),
    [everything, isDev, session],
  )
  const needle = q.trim().toLowerCase()
  const filtered = mine.filter(
    p =>
      (kind === 'all' || p.kind === kind) &&
      (st === 'any' || p.state === st) &&
      (!needle || [p.name, p.companyName, p.area].some(v => v.toLowerCase().includes(needle))),
  )
  const kpis = {
    active: mine.filter(p => p.state === 'active').length,
    client: mine.filter(p => p.kind === 'client').length,
    internal: mine.filter(p => p.kind === 'internal').length,
    overdue: mine.filter(p => isOverdue(p)).length,
  }
  const title = isDev ? 'My projects' : 'Projects'
  const byKey = useMemo(() => new Map(everything.map(p => [refKey(p.ref), p])), [everything])

  const moveTo = (ref: ProjectRef, state: ProjectState) => {
    move(ref.kind === 'client' ? { type: 'project.client.setState', companyId: ref.companyId, id: ref.id, state } : { type: 'project.internal.setState', id: ref.id, state })
  }

  const onDrop = (e: DragEvent, state: ProjectState) => {
    e.preventDefault()
    setDragOver(null)
    const item = byKey.get(e.dataTransfer.getData('text/plain'))
    if (item && item.state !== state) moveTo(item.ref, state)
  }

  return (
    <main className="px-7 pb-14 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[24px] font-extrabold tracking-[-0.01em]">{title}</h1>
          <p className="mt-1 text-[13.5px] text-muted">{`${plural(mine.length, 'project')} · ${kpis.active} active`}</p>
        </div>
        <button
          type="button"
          onClick={() => setCreating({})}
          className="h-10 cursor-pointer rounded-[10px] bg-blue px-4 text-[13.5px] font-bold text-white hover:bg-blue-600"
        >
          New project
        </button>
      </div>

      <dl className="mt-5 grid grid-cols-4 gap-3 max-[860px]:grid-cols-2">
        <Kpi label="Active projects" value={kpis.active} />
        <Kpi label="Client projects" value={kpis.client} />
        <Kpi label="Internal projects" value={kpis.internal} />
        <Kpi label="Overdue" value={kpis.overdue} tone={kpis.overdue ? 'text-red' : undefined} />
      </dl>

      {/* Toolbar */}
      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <nav className="flex gap-5 border-b border-line-2" aria-label="Filter by kind">
          {(['all', 'client', 'internal'] as const).map(k => (
            <TabButton key={k} on={kind === k} onClick={() => setKind(k)}>
              {k === 'all' ? 'All' : k === 'client' ? 'Client' : 'Internal'}
              <CountPill n={k === 'all' ? mine.length : k === 'client' ? kpis.client : kpis.internal} />
            </TabButton>
          ))}
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2.5">
          <select
            aria-label="Status"
            value={st}
            onChange={e => setSt(e.target.value as StateFilter)}
            className="h-9 cursor-pointer rounded-[9px] border-[1.5px] border-line bg-white px-3 text-[13px] font-semibold text-ink outline-0 focus:border-blue"
          >
            {STATE_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <label className="relative block w-[240px]">
            <span className="sr-only">Search projects</span>
            <SearchGlyph className="absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
            <input
              type="search"
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search projects, companies, areas"
              className="h-9 w-full rounded-[9px] border-[1.5px] border-line bg-white pl-9 pr-3 text-[13px] text-ink outline-0 focus:border-blue"
            />
          </label>
          <div className="flex rounded-[9px] border-[1.5px] border-line bg-white p-0.5" role="group" aria-label="View">
            {(['board', 'list'] as const).map(v => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`h-7 cursor-pointer rounded-[7px] px-3 text-[12.5px] font-semibold ${view === v ? 'bg-sky-3 text-blue-ink' : 'text-muted'}`}
              >
                {v === 'board' ? 'Cards' : 'List'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mine.length === 0 ? (
        <div className="mt-6 rounded-2xl border-[1.5px] border-dashed border-line bg-white px-6 py-10 text-center text-[13.5px] text-muted">
          {isDev ? 'You are not on any project yet.' : 'No projects yet. Start one with New project.'}
        </div>
      ) : view === 'board' ? (
        <div className="mt-5 grid grid-cols-4 items-start gap-3.5 max-[1100px]:grid-cols-2 max-[640px]:grid-cols-1">
          {STATE_COLUMNS.map(state => {
            const items = sortProjects(filtered.filter(p => p.state === state))
            const over = dragOver === state
            return (
              <section
                key={state}
                aria-label={`${STATE_LABEL[state]} column`}
                onDragOver={e => {
                  e.preventDefault()
                  if (dragOver !== state) setDragOver(state)
                }}
                onDragLeave={() => setDragOver(cur => (cur === state ? null : cur))}
                onDrop={e => onDrop(e, state)}
                className={`min-h-[240px] rounded-2xl p-2.5 transition-colors ${over ? 'bg-sky-2 ring-2 ring-blue' : 'bg-[#EEF2F7]'}`}
              >
                <header className="mb-2.5 flex items-center gap-2 px-1">
                  <span className="size-2 rounded-full" style={{ background: STATE_TONE[state].dot }} />
                  <h2 className="m-0 text-[13.5px] font-extrabold">{STATE_LABEL[state]}</h2>
                  <CountPill n={items.length} />
                  <button
                    type="button"
                    aria-label={`New project in ${STATE_LABEL[state]}`}
                    title={`New project in ${STATE_LABEL[state]}`}
                    onClick={() => setCreating({ state })}
                    className="ml-auto grid size-7 cursor-pointer place-items-center rounded-lg border-[1.5px] border-line bg-white text-blue-ink hover:border-blue"
                  >
                    <Icon d={PATHS.plus} size={13} sw={2.6} />
                  </button>
                </header>
                <div className="flex flex-col gap-2.5">
                  {items.map(p => (
                    <ProjectCard key={refKey(p.ref)} item={p} people={people} onMove={state => moveTo(p.ref, state)} />
                  ))}
                  {items.length === 0 && <p className="m-0 px-1 py-6 text-center text-[12.5px] text-muted">No projects</p>}
                </div>
              </section>
            )
          })}
        </div>
      ) : (
        <ProjectList items={sortProjects(filtered)} people={people} />
      )}

      {mine.length > 0 && filtered.length === 0 && view === 'list' && (
        <p className="mt-4 text-[13.5px] text-muted">No projects match your filters.</p>
      )}

      {creating && (
        <NewProjectDialog
          initialState={creating.state}
          onClose={() => setCreating(null)}
          onCreated={() => {
            setKind('all')
            setSt('any')
            setQ('')
          }}
        />
      )}
    </main>
  )
}

function ProjectCard({ item: p, people, onMove }: { item: ProjectItem; people: { id: number; name: string; colour: string }[]; onMove: (state: ProjectState) => void }) {
  const due = dueLabel(p.due, p.state)
  const team = p.team.map(id => people.find(x => x.id === id)).filter((x): x is { id: number; name: string; colour: string } => !!x)
  return (
    <article
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', refKey(p.ref))
        e.dataTransfer.effectAllowed = 'move'
      }}
      className="relative cursor-grab rounded-[12px] border-[1.5px] border-line bg-white p-3 shadow-[0_1px_2px_rgba(27,45,69,0.06)] hover:border-blue active:cursor-grabbing"
    >
      <div className="flex items-center gap-2">
        {p.kind === 'client' ? (
          <span className="rounded-full bg-sky-3 px-2 py-[2px] text-[11px] font-semibold text-blue-ink">Client</span>
        ) : (
          <span className="rounded-full bg-ink px-2 py-[2px] text-[11px] font-semibold text-white">Internal</span>
        )}
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{p.kind === 'client' ? p.companyName : p.area}</span>
      </div>
      <Link
        to="/tickets/board"
        aria-label={`Open ${p.name}`}
        className="mt-2 block text-[14.5px] font-bold leading-snug text-ink no-underline after:absolute after:inset-0 after:content-[''] hover:text-blue-ink"
      >
        {p.name}
      </Link>
      <p className="m-0 mt-1 line-clamp-2 text-[12.5px] leading-[1.45] text-muted">{p.desc || 'No description'}</p>
      <div className="mt-3 flex items-center gap-2.5">
        <ProgressRing pct={p.pct} size={36} color={STATE_TONE[p.state].dot} />
        <span className="min-w-0 flex-1 text-[11.5px] text-muted">{p.kind === 'client' ? (p.epics ? plural(p.epics, 'epic') : 'No epics') : ''}</span>
        <span className={`text-right text-[11.5px] font-semibold ${DUE_TONE[due.tone]}`}>{due.text}</span>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-line-3 pt-2.5">
        <div className="flex -space-x-1.5">
          {team.slice(0, 4).map(t => (
            <PersonDot key={t.id} name={t.name} colour={t.colour} size={22} />
          ))}
          {team.length > 4 && <span className="grid size-[22px] place-items-center rounded-[7px] bg-line-3 text-[10px] font-bold text-slate">+{team.length - 4}</span>}
        </div>
        <select
          aria-label={`Move ${p.name} to`}
          value={p.state}
          onChange={e => onMove(e.target.value as ProjectState)}
          onClick={e => e.stopPropagation()}
          className="relative z-10 ml-auto h-7 cursor-pointer rounded-[7px] border-[1.5px] border-line bg-white px-1.5 text-[11.5px] font-semibold text-ink-2 outline-0"
        >
          {STATE_COLUMNS.map(s => (
            <option key={s} value={s}>
              {STATE_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
    </article>
  )
}

function ProjectList({ items, people }: { items: ProjectItem[]; people: { id: number; name: string; colour: string }[] }) {
  if (items.length === 0) return null
  return (
    <div className="mt-5 overflow-x-auto rounded-2xl border-[1.5px] border-line bg-white">
      <table className="w-full min-w-[760px] border-collapse text-left text-[13px]">
        <thead>
          <tr className="border-b border-line-2 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">
            <th className="px-4 py-2.5 font-bold">Project</th>
            <th className="px-3 py-2.5 font-bold">Kind</th>
            <th className="px-3 py-2.5 font-bold">Company or area</th>
            <th className="px-3 py-2.5 font-bold">State</th>
            <th className="px-3 py-2.5 font-bold">Progress</th>
            <th className="px-3 py-2.5 font-bold">Due</th>
            <th className="px-3 py-2.5 font-bold">Team</th>
          </tr>
        </thead>
        <tbody>
          {items.map(p => {
            const due = dueLabel(p.due, p.state)
            return (
              <tr key={refKey(p.ref)} className="border-b border-line-3 last:border-0 hover:bg-canvas">
                <td className="px-4 py-2.5">
                  <Link to="/tickets/board" className="font-bold text-ink no-underline hover:text-blue-ink">
                    {p.name}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-muted">{p.kind === 'client' ? 'Client' : 'Internal'}</td>
                <td className="px-3 py-2.5 text-ink-2">{p.kind === 'client' ? p.companyName : p.area}</td>
                <td className="px-3 py-2.5">
                  <StatePill state={p.state} />
                </td>
                <td className="px-3 py-2.5 tnum">{p.pct}%</td>
                <td className={`px-3 py-2.5 font-semibold ${DUE_TONE[due.tone]}`}>{due.text}</td>
                <td className="px-3 py-2.5">
                  <div className="flex -space-x-1.5">
                    {p.team
                      .map(id => people.find(x => x.id === id))
                      .filter((x): x is { id: number; name: string; colour: string } => !!x)
                      .map(t => (
                        <PersonDot key={t.id} name={t.name} colour={t.colour} size={22} />
                      ))}
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-[14px] border-[1.5px] border-line bg-white px-4 py-3">
      <dt className="text-[11.5px] font-semibold text-muted">{label}</dt>
      <dd className={`m-0 mt-1 text-[22px] font-extrabold tnum ${tone ?? 'text-ink'}`}>{value}</dd>
    </div>
  )
}
