import { useState } from 'react'
import { useDevops, useWorkspace } from '../../api/queries'
import { CheckSquare, Icon, PATHS, Scrim } from '../../components/ui'
import { range } from '../../lib/dates'
import { devopsTone, pal } from '../../lib/theme'
import { useOverlay, useUi } from '../../state/ui'
import { sprintsOf } from '../../domain/tasks'

export const SPRINT_DOT = { done: '#3F9079', active: '#4870E8', planned: '#A9B6C5' }

type Opt = { key: string; label: string; sub: string; c: string; on: boolean; toggle: () => void }

export function PickerMenu({
  all,
  allLabel,
  opts,
  onClose,
  width,
}: {
  all: { on: boolean; toggle: () => void }
  allLabel: string
  opts: Opt[]
  onClose: () => void
  width?: number
}) {
  return (
    <>
      <Scrim onClick={onClose} />
      <div
        className="absolute left-0 top-10 z-[41] rounded-[14px] border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]"
        style={width ? { width } : { minWidth: 300, width: 'max-content', maxWidth: 'calc(100vw - 32px)' }}
      >
        <div
          onClick={all.toggle}
          className="flex cursor-pointer items-center gap-2.5 rounded-[9px] border-b-[1.5px] border-sky px-2.5 py-[9px] hover:bg-canvas"
        >
          <CheckSquare on={all.on} />
          <span className="text-[13.5px] font-bold text-ink">{allLabel}</span>
        </div>
        {opts.map(o => (
          <div
            key={o.key}
            onClick={o.toggle}
            className="flex cursor-pointer items-center gap-2.5 rounded-[9px] px-2.5 py-2 hover:bg-canvas"
          >
            <CheckSquare on={o.on} />
            <span className="size-2 flex-none rounded-[2px]" style={{ background: o.c }} />
            <span className="whitespace-nowrap text-[13.5px] font-semibold text-ink">{o.label}</span>
            <span className="ml-auto whitespace-nowrap text-[12px] text-muted">{o.sub}</span>
          </div>
        ))}
      </div>
    </>
  )
}

const chevron = <Icon d={PATHS.chevron} size={11} sw={2.8} className="text-ink-2" />

/** Epic and sprint pickers, "Report a bug" and the DevOps status. */
export function EpicBar({ showSprints }: { showSprints: boolean }) {
  const ui = useUi()
  const ws = useWorkspace().data
  // The DevOps board owns the projects; the epic bar only shows the linked one's status.
  const devops = useDevops().data
  const overlay = useOverlay()
  const [open, setOpen] = useState<'e' | 's' | null>(null)
  if (!ws || !devops) return null

  const allE = ws.epics.map(e => e.id)
  const EPS = ui.epSel.includes(ui.epic) ? ui.epSel : [ui.epic]
  const allEOn = EPS.length === allE.length
  const epicLabel =
    allEOn && allE.length > 1
      ? 'All epics'
      : EPS.length === 1
        ? ws.epics.find(e => e.id === EPS[0])?.name
        : EPS.length + ' epics'

  const sp = ws.sprints
    .filter(x => EPS.includes(x.epic))
    .sort((a, b) => (a.epic === b.epic ? (a.start < b.start ? -1 : 1) : a.epic < b.epic ? -1 : 1))
  const ids = [...sp.map(x => x.id), 'backlog']
  const cur = ui.spSel || ids
  const setS = (nx: string[]) => ui.set({ spSel: nx.length === ids.length ? null : nx })
  const multiE = EPS.length > 1
  const sprintLabel = !ui.spSel
    ? 'All sprints'
    : cur.length === 0
      ? 'No sprints'
      : cur.length === 1
        ? cur[0] === 'backlog'
          ? 'Backlog'
          : sp.find(x => x.id === cur[0])?.name
        : cur.length + ' sprints'

  const eSp = sprintsOf(ws.sprints, ui.epic)
  const epicSpan =
    ui.epSel.length > 1 && ui.epSel.includes(ui.epic)
      ? ui.epSel.length + ' epics selected'
      : eSp.length
        ? range(eSp[0].start, eSp[eSp.length - 1].end) + ' · ' + eSp.length + ' sprints'
        : ''

  const project = devops.projects.find(x => x.key === ws.devopsLinks[ui.epic]) || devops.projects[0]
  const [dvC, dvBg, dvDot] = devopsTone(project?.infra ?? '')

  return (
    <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
      <span className="relative inline-flex items-center">
        <button
          type="button"
          onClick={() => setOpen(open === 'e' ? null : 'e')}
          className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-0 bg-sky-2 px-2.5 text-ink"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-blue-ink">Epic</span>
          <span className="text-[14px] font-bold">{epicLabel}</span>
          {chevron}
        </button>
        {open === 'e' && (
          <PickerMenu
            width={260}
            allLabel="All epics"
            all={{ on: allEOn, toggle: () => ui.setEpics(allEOn ? [ui.epic] : allE) }}
            onClose={() => setOpen(null)}
            opts={ws.epics.map(e => {
              const on = EPS.includes(e.id)
              return {
                key: e.id,
                label: e.name,
                sub: ws.sprints.filter(x => x.epic === e.id).length + ' sprints',
                c: pal(e.p)[0],
                on,
                toggle: () => ui.setEpics(on ? EPS.filter(x => x !== e.id) : [...EPS, e.id]),
              }
            })}
          />
        )}
      </span>

      <span className="order-[99] ml-auto inline-flex items-center gap-2">
        <button
          type="button"
          onClick={() => overlay.open('report')}
          className="inline-flex h-[34px] cursor-pointer items-center gap-[7px] rounded-lg border-0 bg-red pl-2 pr-3 text-[13.5px] font-semibold text-white hover:bg-red-600"
        >
          <span className="grid size-5 place-items-center rounded-[5px] bg-white/[.18]">
            <Icon d={PATHS.bug} size={12} />
          </span>
          Report a bug
        </button>
        {project && (
          <span
            title="Updated by the DevOps team"
            className="inline-flex h-[34px] items-center gap-2 rounded-lg px-3 text-[13.5px] font-semibold"
            style={{ background: dvBg, color: dvC }}
          >
            <span className="text-[11px] font-bold uppercase tracking-[0.05em] opacity-80">DevOps</span>
            <span className="size-[7px] rounded-full" style={{ background: dvDot }} />
            {project.infra}
          </span>
        )}
      </span>

      {showSprints && (
        <>
          <span className="relative inline-flex items-center">
            <button
              type="button"
              onClick={() => setOpen(open === 's' ? null : 's')}
              className="inline-flex h-[34px] cursor-pointer items-center gap-2 rounded-lg border-[1.5px] border-line bg-white px-2.5 text-[13.5px] font-semibold text-ink"
            >
              {sprintLabel}
              {chevron}
            </button>
            {open === 's' && (
              <PickerMenu
                allLabel="All sprints"
                all={{ on: !ui.spSel, toggle: () => setS(ui.spSel ? ids : []) }}
                onClose={() => setOpen(null)}
                opts={[
                  ...sp.map(x => {
                    const on = cur.includes(x.id)
                    const en = multiE ? (ws.epics.find(e => e.id === x.epic)?.name ?? '') + ' · ' : ''
                    return {
                      key: x.id,
                      label: en + x.name + (x.state === 'active' ? ' · active' : ''),
                      sub: range(x.start, x.end),
                      c: SPRINT_DOT[x.state],
                      on,
                      toggle: () => setS(on ? cur.filter(y => y !== x.id) : [...cur, x.id]),
                    }
                  }),
                  {
                    key: 'backlog',
                    label: 'Backlog',
                    sub: 'no sprint',
                    c: '#B98A2F',
                    on: cur.includes('backlog'),
                    toggle: () =>
                      setS(cur.includes('backlog') ? cur.filter(y => y !== 'backlog') : [...cur, 'backlog']),
                  },
                ]}
              />
            )}
          </span>
          <span className="text-[13px] text-ink-2">{epicSpan}</span>
        </>
      )}
    </div>
  )
}
