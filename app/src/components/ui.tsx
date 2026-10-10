import type { CSSProperties, ReactNode } from 'react'

/** A stroked 24×24 icon from a single path. */
export function Icon({
  d,
  size = 14,
  sw = 2.4,
  vb = '0 0 24 24',
  className,
  style,
  stroke = 'currentColor',
}: {
  d: string
  size?: number
  sw?: number
  vb?: string
  className?: string
  style?: CSSProperties
  stroke?: string
}) {
  return (
    <svg
      viewBox={vb}
      width={size}
      height={size}
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={{ flex: 'none', ...style }}
    >
      <path d={d} />
    </svg>
  )
}

export const PATHS = {
  back: 'M15 6l-6 6 6 6',
  next: 'M9 6l6 6-6 6',
  chevron: 'M6 9l6 6 6-6',
  close: 'M6 6l12 12M18 6L6 18',
  plus: 'M12 5v14M5 12h14',
  check: 'M5 12l4 4 10-10',
  search: 'M20 20l-3.5-3.5',
  bug: 'M8 6V4M16 6V4M6 10h12M6 14h12M8 6h8a2 2 0 0 1 2 2v8a6 6 0 0 1-12 0V8a2 2 0 0 1 2-2z',
  lock: 'M8 11V7a4 4 0 018 0v4',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  clip: 'M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9',
  calendar: 'M3 10h18M8 3v4M16 3v4',
  warn: 'M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0zM12 9v4M12 17h.01',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
  subtask: 'M6 4v10a3 3 0 0 0 3 3h9M14 13l4 4-4 4',
}

/** The close button used on every window: a light red square with an ×. */
export function CloseButton({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Close"
      className={`grid size-8 flex-none cursor-pointer place-items-center rounded-lg border border-rust-line bg-rust-soft p-0 text-rust hover:bg-peach ${className}`}
    >
      <Icon d={PATHS.close} size={14} sw={2.6} />
    </button>
  )
}

/** Square avatar with initials. Clients only ever see initials, never photos. */
export function Avatar({
  i,
  bg,
  size = 24,
  radius,
  font,
  color = '#fff',
  ring,
  title,
  className = '',
  style,
}: {
  i: string
  bg: string
  size?: number
  radius?: number
  font?: number
  color?: string
  ring?: string
  title?: string
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      title={title}
      className={`grid flex-none place-items-center font-semibold ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: radius ?? Math.round(size / 4),
        background: bg,
        color,
        fontSize: font ?? Math.round(size * 0.4),
        boxShadow: ring,
        ...style,
      }}
    >
      {i}
    </span>
  )
}

/** Unassigned placeholder: white square with a "+" and a grey ring. */
export const unassigned = { i: '+', bg: '#FFFFFF', color: '#3B4A5E', ring: 'inset 0 0 0 1.5px #A9B6C5' }

/** Full-screen click catcher behind an open menu. */
export function Scrim({ onClick, z = 40 }: { onClick: () => void; z?: number }) {
  return <div onClick={onClick} className="fixed inset-0 cursor-default" style={{ zIndex: z }} />
}

/** Dimmed backdrop behind a window. */
export function Backdrop({ onClick, z, dark = false }: { onClick: () => void; z: number; dark?: boolean }) {
  return (
    <div
      onClick={onClick}
      className="fixed inset-0 animate-fade-in"
      style={{ zIndex: z, background: dark ? 'rgba(27,45,69,0.45)' : 'rgba(27,45,69,0.38)' }}
    />
  )
}

/** The rounded checkbox used in pickers: blue when on. */
export function CheckSquare({ on, size = 18 }: { on: boolean; size?: number }) {
  return (
    <span
      className="grid flex-none place-items-center text-[11px] font-extrabold text-white"
      style={{
        width: size,
        height: size,
        borderRadius: 5,
        border: `2px solid ${on ? '#4870E8' : '#A9B6C5'}`,
        background: on ? '#4870E8' : '#fff',
      }}
    >
      {on ? '✓' : ''}
    </span>
  )
}

/** Small count pill used on tabs. */
export function CountPill({ n }: { n: ReactNode }) {
  return (
    <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-sky-2 px-[5px] text-[11px] font-semibold text-blue-ink">
      {n}
    </span>
  )
}

/** Uppercase field label used in stat boxes. */
export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <span className={`text-[11px] font-bold uppercase tracking-[0.05em] text-muted ${className}`}>{children}</span>
  )
}

/** Tab bar button with an underline when selected. */
export function TabButton({
  on,
  onClick,
  children,
  bold = true,
}: {
  on: boolean
  onClick: () => void
  children: ReactNode
  bold?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-[7px] border-0 bg-transparent px-0 pb-3 pt-0 text-[14px]"
      style={{
        fontWeight: on && bold ? 700 : 500,
        color: on ? '#1B2D45' : '#3B4A5E',
        boxShadow: `inset 0 -2px 0 ${on ? '#4870E8' : 'transparent'}`,
      }}
    >
      {children}
    </button>
  )
}

/** Native select styled like the design, with a chevron. */
export function Select({
  value,
  onChange,
  children,
  className = '',
  style,
  id,
  chevronRight = 11,
  chevronSize = 12,
}: {
  value: string
  onChange: (v: string) => void
  children: ReactNode
  className?: string
  style?: CSSProperties
  id?: string
  chevronRight?: number
  chevronSize?: number
}) {
  return (
    <span className="relative inline-flex">
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        className={`cursor-pointer appearance-none bg-white text-ink outline-0 ${className}`}
        style={style}
      >
        {children}
      </select>
      <Icon
        d={PATHS.chevron}
        size={chevronSize}
        sw={2.6}
        className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-ink-2"
        style={{ right: chevronRight }}
      />
    </span>
  )
}
