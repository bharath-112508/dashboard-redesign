import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { useCompanies } from '../../api/queries'
import { usePeople, findPerson } from '../../api/people/directory'
import type { Company, Person } from '../../api/types'
import { companyState, companyStats, matchesFilter, matchesQuery, selectableCompanies, type CompanyFilter } from '../../domain/companies'
import { STATE_TONE } from '../../domain/projects'
import { CountPill, TabButton } from '../../components/ui'
import { LogoTile, PersonDot, SearchGlyph, TextPill } from '../../components/Bits'
import { CompanyFormModal } from './CompanyFormModal'
import { pal } from '../../lib/theme'
import { plural } from '../../lib/dates'

const STATE_STYLE: Record<ReturnType<typeof companyState>, { ink: string; soft: string }> = {
  Active: { ink: STATE_TONE.active.ink, soft: STATE_TONE.active.soft },
  New: { ink: STATE_TONE.planned.ink, soft: STATE_TONE.planned.soft },
  'No active work': { ink: STATE_TONE.hold.ink, soft: STATE_TONE.hold.soft },
  Archived: { ink: '#3B4A5E', soft: '#E4EAF0' },
}

const TABS: { id: CompanyFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'new', label: 'New' },
  { id: 'archived', label: 'Archived' },
]

/** Companies list: search, filter tabs and a card per company. */
export function CompaniesPage() {
  const companies = useCompanies().data
  const people = usePeople().data ?? []
  const [filter, setFilter] = useState<CompanyFilter>('all')
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)

  const all = companies ?? []
  const live = useMemo(() => selectableCompanies(all), [all])
  const counts = useMemo(() => {
    const n = (f: CompanyFilter) => all.filter(c => matchesFilter(c, f)).length
    return { all: n('all'), active: n('active'), new: n('new'), archived: n('archived') }
  }, [all])
  const visible = all.filter(c => matchesFilter(c, filter) && matchesQuery(c, q))
  const activeProjects = live.reduce((s, c) => s + c.projects.filter(p => p.state === 'active').length, 0)

  return (
    <main className="px-7 pb-14 pt-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[24px] font-extrabold tracking-[-0.01em]">Companies</h1>
          <p className="mt-1 text-[13.5px] text-muted">
            {`${plural(live.length, 'company', 'companies')} · ${plural(activeProjects, 'active project')}`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="h-10 cursor-pointer rounded-[10px] bg-blue px-4 text-[13.5px] font-bold text-white hover:bg-blue-600"
        >
          New company
        </button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line-2">
        <nav className="flex gap-6" aria-label="Filter companies">
          {TABS.map(t => (
            <TabButton key={t.id} on={filter === t.id} onClick={() => setFilter(t.id)}>
              {t.label} <CountPill n={counts[t.id]} />
            </TabButton>
          ))}
        </nav>
        <label className="relative ml-auto mb-3 block w-full max-w-[300px]">
          <span className="sr-only">Search companies</span>
          <SearchGlyph className="absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
          <input
            type="search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search companies…"
            className="h-9 w-full rounded-[9px] border-[1.5px] border-line bg-white pl-9 pr-3 text-[13.5px] text-ink outline-0 focus:border-blue"
          />
        </label>
      </div>

      {!companies ? (
        <p className="mt-6 text-[13.5px] text-muted">Loading companies…</p>
      ) : visible.length === 0 ? (
        <div className="mt-6 rounded-2xl border-[1.5px] border-dashed border-line bg-white px-6 py-10 text-center text-[13.5px] text-muted">
          {q.trim()
            ? 'No companies match your search.'
            : filter === 'archived'
              ? 'No archived companies.'
              : 'No companies in this view.'}
        </div>
      ) : (
        <ul className="m-0 mt-5 grid list-none gap-4 p-0 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
          {visible.map(c => (
            <li key={c.id}>
              <CompanyCard company={c} people={people} />
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CompanyFormModal mode="create" onClose={() => setCreating(false)} />
      )}
    </main>
  )
}

function CompanyCard({ company: c, people }: { company: Company; people: Person[] }) {
  const state = companyState(c)
  const stats = companyStats(c)
  const style = STATE_STYLE[state]
  const responsible = Object.keys(c.ourRoles).map(Number)
  const top = c.projects.slice(0, 3)
  const [bg] = pal(c.p)
  return (
    <article
      className={`flex h-full flex-col rounded-2xl border-[1.5px] border-line bg-white p-4 transition-colors hover:border-blue ${c.archived ? 'opacity-75' : ''}`}
    >
      <Link to={`/companies/${c.id}`} className="group flex items-start gap-3 text-ink no-underline hover:text-ink">
        <LogoTile name={c.name} p={c.p} logo={c.logo} size={44} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-extrabold group-hover:text-blue-ink">{c.name}</span>
          <span className="mt-0.5 block truncate text-[12.5px] text-muted">{[c.industry, c.country].filter(Boolean).join(' · ') || 'No industry set'}</span>
        </span>
        <TextPill ink={style.ink} soft={style.soft}>
          {state}
        </TextPill>
      </Link>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Active" value={stats.active} />
        <Stat label="Projects" value={stats.projects} />
        <Stat label="Overdue" value={stats.overdue} tone={stats.overdue ? 'text-red' : undefined} />
      </dl>

      {top.length > 0 && (
        <ul className="m-0 mt-4 flex list-none flex-col gap-2 p-0">
          {top.map(p => (
            <li key={p.id} className="flex items-center gap-2.5 text-[12.5px]">
              <span className="min-w-0 flex-1 truncate font-semibold">{p.name}</span>
              <span className="h-1.5 w-20 flex-none overflow-hidden rounded-full bg-line-3" aria-hidden="true">
                <span className="block h-full rounded-full" style={{ width: `${p.pct}%`, background: bg }} />
              </span>
              <span className="w-9 flex-none text-right tnum text-muted">{p.pct}%</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-1.5 pt-4">
        {responsible.length === 0 ? (
          <span className="text-[12px] text-muted">No one from Viljetech yet</span>
        ) : (
          responsible.slice(0, 5).map(id => {
            const p = findPerson(people, id)
            return p ? <PersonDot key={id} name={p.name} colour={p.colour} /> : null
          })
        )}
        {stats.avgPct !== null && <span className="ml-auto text-[12px] text-muted">{`Avg progress ${stats.avgPct}%`}</span>}
      </div>
    </article>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-[10px] bg-canvas px-2 py-1.5">
      <dt className="text-[10.5px] font-bold uppercase tracking-[0.04em] text-muted">{label}</dt>
      <dd className={`m-0 text-[17px] font-extrabold tnum ${tone ?? 'text-ink'}`}>{value}</dd>
    </div>
  )
}
