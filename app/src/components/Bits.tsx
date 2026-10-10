import { initials } from '../lib/media'
import { pal } from '../lib/theme'
import { STATE_LABEL, STATE_TONE } from '../domain/projects'
import type { ProjectState } from '../api/types'

/** Project state pill: label and colours from the state. */
export function StatePill({ state }: { state: ProjectState }) {
  const t = STATE_TONE[state]
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-[3px] text-[11.5px] font-semibold" style={{ background: t.soft, color: t.ink }}>
      <span className="size-1.5 rounded-full" style={{ background: t.dot }} />
      {STATE_LABEL[state]}
    </span>
  )
}

/** A text pill in the company state colour (Active, New, No active work, Archived). */
export function TextPill({ children, ink, soft }: { children: string; ink: string; soft: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-2 py-[3px] text-[11.5px] font-semibold" style={{ background: soft, color: ink }}>
      {children}
    </span>
  )
}

/** Circular progress ring with the percentage in the middle. */
export function ProgressRing({ pct, size = 40, color = '#4870E8' }: { pct: number; size?: number; color?: string }) {
  const r = (size - 6) / 2
  const c = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, pct))
  return (
    <span className="relative inline-grid flex-none place-items-center" style={{ width: size, height: size }} role="img" aria-label={`${v}% done`}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E4EAF0" strokeWidth={4} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
      </svg>
      <span className="absolute font-bold tnum text-ink" style={{ fontSize: Math.round(size * 0.28) }}>
        {v}%
      </span>
    </span>
  )
}

/** The search glyph: a lens and a handle. */
export function SearchGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className={`flex-none ${className}`} aria-hidden="true">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M20 20l-4.2-4.2" />
    </svg>
  )
}

/** A square logo: the company's uploaded logo, or initials on its colour when there is none. */
export function LogoTile({ name, p, logo, size = 44 }: { name: string; p: number; logo?: string; size?: number }) {
  if (logo) {
    return <img src={logo} alt="" className="flex-none bg-white object-contain" style={{ width: size, height: size, borderRadius: Math.round(size / 4) }} />
  }
  const [bg, soft, ink] = pal(p)
  return (
    <span
      aria-hidden="true"
      className="grid flex-none place-items-center font-bold"
      style={{ width: size, height: size, borderRadius: Math.round(size / 4), background: soft, color: ink, fontSize: Math.round(size * 0.36) }}
    >
      <span style={{ color: bg }}>{initials(name)}</span>
    </span>
  )
}

/** Initials avatar in a person's colour. */
export function PersonDot({ name, colour, size = 24 }: { name: string; colour: string; size?: number }) {
  return (
    <span
      title={name}
      className="grid flex-none place-items-center rounded-[7px] font-semibold text-white"
      style={{ width: size, height: size, background: colour, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name)}
    </span>
  )
}
