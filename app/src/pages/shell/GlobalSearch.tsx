import { useMemo, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useCompanies, useTasks } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { canAccess, isClientRole } from '../../api/session/access'
import { PAGE_PATH } from '../../api/session/pages'
import { useSession } from '../../api/session/store'
import { initials } from '../../lib/media'
import { NAV } from './nav'

/** One result row. `tag` is the small badge on the left. */
interface Hit {
  key: string
  tag: string
  tone: readonly [bg: string, ink: string]
  title: string
  meta: string
  to: string
}

interface Group {
  label: string
  hits: Hit[]
}

const LIMIT = 6
const TONE = {
  page: ['#EEF3FB', '#22354C'],
  ticket: ['#E7EEFB', '#1F3FAF'],
  project: ['#DFF1EA', '#195040'],
  company: ['#FBF1D6', '#7A5C0E'],
  person: ['#1B2D45', '#FFFFFF'],
} as const

/**
 * Search in the top bar. Results are grouped as Pages, Tickets, Projects,
 * Companies and People; a group only shows for roles that can open its page.
 */
export function GlobalSearch() {
  const session = useSession()
  const navigate = useNavigate()
  const tasks = useTasks().data ?? []
  const companies = useCompanies().data ?? []
  const people = usePeople().data ?? []
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)

  const role = session?.role
  const groups = useMemo<Group[]>(() => {
    const term = q.trim().toLowerCase()
    if (!term || !role) return []
    const ok = (p: Parameters<typeof canAccess>[1]) => canAccess(role, p)
    const has = (...parts: string[]) => parts.join(' ').toLowerCase().includes(term)

    const pages: Hit[] = NAV.filter(it => ok(it.page) && has(it.label)).map(it => ({
      key: 'page-' + it.page,
      tag: 'Page',
      tone: TONE.page,
      title: it.label,
      meta: 'Open page',
      to: PAGE_PATH[it.page],
    }))
    const ticketHits: Hit[] = ok('Tickets')
      ? tasks
          .filter(t => !t.parent && has('PMT-' + t.id, t.title))
          .map(t => ({ key: 'ticket-' + t.id, tag: 'PMT-' + t.id, tone: TONE.ticket, title: t.title, meta: t.type, to: `/tickets/board?ticket=${t.id}` }))
      : []
    const projects: Hit[] = ok('Projects')
      ? companies.flatMap(c =>
          c.archived ? [] : c.projects.filter(p => has(p.name)).map(p => ({ key: 'project-' + p.id, tag: 'Proj', tone: TONE.project, title: p.name, meta: c.name, to: PAGE_PATH.Projects })),
        )
      : []
    const orgs: Hit[] = ok('Companies')
      ? companies
          .filter(c => has(c.name, c.industry, c.country))
          .map(c => ({ key: 'company-' + c.id, tag: 'Co', tone: TONE.company, title: c.name, meta: `${c.projects.length} projects`, to: PAGE_PATH.Companies }))
      : []
    // Client admins see their own colleagues only.
    const ownOrgOnly = isClientRole(role)
    const humans: Hit[] = ok('Users')
      ? people
          .filter(p => has(p.name, p.email) && (!ownOrgOnly || p.org === session?.orgId))
          .map(p => ({ key: 'person-' + p.id, tag: initials(p.name), tone: TONE.person, title: p.name, meta: p.email, to: PAGE_PATH.Users }))
      : []

    return [
      { label: 'Pages', hits: pages },
      { label: 'Tickets', hits: ticketHits },
      { label: 'Projects', hits: projects },
      { label: 'Companies', hits: orgs },
      { label: 'People', hits: humans },
    ]
      .filter(g => g.hits.length)
      .map(g => ({ ...g, hits: g.hits.slice(0, LIMIT) }))
  }, [q, role, session?.orgId, tasks, companies, people])

  if (!session) return null

  const close = () => {
    setOpen(false)
    setQ('')
  }
  const go = (to: string) => {
    close()
    navigate(to)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      close()
      e.currentTarget.blur()
    }
    if (e.key === 'Enter') {
      const first = groups[0]?.hits[0]
      if (first) go(first.to)
    }
  }
  const term = q.trim()

  return (
    <div className="relative z-50 w-full max-w-[360px]">
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        className="pointer-events-none absolute left-[11px] top-1/2 -translate-y-1/2 text-muted"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <path d="M20 20l-3.5-3.5" />
      </svg>
      <input
        id="vt-search"
        type="search"
        aria-label="Search pages, tickets, projects, companies and people"
        value={q}
        placeholder="Search…"
        onChange={e => {
          setQ(e.target.value)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
        className="h-9 w-full rounded-[9px] border-[1.5px] border-line-3 bg-white pl-[34px] pr-3 text-[13px] text-ink outline-0 focus:border-blue"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden="true" />
          <div
            role="listbox"
            aria-label="Search results"
            className="absolute left-0 top-[calc(100%+8px)] z-50 max-h-[min(70vh,520px)] w-[420px] max-w-[calc(100vw-20px)] overflow-y-auto rounded-[14px] border-[1.5px] border-line bg-white p-1.5 shadow-[0_22px_60px_rgba(27,45,69,0.22)]"
          >
            {!term && <p className="p-3.5 text-[13px] text-muted">Search pages, tickets, projects, companies and people.</p>}
            {term && groups.length === 0 && <p className="p-4 text-center text-[13px] text-muted">No results for “{term}”</p>}
            {groups.map(g => (
              <div key={g.label}>
                <div className="px-2.5 pb-1 pt-2 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">{g.label}</div>
                {g.hits.map(h => (
                  <button
                    key={h.key}
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => go(h.to)}
                    className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2 text-left hover:bg-canvas"
                  >
                    <span
                      className="grid h-6 min-w-7 flex-none place-items-center whitespace-nowrap rounded-md px-1.5 text-[11px] font-bold"
                      style={{ background: h.tone[0], color: h.tone[1] }}
                    >
                      {h.tag}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13.5px] font-semibold text-ink">{h.title}</span>
                      <span className="block truncate text-[12px] text-muted">{h.meta}</span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
