import { useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { usePeople } from '../../api/people/directory'
import { useAccess, useCompanies, useInternalProjects } from '../../api/queries'
import { ROLE_LABEL } from '../../api/session/access'
import type { Person, Role, Session } from '../../api/types'
import { accessSummary, isClientPerson, statusOf } from '../../api/users/derive'
import { ROLE_ORDER } from '../../api/users/access'
import { UserForm } from './UserForm'
import { PersonAvatar, RoleChip, StatusChip, btnPrimary, btnSmall, card, field, fieldInline } from './ui'

const COLS = 'minmax(210px,2fr) 128px 150px 150px 110px 100px 84px'

interface Props {
  /** 'all': every person in the directory (Viljetech). 'colleagues': the client admin's own company. */
  scope: 'all' | 'colleagues'
  /** Whether this viewer may add and edit people. */
  canEdit: boolean
  /** Where a name links to: that page's profile route. Left out where profiles are not offered. */
  profileBase?: 'users' | 'employee-timesheets'
  session: Session
}

/** The user table with search, role and company filters, and the pending invites group. */
export function UsersTab({ scope, canEdit, profileBase, session }: Props) {
  const people = usePeople().data
  const companies = useCompanies().data ?? []
  const internal = useInternalProjects().data ?? []
  const access = useAccess().data
  const [q, setQ] = useState('')
  const [role, setRole] = useState<'all' | Role>('all')
  const [org, setOrg] = useState('all')
  const [editing, setEditing] = useState<Person | 'new' | null>(null)

  if (!people) return <p className="text-[14px] text-slate">Loading users…</p>

  const colleagues = scope === 'colleagues'
  const scoped = people.filter(p => !colleagues || p.org === session.orgId)
  const needle = q.trim().toLowerCase()
  const filtered = scoped.filter(
    p =>
      (!needle || p.name.toLowerCase().includes(needle) || p.email.toLowerCase().includes(needle)) &&
      (role === 'all' || p.role === role) &&
      (org === 'all' || p.org === org),
  )
  const active = filtered.filter(p => !p.invited)
  const invited = filtered.filter(p => p.invited)
  const activeCount = scoped.filter(p => statusOf(p) === 'Active').length
  const invitedCount = scoped.filter(p => p.invited).length

  const canEditPerson = (p: Person) => canEdit && (session.role === 'super' || p.role !== 'super')
  const profileHref = (p: Person) => (profileBase && !colleagues && p.org === 'vt' ? `/${profileBase}/${p.id}` : null)

  const renderRow = (p: Person) => {
    const href = profileHref(p)
    return (
      <div key={p.id} role="row" className="grid items-center gap-3 border-t border-line-3 px-4 py-3 text-[13.5px]" style={{ gridTemplateColumns: COLS }}>
        <div role="cell" className="flex min-w-0 items-center gap-3">
          <PersonAvatar person={p} showPhoto={p.org === 'vt' && !colleagues} />
          <div className="min-w-0">
            {href ? (
              <Link to={href} className="block truncate font-bold text-ink no-underline hover:text-blue-ink">
                {p.name}
              </Link>
            ) : (
              <div className="truncate font-bold text-ink">{p.name}</div>
            )}
            <div className="truncate text-[12px] text-slate">{p.email}</div>
          </div>
        </div>
        <div role="cell" className="text-ink-2">{isClientPerson(p) ? '–' : p.devType || '–'}</div>
        <div role="cell"><RoleChip role={p.role} /></div>
        <div role="cell" className="text-ink-2">{accessSummary(p)}</div>
        <div role="cell"><StatusChip person={p} /></div>
        <div role="cell" className="text-ink-2">{p.last}</div>
        <div role="cell" className="flex justify-end">
          {canEditPerson(p) && (
            <button type="button" className={btnSmall} aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)}>
              Edit
            </button>
          )}
        </div>
      </div>
    )
  }

  const Head = ({ children }: { children: ReactNode }) => (
    <div className="px-4 pb-1 pt-3.5 text-[12px] font-bold uppercase tracking-[0.06em] text-slate">{children}</div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Active users" value={activeCount} />
        <Stat label="Pending invites" value={invitedCount} />
        {!colleagues && <Stat label="Roles" value={ROLE_ORDER.length} />}
      </div>

      <div className="flex flex-wrap items-center gap-2.5">
        <input
          type="search"
          aria-label="Search users"
          placeholder="Search by name or email"
          value={q}
          onChange={e => setQ(e.target.value)}
          className={`${field} max-w-[320px] flex-1`}
        />
        {!colleagues && (
          <select aria-label="Filter by role" value={role} onChange={e => setRole(e.target.value as 'all' | Role)} className={`${fieldInline} min-w-[160px]`}>
            <option value="all">All roles</option>
            {ROLE_ORDER.map(r => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        )}
        {!colleagues && (
          <select aria-label="Filter by company" value={org} onChange={e => setOrg(e.target.value)} className={`${fieldInline} min-w-[180px]`}>
            <option value="all">All companies</option>
            <option value="vt">Viljetech</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {canEdit && (
          <button type="button" className={`${btnPrimary} ml-auto`} onClick={() => setEditing('new')}>
            Add user
          </button>
        )}
      </div>

      <div className={`${card} overflow-x-auto`}>
        <div className="min-w-[900px]" role="table" aria-label="Users">
          <div role="row" className="grid gap-3 bg-canvas px-4 py-2.5 text-[11.5px] font-bold uppercase tracking-[0.06em] text-slate" style={{ gridTemplateColumns: COLS }}>
            <div role="columnheader">User</div>
            <div role="columnheader">Developer type</div>
            <div role="columnheader">Role</div>
            <div role="columnheader">Access</div>
            <div role="columnheader">Status</div>
            <div role="columnheader">Last active</div>
            <div role="columnheader" />
          </div>
          {!filtered.length ? (
            <p className="px-4 py-10 text-center text-[14px] text-slate">No users match these filters.</p>
          ) : (
            <>
              {active.length > 0 && (
                <>
                  <Head>Active users · {active.length}</Head>
                  {active.map(renderRow)}
                </>
              )}
              {invited.length > 0 && (
                <>
                  <Head>Pending invites · {invited.length}</Head>
                  {invited.map(renderRow)}
                </>
              )}
            </>
          )}
        </div>
      </div>
      {invitedCount > 0 && (
        <p className="text-[12.5px] text-slate">Invites are only recorded here. No email is sent, so an invited person cannot sign in until an admin activates the account.</p>
      )}

      {editing !== null && (
        <UserForm
          key={editing === 'new' ? 'new' : editing.id}
          person={editing === 'new' ? undefined : editing}
          scope={scope}
          session={session}
          people={people}
          companies={companies}
          internal={internal}
          devTypes={access?.devTypes ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className={`${card} px-4 py-3`}>
      <div className="text-[12px] font-semibold text-slate">{label}</div>
      <div className="mt-0.5 text-[22px] font-extrabold text-ink">{value}</div>
    </div>
  )
}
