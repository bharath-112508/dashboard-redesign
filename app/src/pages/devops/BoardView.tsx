import { useRef, useState, type CSSProperties } from 'react'
import type { DvProject } from '../../api/devops/types'
import { useDv } from '../../features/devops/ctx'
import { ownerColor, tileName, tileOf, tileText } from '../../features/devops/model'
import { PrioIcon } from '../../features/devops/ui'
import { projectView } from '../../features/devops/view'

/** One column per status. Dragging a card to another column opens the status change window. */
export function BoardView({ projects, onOpen }: { projects: DvProject[]; onOpen: (p: DvProject) => void }) {
  const { db, setField } = useDv()
  const s = db.settings
  const [over, setOver] = useState<string | null>(null)
  const drag = useRef<string | null>(null)

  return (
    <div className="-mx-6 overflow-x-auto px-6 pb-4">
      <div className="flex w-max items-start gap-3.5">
        {s.statuses.map(({ name, desc }) => {
          const cards = projects.filter(c => (c.infra || 'Not set') === name)
          const hot = over === name
          return (
            <div
              key={name}
              data-column={name}
              onDragOver={e => {
                e.preventDefault()
                if (over !== name) setOver(name)
              }}
              onDrop={e => {
                e.preventDefault()
                const k = drag.current || e.dataTransfer.getData('text/plain')
                drag.current = null
                setOver(null)
                const c = db.projects.find(x => x.key === k)
                if (c && c.infra !== name) setField(c, 'infra', name)
              }}
              className="flex w-[280px] flex-none flex-col gap-2.5 rounded-[18px] p-3 transition-[background,box-shadow] duration-150"
              style={{ background: hot ? '#e8f0fc' : '#E7EEFB', boxShadow: hot ? 'inset 0 0 0 1.5px #4870E8' : 'none' }}
            >
              <div className="px-1 py-0.5">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[12px] font-semibold uppercase tracking-[0.03em] text-ink-2">
                    {name}
                  </span>
                  <span className="tnum inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[9px] bg-line-4 px-1.5 text-[11px] font-semibold text-ink-2">
                    {cards.length}
                  </span>
                </div>
              </div>
              <div className="px-1">
                {desc && <div className="mt-0.5 text-[12px] leading-[1.4] text-muted [text-wrap:pretty]">{desc}</div>}
              </div>
              {cards.map(c => {
                const v = projectView(c, s)
                return (
                  <div
                    key={c.key}
                    draggable
                    onDragStart={e => {
                      drag.current = c.key
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', c.key)
                    }}
                    onDragEnd={() => {
                      drag.current = null
                      setOver(null)
                    }}
                    onClick={() => onOpen(c)}
                    data-crit={v.crit ? '1' : undefined}
                    data-card={c.key}
                    className="flex cursor-grab flex-col gap-2 rounded-[14px] px-3.5 py-3 shadow-[var(--sh)] hover:!shadow-[0_0_0_1px_#C9D2DD,0_4px_14px_rgba(0,0,0,0.07)]"
                    style={
                      {
                        background: v.rowBg,
                        animation: v.crit ? 'critPulse 1.6s ease-in-out infinite' : 'none',
                        '--sh': `0 0 0 1px #E4EAF0,0 1px 2px rgba(0,0,0,0.04),inset 3px 0 0 ${v.accent}`,
                      } as CSSProperties
                    }
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="flex size-6 flex-none items-center justify-center rounded text-[10px] font-bold text-white"
                        style={{ background: tileOf(tileName(c)) }}
                      >
                        {tileText(tileName(c))}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate whitespace-nowrap text-[14px] font-semibold">{c.name}</div>
                        {c.client && <div className="truncate whitespace-nowrap text-[11.5px] font-medium text-muted">{c.client}</div>}
                      </div>
                      <div className="tnum flex-none whitespace-nowrap rounded-[5px] bg-sky-2 px-1.5 py-[3px] font-sans text-[11px] font-medium leading-none text-blue-ink">
                        {c.key}
                      </div>
                    </div>
                    <div className="clamp-2 text-[12px] leading-[1.4] text-muted">{v.phaseShort}</div>
                    <div className="flex items-center gap-2">
                      <span title={c.prio} className="inline-flex items-center gap-1 text-[12px] font-medium text-ink-2">
                        <PrioIcon p={c.prio} />
                        {c.prio}
                      </span>
                      <span className="tnum flex-1 whitespace-nowrap text-right text-[12px] font-medium" style={{ color: v.dueRelC }}>
                        {v.dueShort}
                      </span>
                      <div
                        title={c.owner || 'Unassigned'}
                        className="flex size-[22px] flex-none items-center justify-center rounded-[5px] text-[10px] font-semibold text-white"
                        style={{ background: ownerColor(c.owner) }}
                      >
                        {c.owner ? c.owner[0] : '–'}
                      </div>
                    </div>
                  </div>
                )
              })}
              {!cards.length && (
                <div className="rounded-xl border border-dashed border-line px-2.5 py-[18px] text-center text-[12px] text-slate">
                  Drop a project here
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
