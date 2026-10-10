import { NavLink } from 'react-router'
import { Avatar } from './ui'
import { ME, person } from '../lib/theme'

const LINKS = [
  { to: '/devops', label: 'DevOps board' },
  { to: '/tickets', label: 'Tickets' },
  { to: '/clients', label: 'Clients' },
]

export function AppHeader() {
  const me = person(ME)
  return (
    <header className="sticky top-0 z-20 flex items-center gap-3.5 bg-[rgba(246,249,252,0.88)] px-7 py-[9px] shadow-[inset_0_-1px_0_rgba(27,45,69,0.10)] backdrop-blur-[6px]">
      <span className="grid size-[30px] flex-none place-items-center rounded-[9px] bg-blue-600 text-[13px] font-semibold text-white">
        V
      </span>
      <nav className="flex items-center gap-1">
        {LINKS.map(l => (
          <NavLink
            key={l.to}
            to={l.to}
            className={({ isActive }) =>
              `rounded-lg px-2.5 py-1.5 text-[13.5px] font-semibold no-underline ${
                isActive ? 'bg-sky-2 text-blue-ink' : 'text-ink-2 hover:bg-sky-2 hover:text-ink'
              }`
            }
          >
            {l.label}
          </NavLink>
        ))}
      </nav>
      <Avatar i={me.i} bg="#1B2D45" size={32} radius={8} font={12} title={ME} className="ml-auto" />
    </header>
  )
}
