import { useState } from 'react'
import { useWorkspace } from '../../api/queries'
import { Icon, PATHS } from '../../components/ui'
import { range } from '../../lib/dates'
import { pal } from '../../lib/theme'
import { useUi } from '../../state/ui'
import { sprintsOf } from '../../domain/tasks'
import { DevopsPanel } from '../../features/tickets/DevopsPanel'
import { QuestionsPanel } from '../../features/tickets/QuestionsPanel'
import { PickerMenu, SPRINT_DOT } from '../clients/EpicBar'

const chevron = <Icon d={PATHS.chevron} size={11} sw={2.8} className="text-ink-2" />

/** Epic and sprint pickers, the DevOps panel and the "Questions to client" panel. */
export function TicketsEpicBar({ showSprints }: { showSprints: boolean }) {
  const ui = useUi()
  const ws = useWorkspace().data!
  const [open, setOpen] = useState<'e' | 's' | null>(null)

  const allE = ws.epics.map(e => e.id)
  const EPS = ui.epSel.includes(ui.epic) ? ui.epSel : [ui.epic]
  const allEOn = EPS.length === allE.length
  const epicLabel =
    allEOn && allE.length > 1 ? 'All epics' : EPS.length === 1 ? ws.epics.find(e => e.id === EPS[0])?.name : EPS.length + ' epics'
  const epicName = ws.epics.find(e => e.id === ui.epic)?.name ?? ''

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

      <DevopsPanel epic={ui.epic} epicName={epicName} />
      <QuestionsPanel epic={ui.epic} />

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
                    toggle: () => setS(cur.includes('backlog') ? cur.filter(y => y !== 'backlog') : [...cur, 'backlog']),
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
