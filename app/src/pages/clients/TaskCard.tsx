import type { DragEvent } from 'react'
import type { Priority } from '../../api/types'
import { Avatar } from '../../components/ui'
import { PRIO_ICON, PRIO_ICON_COLOR } from '../../lib/theme'

export interface CardModel {
  id: string
  key: string
  title: string
  blurb: string
  prio: Priority
  critical: boolean
  /** Blink the card (critical and not done). */
  blink: boolean
  sprintLabel: string
  dueLabel: string
  dueColor: string
  dueWeight: number
  avatars: { name: string; i: string; bg: string; color: string; ring: string }[]
  subLabel?: string
  draggable: boolean
}

export function PrioMark({ prio, size = 16, font = 13, weight = 700 }: { prio: Priority; size?: number; font?: number; weight?: number }) {
  return (
    <span
      title={prio + ' priority'}
      className="inline-flex flex-none items-center gap-1.5 whitespace-nowrap text-ink"
      style={{ fontSize: font, fontWeight: weight }}
    >
      <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke={PRIO_ICON_COLOR[prio]} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d={PRIO_ICON[prio]} />
      </svg>
      {prio}
    </span>
  )
}

export function CriticalBadge({ small = false }: { small?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-[5px] bg-red font-extrabold text-white ${
        small ? 'h-5 pl-1.5 pr-2 text-[11px]' : 'h-[22px] rounded-md pl-[7px] pr-[9px] text-[12px] tracking-[0.02em]'
      }`}
    >
      <span className={`animate-crit-dot rounded-full bg-white ${small ? 'size-1.5' : 'size-[7px]'}`} />
      Critical
    </span>
  )
}

/** A ticket card on the board. */
export function TaskCard({
  c,
  onOpen,
  onDragStart,
  onDragEnd,
  dragging,
}: {
  c: CardModel
  onOpen: () => void
  onDragStart?: (e: DragEvent) => void
  onDragEnd?: () => void
  dragging: boolean
}) {
  return (
    <div
      draggable={c.draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      data-crit={c.critical ? '1' : undefined}
      className={`flex cursor-pointer flex-col gap-2.5 rounded-[14px] bg-white px-3.5 pb-3 pt-3.5 shadow-[0_0_0_1.5px_#D6DEE8,0_1px_2px_rgba(27,45,69,0.04)] transition-shadow hover:shadow-[0_0_0_1.5px_#4870E8,0_6px_16px_-8px_rgba(27,45,69,0.2)] ${
        c.blink ? 'animate-crit-blink' : ''
      }`}
      style={{ opacity: dragging ? 0.5 : 1 }}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="flex flex-none">
          {c.avatars.map(a => (
            <Avatar
              key={a.name}
              title={a.name}
              i={a.i}
              bg={a.bg}
              color={a.color}
              size={24}
              radius={6}
              font={10}
              className="!font-bold"
              ring={`0 0 0 2px #fff,${a.ring}`}
              style={{ marginRight: -6 }}
            />
          ))}
        </span>
        <span className="ml-[7px] min-w-0 flex-1 truncate text-[14px] font-semibold tracking-normal text-ink">{c.title}</span>
        <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-[7px] py-[3px] text-[11.5px] font-semibold text-blue-ink">
          {c.key}
        </span>
      </div>
      {c.blurb && <div className="clamp-2 text-[13.5px] leading-[1.45] text-ink-2">{c.blurb}</div>}
      <div className="flex items-center gap-2">
        {c.critical ? <CriticalBadge /> : <PrioMark prio={c.prio} />}
        <span className="flex-none whitespace-nowrap rounded-[5px] bg-sky-2 px-[7px] py-0.5 text-[11px] font-bold text-blue-ink">
          {c.sprintLabel}
        </span>
        <span className="ml-auto whitespace-nowrap text-[13px]" style={{ color: c.dueColor, fontWeight: c.dueWeight }}>
          {c.dueLabel}
        </span>
      </div>
      {c.subLabel && (
        <div className="flex items-center gap-2 border-t-[1.5px] border-sky pt-[9px] text-[12.5px] font-semibold text-ink-2">
          Subtasks
          <span className="rounded-[5px] bg-sky-2 px-1.5 py-px text-blue-ink">{c.subLabel}</span>
        </div>
      )}
    </div>
  )
}
