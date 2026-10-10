import type { ReactNode } from 'react'
import { useEscape } from '../../features/useEscape'
import { avatarOf } from '../../api/people/avatar'
import { ROLE_LABEL } from '../../api/session/access'
import type { Person, Role } from '../../api/types'
import { statusOf, type PersonStatus } from '../../api/users/derive'

export const field = 'h-[38px] w-full rounded-[9px] border-[1.5px] border-line bg-white px-3 text-[13.5px] text-ink outline-0 focus:border-blue disabled:bg-canvas disabled:text-muted'
/** A filter-sized field: the same look, not full width. */
export const fieldInline = field.replace(' w-full', ' w-auto')
export const label = 'mb-1.5 block text-[12px] font-bold text-ink-2'
export const btnPrimary = 'h-10 rounded-[10px] bg-blue px-5 text-[13.5px] font-bold text-white hover:bg-blue-600 disabled:opacity-60'
export const btnGhost = 'h-10 rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink hover:border-blue'
export const btnDanger = 'h-10 rounded-[10px] border-[1.5px] border-rust-line bg-rust-soft px-4 text-[13.5px] font-semibold text-rust hover:bg-peach'
export const btnSmall = 'h-8 rounded-lg border-[1.5px] border-line bg-white px-3 text-[12.5px] font-semibold text-ink hover:border-blue disabled:opacity-50'
export const card = 'rounded-2xl border-[1.5px] border-line-2 bg-white'

/** "2h 30m"; "0m" for nothing. */
export const hm = (hours: number) => {
  const m = Math.round(hours * 60)
  if (!m) return '0m'
  const H = Math.floor(m / 60)
  const M = m % 60
  return [H ? `${H}h` : '', M ? `${M}m` : ''].filter(Boolean).join(' ')
}

/** Avatar with the person's photo when they have one and the viewer may see it, otherwise initials. */
export function PersonAvatar({
  person,
  size = 34,
  showPhoto = true,
}: {
  person: Pick<Person, 'name' | 'colour' | 'photo'>
  size?: number
  showPhoto?: boolean
}) {
  const a = avatarOf(person, { showPhoto })
  if (a.photo) {
    return <img src={a.photo} alt="" className="flex-none rounded-[10px] object-cover" style={{ width: size, height: size }} />
  }
  return (
    <span
      className="grid flex-none place-items-center rounded-[10px] font-bold text-white"
      style={{ width: size, height: size, background: a.colour, fontSize: Math.round(size * 0.36) }}
      aria-hidden="true"
    >
      {a.initials}
    </span>
  )
}

const STATUS_CLASS: Record<PersonStatus, string> = {
  Active: 'bg-green-soft text-green-ink',
  Deactivated: 'bg-line-3 text-muted',
  Invited: 'bg-amber-soft text-amber-ink',
}

export function StatusChip({ person }: { person: Pick<Person, 'active' | 'invited'> }) {
  const s = statusOf(person)
  return <span className={`inline-flex rounded-full px-2.5 py-[3px] text-[11.5px] font-bold ${STATUS_CLASS[s]}`}>{s}</span>
}

export function RoleChip({ role }: { role: Role }) {
  return <span className="inline-flex whitespace-nowrap rounded-full bg-sky px-2.5 py-[3px] text-[11.5px] font-bold text-blue-ink">{ROLE_LABEL[role]}</span>
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  name,
}: {
  items: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
  name: string
}) {
  return (
    <div role="tablist" aria-label={name} className="flex flex-wrap gap-1.5 border-b border-line-2">
      {items.map(it => {
        const on = it.id === value
        return (
          <button
            key={it.id}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(it.id)}
            className={`-mb-px border-b-[2.5px] px-3.5 pb-2.5 pt-1.5 text-[14px] ${
              on ? 'border-blue font-bold text-ink' : 'border-transparent font-semibold text-slate hover:text-ink'
            }`}
          >
            {it.label}
          </button>
        )
      })}
    </div>
  )
}

/** A centred dialog over a dimmed backdrop. Escape and the backdrop close it. */
export function Dialog({ titleId, onClose, children, width = 620 }: { titleId: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEscape(onClose)
  return (
    <>
      <div className="fixed inset-0 z-[70] bg-[rgba(27,45,69,0.42)]" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="fixed left-1/2 top-1/2 z-[71] max-h-[calc(100vh-40px)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[22px] border-[1.5px] border-line bg-white px-[26px] py-6 shadow-[0_30px_90px_rgba(27,45,69,0.3)]"
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
      >
        {children}
      </div>
    </>
  )
}

/** Page heading used by both admin pages. */
export function PageHead({ title, subtitle, actions }: { title: string; subtitle: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-[12.5px] font-semibold text-slate">{subtitle}</p>
        <h1 className="mt-0.5 text-[26px] font-extrabold tracking-[-0.01em] text-ink">{title}</h1>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}
