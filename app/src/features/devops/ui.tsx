import type { CSSProperties, ReactNode } from 'react'
import { prioIcon } from './model'

/** Priority arrow icon (16×16 viewBox). */
export function PrioIcon({ p, size = 16, sw = 2, className, style }: { p: string; size?: number; sw?: number; className?: string; style?: CSSProperties }) {
  const [c, d] = prioIcon(p)
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className={className} style={{ flex: 'none', color: c, ...style }}>
      <path d={d} fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** Small downward caret used in the pill dropdowns. */
export const Caret = ({ size = 8, sw = 1.5 }: { size?: number; sw?: number }) => (
  <svg width={size} height={size} viewBox="0 0 8 8">
    <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/** Rounded status pill with a dot, as in the list. */
export function DotPill({ label, tone }: { label: string; tone: [string, string, string] }) {
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 truncate whitespace-nowrap rounded-full py-[3px] pl-[7px] pr-[9px] text-[12.5px] font-medium leading-[1.4]"
      style={{ background: tone[1], color: tone[0] }}
    >
      <span className="size-1.5 flex-none rounded-full" style={{ background: tone[2] }} />
      {label}
    </span>
  )
}

/** Square avatar with an initial, used for owners on the board. */
export function Initial({ i, bg, size = 22, radius = 5, font = 10, title, className = '' }: { i: string; bg: string; size?: number; radius?: number; font?: number; title?: string; className?: string }) {
  return (
    <span
      title={title}
      className={`flex flex-none items-center justify-center font-semibold text-white ${className}`}
      style={{ width: size, height: size, borderRadius: radius, background: bg, fontSize: font }}
    >
      {i}
    </span>
  )
}

/** iOS-style on/off switch. */
export function Switch({ on, onClick, big = false, label }: { on: boolean; onClick: () => void; big?: boolean; label?: string }) {
  const w = big ? 42 : 40
  const h = big ? 26 : 24
  const k = big ? 22 : 20
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className="relative flex-none cursor-pointer rounded-full border-0 p-0 transition-[background] duration-200"
      style={{ width: w, height: h, background: on ? '#3F9079' : '#E4EAF0' }}
    >
      <span
        className="absolute top-0.5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200"
        style={{ width: k, height: k, left: on ? 18 : 2 }}
      />
    </button>
  )
}

export interface MenuOption {
  label: string
  on: boolean
  pick: () => void
  /** Coloured dot [dot, halo]. */
  dot?: [string, string]
  /** Square avatar. */
  avatar?: { i: string; bg: string }
}

/** The frosted pop-up menu used by every dropdown on the board. */
export function GlassMenu({
  title,
  options,
  onClose,
  addLabel,
  onAdd,
  width = 240,
  align = 'right',
  up = false,
  z = 40,
  gap = 6,
}: {
  title: string
  options: MenuOption[]
  onClose: () => void
  addLabel?: string
  onAdd?: () => void
  width?: number
  align?: 'left' | 'right'
  up?: boolean
  z?: number
  gap?: number
}) {
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 cursor-default" style={{ zIndex: z }} />
      <div
        className="absolute max-h-[340px] overflow-y-auto rounded-[14px] bg-white/[0.94] p-1.5 text-left shadow-[0_14px_40px_rgba(0,0,0,0.16),0_2px_6px_rgba(0,0,0,0.06),0_0_0_0.5px_rgba(0,0,0,0.1)] backdrop-blur-[24px] backdrop-saturate-[180%]"
        style={{
          zIndex: z + 1,
          width,
          [align]: 0,
          ...(up ? { bottom: `calc(100% + ${gap}px)` } : { top: `calc(100% + ${gap}px)` }),
        }}
      >
        <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</div>
        {options.map(o => (
          <button
            key={o.label}
            type="button"
            onClick={o.pick}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left text-[13px] text-ink hover:!bg-[rgba(0,113,227,0.08)]"
            style={{ background: o.on ? 'rgba(0,113,227,0.06)' : 'transparent', fontWeight: o.on ? 600 : 400 }}
          >
            {o.avatar && <Initial i={o.avatar.i} bg={o.avatar.bg} size={20} font={9} />}
            {o.dot && (
              <span className="size-2 flex-none rounded-full" style={{ background: o.dot[0], boxShadow: `0 0 0 3px ${o.dot[1]}` }} />
            )}
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            <span className="flex-none text-[13px] font-bold text-blue" style={{ opacity: o.on ? 1 : 0 }}>
              ✓
            </span>
          </button>
        ))}
        {onAdd && (
          <>
            <div className="mx-2 my-1.5 h-[0.5px] bg-black/10" />
            <button
              type="button"
              onClick={onAdd}
              className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left text-[13px] font-medium text-blue-ink hover:bg-[rgba(0,113,227,0.08)]"
            >
              <span className="w-5 text-center text-[15px] leading-none">+</span>
              <span>{addLabel}</span>
            </button>
          </>
        )}
      </div>
    </>
  )
}

/** Small uppercase section label. */
export function Eyebrow({ children, className = '', style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  return (
    <div className={`text-[11px] font-semibold uppercase tracking-[0.06em] text-muted ${className}`} style={style}>
      {children}
    </div>
  )
}

/** Plain text button (Cancel / Save links). */
export function LinkBtn({ children, onClick, strong = false, className = '', title }: { children: ReactNode; onClick: () => void; strong?: boolean; className?: string; title?: string }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`cursor-pointer border-0 bg-transparent p-0 text-[12px] ${strong ? 'font-semibold text-blue-ink' : 'font-medium text-muted'} ${className}`}
    >
      {children}
    </button>
  )
}

/** Small filled button: blue (primary), white or soft blue. */
export function Btn({
  children,
  onClick,
  kind = 'primary',
  className = '',
  style,
  disabled,
}: {
  children: ReactNode
  onClick: () => void
  kind?: 'primary' | 'white' | 'soft'
  className?: string
  style?: CSSProperties
  /** Shown dimmed; clicking does nothing (the prototype keeps such buttons visible). */
  disabled?: boolean
}) {
  const k = kind === 'primary' ? 'bg-blue text-white' : kind === 'white' ? 'bg-white text-ink' : 'bg-sky-2 text-ink'
  return (
    <button
      type="button"
      onClick={() => !disabled && onClick()}
      aria-disabled={disabled || undefined}
      className={`cursor-pointer rounded-lg border-0 font-medium ${k} ${className}`}
      style={{ opacity: disabled ? 0.4 : 1, ...style }}
    >
      {children}
    </button>
  )
}

/** The prototype's light input / textarea look. */
export const inputCls = 'w-full border-0 text-ink outline-0'
