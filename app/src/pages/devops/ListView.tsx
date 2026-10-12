import type { CSSProperties } from 'react'
import type { DvProject } from '../../api/devops/types'
import { useDv } from '../../features/devops/ctx'
import type { Popover } from '../../features/devops/HoverPopover'
import { dayOf, ownerColor, PRIOS, tone } from '../../features/devops/model'
import { DotPill, PrioIcon } from '../../features/devops/ui'
import { projectView } from '../../features/devops/view'

export type SortKey = 'name' | 'infra' | 'prio' | 'step' | 'rem' | 'due' | 'deploy' | 'dev' | 'owner'
export type Sort = { k: SortKey; dir: 'asc' | 'desc' } | null

const COLS = 'minmax(170px,240px) 190px 96px 190px 190px 170px 130px 150px minmax(140px,1fr)'

const HEADS: [SortKey, string][] = [
  ['name', 'Project'],
  ['infra', 'Status'],
  ['prio', 'Priority'],
  ['step', 'Follow-up'],
  ['rem', 'Next reminder'],
  ['due', 'Est. deployment'],
  ['deploy', 'Deployment'],
  ['dev', 'Dev phase'],
  ['owner', 'DevOps owner'],
]

/** The one-line-per-project list, sortable by every column. */
export function ListView({
  projects,
  sort,
  setSort,
  onOpen,
  pop,
}: {
  projects: DvProject[]
  sort: Sort
  setSort: (s: Sort) => void
  onOpen: (p: DvProject) => void
  pop: Popover
}) {
  const { db } = useDv()
  const s = db.settings
  const statusNames = s.statuses.map(x => x.name)

  const rows = (() => {
    if (!sort) return projects
    const ord = (arr: string[], v: string) => {
      const i = arr.indexOf(v)
      return i < 0 ? 999 : i
    }
    const val: Record<SortKey, (p: DvProject) => string | number | null> = {
      name: p => p.name.toLowerCase(),
      infra: p => ord(statusNames, p.infra),
      prio: p => ord(PRIOS, p.prio),
      step: p => p.step ?? null,
      rem: p => dayOf(p.reminder),
      due: p => dayOf(p.latestDue || p.initDue),
      deploy: p => p.deploy || null,
      dev: p => p.dev || null,
      owner: p => p.owner || null,
    }
    const f = val[sort.k]
    const d = sort.dir === 'asc' ? 1 : -1
    return projects.slice().sort((a, b) => {
      const x = f(a)
      const y = f(b)
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (x < y ? -1 : x > y ? 1 : 0) * d
    })
  })()

  return (
    <div className="overflow-hidden rounded-3xl border border-line-3 bg-white">
      <div className="overflow-x-auto">
        <div className="min-w-[1580px]">
          <div
            className="grid h-11 items-center gap-4 border-b border-sky-3 bg-sky-2 px-6"
            style={{ gridTemplateColumns: COLS }}
          >
            {HEADS.map(([k, label]) => {
              const on = sort?.k === k
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSort(!sort || sort.k !== k ? { k, dir: 'asc' } : sort.dir === 'asc' ? { k, dir: 'desc' } : null)}
                  className="flex cursor-pointer items-center gap-1.5 justify-self-start whitespace-nowrap border-0 bg-transparent p-0 font-mono text-[11px] font-medium uppercase tracking-[0.06em]"
                  style={{ color: on ? '#1B2D45' : '#3B4A5E' }}
                >
                  {label}
                  <span className="flex flex-col gap-0.5">
                    <span
                      className="size-0 border-x-4 border-b-4 border-x-transparent"
                      style={{ borderBottomColor: on && sort?.dir === 'asc' ? '#1B2D45' : '#A9B6C5' }}
                    />
                    <span
                      className="size-0 border-x-4 border-t-4 border-x-transparent"
                      style={{ borderTopColor: on && sort?.dir === 'desc' ? '#1B2D45' : '#A9B6C5' }}
                    />
                  </span>
                </button>
              )
            })}
          </div>
          {rows.map(p => {
            const v = projectView(p, s)
            return (
              <div
                key={p.key}
                onClick={() => onOpen(p)}
                data-crit={v.crit ? '1' : undefined}
                className="grid min-h-12 cursor-pointer items-center gap-4 border-b border-line-3 px-6 py-2 transition-[background] duration-150 hover:!bg-[var(--hb)]"
                style={
                  {
                    gridTemplateColumns: COLS,
                    background: v.rowBg,
                    animation: v.crit ? 'critPulse 1.6s ease-in-out infinite' : 'none',
                    boxShadow: `inset 3px 0 0 ${v.accent}`,
                    '--hb': v.hoverBg,
                  } as CSSProperties
                }
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    onMouseEnter={e => pop.openAt(e, p.key, 'phase')}
                    onMouseLeave={pop.leaveSoon}
                    className="flex min-w-0 flex-col"
                  >
                    <span className="truncate whitespace-nowrap text-[14px] font-semibold tracking-[-0.01em]">{p.name}</span>
                  </span>
                </div>
                <div onMouseEnter={e => pop.openAt(e, p.key, 'infra')} onMouseLeave={pop.leaveSoon} className="min-w-0 cursor-help py-1.5">
                  <DotPill label={p.infra} tone={tone(p.infra)} />
                </div>
                <div className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium text-ink">
                  <PrioIcon p={p.prio} />
                  <span className="truncate whitespace-nowrap">{p.prio}</span>
                </div>
                <div className="min-w-0">
                  {v.onLadder ? (
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="min-w-0 truncate whitespace-nowrap text-[13px] font-semibold" style={{ color: v.stepC }}>
                        {v.ladderLabel}
                      </span>
                      <div className="flex w-12 flex-none gap-0.5">
                        {v.dots.map((bg, i) => (
                          <span key={i} className="h-1 flex-1 rounded-sm" style={{ background: bg }} />
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className="truncate whitespace-nowrap text-[13px]" style={{ color: v.fuC }}>
                      {v.fuText}
                      {v.fuSub && <span className="text-slate"> · {v.fuSub}</span>}
                    </div>
                  )}
                </div>
                <div title={v.remTitle} className="min-w-0 truncate whitespace-nowrap text-[13px]">
                  <span className="font-semibold" style={{ color: v.remValC }}>
                    {v.remShort}
                  </span>{' '}
                  <span className="text-[12px] font-medium" style={{ color: v.remRelC }}>
                    {v.remRel}
                  </span>
                </div>
                <div title={v.dueTitle} className="min-w-0 truncate whitespace-nowrap">
                  <span className="tnum text-[13px] font-medium" style={{ color: v.lDueC }}>
                    {v.lDue}
                  </span>{' '}
                  <span className="text-[12px] font-medium" style={{ color: v.dueRelC }}>
                    {v.lDueRel}
                  </span>
                </div>
                <div className="min-w-0">
                  <DotPill label={p.deploy} tone={tone(p.deploy)} />
                </div>
                <div className="min-w-0">
                  <DotPill label={p.dev} tone={tone(p.dev || 'Not set')} />
                </div>
                <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium">
                  <div
                    className="flex size-[22px] flex-none items-center justify-center rounded-[5px] text-[10px] font-semibold text-white"
                    style={{ background: ownerColor(p.owner) }}
                  >
                    {p.owner ? p.owner[0] : '–'}
                  </div>
                  <span className="truncate whitespace-nowrap" style={{ color: p.owner ? '#1B2D45' : '#56657A' }}>
                    {p.owner || 'Unassigned'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
