import { Link } from 'react-router'
import { canAccess, ROLE_LABEL, isClientRole } from '../../api/session/access'
import { PAGE_PATH, type PageName } from '../../api/session/pages'
import { avatarOf } from '../../api/people/avatar'
import { initials } from '../../lib/media'
import type { Person, Session } from '../../api/types'
import { NAV } from './nav'

export interface Brand {
  name: string
  /** Set for client users: the company logo (a data URL). */
  logo?: string
}

interface Props {
  session: Session
  person: Person | undefined
  page: PageName
  collapsed: boolean
  brand: Brand | null
  onToggle: () => void
  onProfile: () => void
  onSignOut: () => void
}

const WIDTH = { open: 232, closed: 60 }
export const sidebarWidth = (collapsed: boolean) => (collapsed ? WIDTH.closed : WIDTH.open)

/** The left navigation: brand, the role's nav items, profile, sign out and collapse. */
export function Sidebar({ session, person, page, collapsed, brand, onToggle, onProfile, onSignOut }: Props) {
  const client = isClientRole(session.role)
  const open = !collapsed
  const avatar = person ? avatarOf(person, { showPhoto: !client }) : { initials: initials(session.name), photo: null, colour: '#1B2D45' }
  const items = NAV.filter(it => canAccess(session.role, it.page))

  return (
    <div
      data-sidebar
      className="fixed inset-y-0 left-0 z-40 flex flex-col overflow-hidden bg-white shadow-[inset_-1.5px_0_0_#E4EAF0] transition-[width] duration-200"
      style={{ width: sidebarWidth(collapsed) }}
    >
      <div className="flex h-14 flex-none items-center gap-2.5 px-[13px]">
        {brand?.logo ? (
          <span
            className="size-[30px] flex-none rounded-[9px] bg-white bg-cover bg-center shadow-[inset_0_0_0_1.5px_#E4EAF0]"
            style={{ backgroundImage: `url("${brand.logo}")` }}
            aria-hidden="true"
          />
        ) : (
          <span className="grid size-[30px] flex-none place-items-center rounded-[9px] bg-blue-600 text-[13px] font-bold text-white" aria-hidden="true">
            V
          </span>
        )}
        {open && (
          <span className="flex min-w-0 flex-col leading-[1.15]">
            <span className="truncate text-[15px] font-extrabold tracking-[-0.01em]">{brand?.name ?? 'Viljetech'}</span>
            {client && <span className="mt-0.5 whitespace-nowrap text-[10.5px] font-semibold text-muted">Powered by Viljetech</span>}
          </span>
        )}
      </div>

      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-1.5">
        {items.map(it => {
          const on = it.page === page || (page === 'Tickets' && it.page === 'Projects')
          const label = client && it.clientLabel ? it.clientLabel : it.label
          return (
            <Link
              key={it.page}
              to={PAGE_PATH[it.page]}
              title={label}
              aria-current={on ? 'page' : undefined}
              className={`flex h-[38px] items-center gap-[11px] whitespace-nowrap rounded-[9px] px-2.5 text-[13.5px] no-underline hover:no-underline ${
                on ? 'bg-ink font-bold text-white shadow-[0_4px_12px_-4px_rgba(27,45,69,0.35)]' : 'font-semibold text-ink-2 hover:bg-sky hover:text-ink'
              }`}
            >
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
                <path d={it.icon} />
              </svg>
              {open && <span className="min-w-0 truncate">{label}</span>}
            </Link>
          )
        })}
      </nav>

      <div className="flex flex-none flex-col gap-1.5 border-t-[1.5px] border-line-3 p-2.5">
        <button
          type="button"
          onClick={onProfile}
          title="Profile settings"
          className="flex min-w-0 items-center gap-2.5 rounded-[9px] px-1 py-1.5 text-left hover:bg-canvas"
        >
          <Avatar initials={avatar.initials} photo={avatar.photo} colour={avatar.colour} />
          {open && (
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-bold">{session.name}</span>
              <span className="block truncate text-[11.5px] text-muted">{ROLE_LABEL[session.role]}{session.org !== 'Viljetech' ? ` · ${session.org}` : ''}</span>
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={onSignOut}
          title="Sign out"
          className="flex h-9 items-center gap-[11px] whitespace-nowrap rounded-[9px] px-2.5 text-[13px] font-semibold text-rust hover:bg-rust-soft"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-none" aria-hidden="true">
            <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />
          </svg>
          {open && <span>Sign out</span>}
        </button>
        <button
          type="button"
          onClick={onToggle}
          title={open ? 'Collapse menu' : 'Expand menu'}
          aria-label={open ? 'Collapse menu' : 'Expand menu'}
          className="flex h-9 items-center gap-[11px] whitespace-nowrap rounded-[9px] bg-canvas px-2.5 text-[13px] font-semibold text-ink-2 hover:bg-sky-2"
        >
          <svg
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-none transition-transform duration-200"
            style={{ transform: open ? 'none' : 'rotate(180deg)' }}
            aria-hidden="true"
          >
            <path d="M15 6l-6 6 6 6" />
          </svg>
          {open && <span>Collapse</span>}
        </button>
      </div>
    </div>
  )
}

/** A round-cornered initials tile, or the face photo when there is one. */
export function Avatar({ initials, photo, colour, size = 32 }: { initials: string; photo: string | null; colour: string; size?: number }) {
  return (
    <span
      className="grid flex-none place-items-center rounded-lg bg-cover bg-center text-[12px] font-bold text-white"
      style={{
        width: size,
        height: size,
        background: photo ? `url("${photo}") center / cover` : colour,
      }}
      aria-hidden="true"
    >
      {photo ? null : initials}
    </span>
  )
}
