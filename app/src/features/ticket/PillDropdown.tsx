import { Avatar, Scrim } from '../../components/ui'

export interface PillOption {
  key: string
  label: string
  dot: string
  selected: boolean
  pick: () => void
}

/** A coloured pill that opens a frosted menu, used for the ticket's detail fields. */
export function PillDropdown({
  label,
  value,
  color,
  bg,
  avatar,
  open,
  onToggle,
  onClose,
  options,
  up,
  disabled = false,
}: {
  label: string
  value: string
  color: string
  bg: string
  avatar?: { i: string; bg: string }
  open: boolean
  onToggle: () => void
  onClose: () => void
  options: PillOption[]
  /** Open the menu above the pill (for fields low in the panel). */
  up?: boolean
  /** Read-only: the pill shows its value and cannot be opened. */
  disabled?: boolean
}) {
  return (
    <div className="relative flex-none">
      <button
        type="button"
        onClick={disabled ? undefined : onToggle}
        disabled={disabled}
        className="flex max-w-[160px] cursor-pointer items-center gap-1.5 rounded-md border-0 py-[5px] pl-2.5 pr-1.5 text-[12px] font-semibold disabled:cursor-default"
        style={{
          background: bg,
          color,
          boxShadow: open ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1.5px rgba(27,45,69,0.14)',
        }}
        onMouseEnter={e => {
          if (!open) e.currentTarget.style.boxShadow = `0 0 0 1.5px ${color}`
        }}
        onMouseLeave={e => {
          if (!open) e.currentTarget.style.boxShadow = 'inset 0 0 0 1.5px rgba(27,45,69,0.14)'
        }}
      >
        {avatar && <Avatar i={avatar.i} bg={avatar.bg} size={18} radius={5} font={8.5} style={{ marginLeft: -5 }} />}
        <span className="min-w-0 truncate">{value}</span>
        <Caret />
      </button>
      {open && !disabled && (
        <>
          <Scrim onClick={onClose} z={50} />
          <div
            className="absolute right-0 z-[51] max-h-80 w-60 overflow-y-auto rounded-[14px] bg-white/[.96] p-1.5 text-left shadow-[0_14px_40px_rgba(27,45,69,0.16),0_0_0_0.5px_rgba(27,45,69,0.12)] backdrop-blur-[20px]"
            style={up ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }}
          >
            <div className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">{label}</div>
            {options.map(o => (
              <button
                key={o.key}
                type="button"
                onClick={o.pick}
                className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 px-2.5 py-2 text-left text-[13px] text-ink hover:!bg-sky-2"
                style={{ background: o.selected ? '#EEF3FB' : 'transparent', fontWeight: o.selected ? 600 : 400 }}
              >
                <span className="size-2 flex-none rounded-full" style={{ background: o.dot }} />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                <span className="text-[13px] font-bold text-blue" style={{ opacity: o.selected ? 1 : 0 }}>
                  ✓
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function Caret() {
  return (
    <span className="grid size-[18px] flex-none place-items-center rounded-full bg-white/75">
      <svg width="8" height="8" viewBox="0 0 8 8">
        <path d="M1.5 3l2.5 2.5L6.5 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  )
}
