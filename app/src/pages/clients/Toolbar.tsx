import { useState } from 'react'
import type { Priority, TaskType } from '../../api/types'
import { Avatar, Icon, PATHS, Scrim } from '../../components/ui'
import { PRIO, PRIO_ICON, PRIO_ICON_COLOR, PRIO_LIST, TYPE_ICON, TYPE_LIST, TYPES } from '../../lib/theme'
import { initials } from '../../lib/media'
import { useActorName, useScopedTasks } from '../../state/access'
import { useUi } from '../../state/ui'

type Opt = { v: string; label: string; vb: string; path: string; ic: string; soft: string; n: number }

function FilterDropdown({
  value,
  placeholder,
  idlePath,
  opts,
  open,
  setOpen,
  onPick,
  className = '',
}: {
  className?: string
  value: string
  placeholder: string
  idlePath: string
  opts: Opt[]
  open: boolean
  setOpen: (v: boolean) => void
  onPick: (v: string) => void
}) {
  const on = opts.find(o => o.v === value && value)
  return (
    <span className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex h-[34px] cursor-pointer items-center gap-[7px] rounded-lg border pl-[11px] pr-2.5 text-[13.5px] font-semibold text-ink"
        style={{ borderColor: on ? on.ic : '#C9D2DD', background: on ? on.soft : '#FFFFFF' }}
      >
        <Icon
          d={on ? on.path : idlePath}
          vb={on ? on.vb : '0 0 24 24'}
          size={15}
          sw={2.2}
          stroke={on ? on.ic : 'currentColor'}
        />
        {value || placeholder}
        <Icon d={PATHS.chevron} size={11} sw={2.8} />
      </button>
      {open && (
        <>
          <Scrim onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-10 z-[41] min-w-[190px] rounded-xl border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]">
            {opts.map(o => {
              const sel = o.v === value
              return (
                <div
                  key={o.label}
                  onClick={() => {
                    onPick(o.v)
                    setOpen(false)
                  }}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 hover:!bg-canvas"
                  style={{ background: sel ? '#EEF3FB' : 'transparent' }}
                >
                  <span className="grid size-6 flex-none place-items-center rounded-md" style={{ background: o.soft }}>
                    <Icon d={o.path} vb={o.vb} size={14} stroke={o.ic} />
                  </span>
                  <span className="text-[13.5px] font-semibold text-ink">{o.label}</span>
                  <span className="tnum ml-auto text-[12px] text-muted">{o.n}</span>
                  <span className="w-3.5 text-[12px] font-extrabold text-blue">{sel ? '✓' : ''}</span>
                </div>
              )
            })}
          </div>
        </>
      )}
    </span>
  )
}

/** Search, "My tasks" and the type and priority filters above the board. */
export function Toolbar() {
  const ui = useUi()
  const tasks = useScopedTasks() ?? []
  const [open, setOpen] = useState<'t' | 'p' | null>(null)
  const EPS = ui.epSel.includes(ui.epic) ? ui.epSel : [ui.epic]
  const base = tasks.filter(t => !t.parent && EPS.includes(t.epic))
  const all: Opt = { v: '', label: 'All', vb: '0 0 24 24', path: 'M4 6h16M4 12h16M4 18h16', ic: '#22354C', soft: '#EEF3FB', n: base.length }
  const me = useActorName()

  return (
    <div className="mb-[18px] mt-3 flex flex-wrap items-center gap-2">
      <span className="relative flex w-[220px] items-center">
        <span className="absolute left-[11px] flex text-ink-2">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d={PATHS.search} />
          </svg>
        </span>
        <input
          value={ui.q}
          onChange={e => ui.set({ q: e.target.value })}
          placeholder="Search board"
          className="h-[34px] w-full rounded-lg border-[1.5px] border-line bg-white pl-[34px] pr-3 text-[13.5px] text-ink outline-0"
        />
      </span>
      <button
        type="button"
        onClick={() => ui.set({ mine: !ui.mine })}
        title="Show only tasks assigned to me"
        className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-[1.5px] pl-[5px] pr-3 text-[13px] font-bold"
        style={{
          borderColor: ui.mine ? '#4870E8' : '#DDE3E8',
          background: ui.mine ? '#E7EEFB' : '#FFFFFF',
          color: ui.mine ? '#1F3FAF' : '#1B2D45',
        }}
      >
        <Avatar i={initials(me)} bg="#1B2D45" size={24} radius={6} font={10.5} className="!font-bold" />
        My tasks
      </button>
      {ui.hasFilters && (
        <button
          type="button"
          onClick={ui.clearFilters}
          className="h-[34px] cursor-pointer border-0 bg-transparent px-2 text-[13px] font-semibold text-blue-ink"
        >
          Clear
        </button>
      )}
      <FilterDropdown
        className="ml-auto"
        value={ui.typeF}
        placeholder="Type"
        idlePath="M4 6h16M7 12h10M10 18h4"
        open={open === 't'}
        setOpen={v => setOpen(v ? 't' : null)}
        onPick={v => ui.set({ typeF: v as TaskType | '' })}
        opts={[
          all,
          ...TYPE_LIST.map(v => ({ v, label: v, vb: '0 0 24 24', path: TYPE_ICON[v], ic: TYPES[v][0], soft: TYPES[v][1], n: base.filter(t => t.type === v).length })),
        ]}
      />
      <FilterDropdown
        value={ui.prioF}
        placeholder="Priority"
        idlePath="M5 21V4h11l-2 4 2 4H5"
        open={open === 'p'}
        setOpen={v => setOpen(v ? 'p' : null)}
        onPick={v => ui.set({ prioF: v as Priority | '' })}
        opts={[
          all,
          ...PRIO_LIST.map(v => ({
            v,
            label: v,
            vb: '0 0 16 16',
            path: PRIO_ICON[v],
            ic: PRIO_ICON_COLOR[v],
            soft: v === 'Critical' ? '#FBE3DF' : PRIO[v][1],
            n: base.filter(t => t.prio === v).length,
          })),
        ]}
      />
    </div>
  )
}
