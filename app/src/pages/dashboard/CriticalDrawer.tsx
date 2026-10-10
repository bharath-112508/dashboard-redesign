import { Link } from 'react-router'
import type { DrawerRow } from '../../api/dashboard/model'
import { TONE } from '../../api/dashboard/model'
import { avatarOf } from '../../api/people/avatar'
import type { Person } from '../../api/types'
import { plural } from '../../lib/dates'
import { Avatar, CloseButton } from '../../components/ui'
import { useEscape } from '../../features/useEscape'
import { PRIO } from '../../lib/theme'

interface Props {
  title: string
  sub: string
  rows: DrawerRow[]
  people: Person[]
  onClose: () => void
}

/** Right-side list of tickets for the Critical and Overdue KPIs. Each row opens its ticket. */
export function CriticalDrawer({ title, sub, rows, people, onClose }: Props) {
  useEscape(onClose)
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 z-40 animate-fade-in bg-[rgba(27,45,69,0.38)]" aria-hidden="true" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        className="fixed inset-y-0 right-0 z-50 flex w-[min(560px,100vw)] animate-pop-in flex-col bg-white shadow-[0_0_0_1.5px_#D6DEE8]"
      >
        <div className="flex items-start gap-3 border-b-[1.5px] border-line-3 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 id="drawer-title" className="text-[17px] font-bold text-ink">
              {title}
            </h2>
            <div className="text-[12.5px] text-muted">
              {sub} · {plural(rows.length, 'ticket', 'tickets')}
            </div>
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {rows.length === 0 && <li className="px-5 py-6 text-[13px] text-muted">Nothing here right now</li>}
          {rows.map(r => {
            const [pText, pBg] = PRIO[r.prio]
            const assignee = r.assignees[0]
            const person = people.find(p => p.name === assignee)
            const av = assignee ? avatarOf(person ?? { name: assignee, colour: '#56657A', photo: '' }, { showPhoto: false }) : null
            return (
              <li key={r.id} className="border-b-[1.5px] border-sky">
                <Link to={r.href} onClick={onClose} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-5 py-3 text-ink no-underline hover:bg-canvas">
                  <span className="flex flex-none items-center gap-1.5">
                    <span className="rounded-[5px] bg-sky-2 px-1.5 py-0.5 text-[11px] font-semibold text-blue-ink">{r.key}</span>
                    <span className="rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: pBg, color: pText }}>
                      {r.prio}
                    </span>
                  </span>
                  <span className="min-w-0 truncate text-[13.5px] font-semibold">{r.title}</span>
                  <span className="text-[16px] font-bold text-faint" aria-hidden="true">›</span>
                  <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted">
                    <span className="truncate">
                      {r.project} · {r.hours}
                    </span>
                    {av && (
                      <span className="flex min-w-0 items-center gap-1.5">
                        <Avatar i={av.initials} bg={av.colour} size={18} radius={5} font={8} />
                        <span className="truncate">{assignee}</span>
                      </span>
                    )}
                    <span className="rounded-md px-1.5 py-0.5 text-[11px] font-bold" style={{ background: TONE.grey.bg, color: TONE.grey.ink }}>
                      {r.status}
                    </span>
                    {r.due && (
                      <span className="font-bold" style={{ color: r.overdue ? '#C0392B' : '#1B2D45' }}>
                        {r.due}
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      </aside>
    </>
  )
}
