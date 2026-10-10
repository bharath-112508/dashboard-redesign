import { useLayoutEffect, useRef, useState } from 'react'
import type { Task } from '../../api/types'
import { Avatar, Icon, PATHS } from '../../components/ui'
import { diff, range, TODAY, weeks } from '../../lib/dates'
import { pal, SPRINT_STATE } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { useOverlay, useUi } from '../../state/ui'
import { useIsClient, useScopedTasks, useScopedWorkspace } from '../../state/access'
import { assigneesOf, cardAvatars, sprintsOf, statusOf, taskKey } from '../../domain/tasks'
import { useCreateTicket, useOpenTask } from '../../features/useOpenTask'
import { onActivate } from '../../features/plan/keyboard'
import { CriticalBadge, PrioMark } from './TaskCard'
import { short } from '../../lib/dates'

const btn =
  'h-[34px] flex-none cursor-pointer whitespace-nowrap rounded-lg border-[1.5px] border-line bg-white px-3 text-[13px] font-semibold text-ink hover:border-blue'

function PlanTaskCard({ t, onOpen }: { t: Task; onOpen: () => void }) {
  const person = usePerson()
  const ws = useScopedWorkspace()!
  const st = statusOf(ws.statuses, t.status)
  const overdue = !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={onActivate(onOpen)}
      data-crit={t.prio === 'Critical' ? '1' : undefined}
      className={`flex w-[360px] cursor-pointer flex-col gap-2 rounded-xl bg-white px-3 py-2.5 shadow-[0_0_0_1.5px_#D6DEE8] hover:shadow-[0_0_0_1.5px_#4870E8,0_6px_16px_-8px_rgba(27,45,69,0.2)] ${
        t.prio === 'Critical' && t.status !== 'done' ? 'animate-crit-blink' : ''
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex flex-none">
          {cardAvatars(assigneesOf(t), person).map(a => (
            <Avatar key={a.name} title={a.name} i={a.i} bg={a.bg} color={a.color} size={22} radius={5} font={9} className="!font-bold" ring={`0 0 0 2px #fff,${a.ring}`} style={{ marginRight: -5 }} />
          ))}
        </span>
        <span className="ml-[5px] min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{t.title}</span>
        <span className="tnum flex-none whitespace-nowrap rounded-[5px] bg-sky-2 px-1.5 py-0.5 text-[11px] font-semibold text-blue-ink">{taskKey(t)}</span>
      </div>
      <div className="flex items-center gap-2">
        {t.prio === 'Critical' ? <CriticalBadge small /> : <PrioMark prio={t.prio} size={14} font={12} weight={600} />}
        <span className="inline-flex items-center gap-[5px] text-[12px] font-semibold" style={{ color: st.ink }}>
          <span className="size-1.5 rounded-full" style={{ background: st.c }} />
          {st.name}
        </span>
        {t.subs.length > 0 && (
          <span className="inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-[5px] bg-sky px-[7px] text-[11.5px] font-semibold text-ink-2">
            <Icon d={PATHS.subtask} size={11} />
            {t.subs.length} subtask{t.subs.length === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto whitespace-nowrap text-[12px]" style={{ fontWeight: overdue ? 800 : 600, color: overdue ? '#C0392B' : '#3B4A5E' }}>
          {short(t.due)}
        </span>
      </div>
    </div>
  )
}

/** Epic → Sprints → Tasks tree. */
export function PlanView() {
  const person = usePerson()
  const ws = useScopedWorkspace()!
  const tasks = (useScopedTasks() ?? []).filter(t => !t.parent)
  // Client users read the plan; creating epics, sprints and tickets is the team's job.
  const isClient = useIsClient()
  const ui = useUi()
  const overlay = useOverlay()
  const openTask = useOpenTask()
  const createTicket = useCreateTicket()
  const [openMap, setOpenMap] = useState<Record<string, boolean>>({})

  // Epics and sprints that appear after the first render (created here or in another tab) start expanded,
  // so their "+ New sprint" / "+ Create ticket" buttons are visible straight away.
  const known = useRef<Set<string> | null>(null)
  useLayoutEffect(() => {
    const keys = [...ws.epics.map(e => 'e_' + e.id), ...ws.sprints.map(s => 's_' + s.id)]
    const prev = known.current
    known.current = new Set(keys)
    if (!prev) return
    const fresh = keys.filter(k => !prev.has(k))
    if (fresh.length) setOpenMap(m => ({ ...m, ...Object.fromEntries(fresh.map(k => [k, true])) }))
  }, [ws.epics, ws.sprints])

  const dflt = (k: string) => {
    if (k.startsWith('e_')) return k.slice(2) === ui.epic
    return ws.sprints.find(s => 's_' + s.id === k)?.state === 'active'
  }
  const isOpen = (k: string) => openMap[k] ?? dflt(k)
  const toggle = (k: string) => setOpenMap(m => ({ ...m, [k]: !(m[k] ?? dflt(k)) }))
  const setAll = (v: boolean) => {
    const o: Record<string, boolean> = {}
    ws.epics.forEach(e => (o['e_' + e.id] = v))
    ws.sprints.forEach(s => (o['s_' + s.id] = v))
    setOpenMap(o)
  }
  const today = new Date(TODAY + 'T12:00:00Z').toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="whitespace-nowrap text-[13px] font-semibold text-ink-2">
          Epic → Sprints → Tasks · {ws.epics.length} epics · {ws.sprints.length} sprints · {tasks.length} tasks
        </span>
        <span className="ml-auto inline-flex h-[34px] items-center gap-1.5 whitespace-nowrap rounded-lg bg-sky-2 px-3 text-[13px] font-bold text-blue-ink">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
          {/* Two spans, as in the prototype: the 6px flex gap sits between "Today ·" and the date. */}
          <span>Today · </span>
          <span>{today}</span>
        </span>
        <button type="button" onClick={() => setAll(true)} className={btn}>Expand all</button>
        <button type="button" onClick={() => setAll(false)} className={btn}>Collapse all</button>
        {!isClient && (
        <button
          type="button"
          onClick={() => overlay.open('newEpic')}
          className="inline-flex h-[34px] flex-none cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg border-0 bg-blue px-3.5 text-[13.5px] font-semibold text-white hover:bg-blue-600"
        >
          <Icon d={PATHS.plus} size={14} sw={2.6} />
          Epic
        </button>
        )}
      </div>

      {ws.epics.map(e => {
        const [c] = pal(e.p)
        const sp = sprintsOf(ws.sprints, e.id)
        const ts = tasks.filter(t => t.epic === e.id)
        const dn = ts.filter(t => t.status === 'done').length
        const eOpen = isOpen('e_' + e.id)
        const newSprint = () => overlay.open('newSprint', e.id)
        return (
          <div key={e.id} className="overflow-x-auto rounded-2xl bg-white p-3.5 shadow-[0_0_0_1.5px_#D6DEE8]">
            <div className="flex min-w-max items-start">
              <div className="sticky left-0 w-[250px] flex-none">
                <div className="rounded-[14px] bg-sky p-3">
                  <div className="flex items-center gap-2">
                    <span className="size-2.5 flex-none rounded-[3px]" style={{ background: c }} />
                    <span className="min-w-0 flex-1 truncate text-[15px] font-bold text-ink">{e.name}</span>
                    <button
                      type="button"
                      onClick={() => toggle('e_' + e.id)}
                      title="Collapse"
                      className="grid size-[26px] flex-none cursor-pointer place-items-center rounded-[7px] border-[1.5px] border-line bg-white p-0 text-ink-2"
                    >
                      <Icon d={PATHS.next} size={12} sw={2.8} style={{ transform: `rotate(${eOpen ? 90 : 0}deg)`, transition: 'transform .2s' }} />
                    </button>
                  </div>
                  <div className="mt-1 text-[12px] text-muted">{sp.length ? range(sp[0].start, sp[sp.length - 1].end) : 'No sprints yet'}</div>
                  <div className="mt-2 rounded-[10px] bg-white p-2.5 shadow-[0_0_0_1.5px_#D6DEE8]">
                    <div className="clamp-3 text-[12.5px] leading-[1.45] text-ink-2">{e.story || e.desc || 'No requirement written yet.'}</div>
                  </div>
                  <div className="mt-2 flex justify-between text-[12px] font-semibold text-ink-2">
                    <span>{sp.length} sprints</span>
                    <span className="tnum">{dn}/{ts.length} done</span>
                  </div>
                  <div className="mt-1 h-[5px] overflow-hidden rounded-[3px] bg-sky-3">
                    <div className="h-full" style={{ width: (ts.length ? Math.round((dn / ts.length) * 100) : 0) + '%', background: c }} />
                  </div>
                  <div className="mt-2.5 flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => overlay.open('epic', e.id)}
                      className="h-8 flex-1 cursor-pointer rounded-lg border-[1.5px] border-line bg-white text-[12.5px] font-semibold text-ink hover:border-blue"
                    >
                      Overview
                    </button>
                    {!isClient && (
                      <button type="button" onClick={newSprint} className="h-8 flex-1 cursor-pointer rounded-lg border-0 bg-blue text-[12.5px] font-semibold text-white">
                        + Sprint
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {eOpen ? (
                <>
                  <div className="relative w-7 flex-none self-stretch">
                    <span className="absolute inset-x-0 top-10 h-0.5 bg-line" />
                  </div>
                  <div className="flex flex-col gap-2.5 border-l-2 border-line py-0.5">
                    {sp.map(x => {
                      const [stInk, stSoft, stDot, stLabel] = SPRINT_STATE[x.state]
                      const sts = ts.filter(t => t.sprint === x.id)
                      const sdn = sts.filter(t => t.status === 'done').length
                      const sOpen = isOpen('s_' + x.id)
                      const active = x.state === 'active'
                      return (
                        <div key={x.id} className="flex items-start">
                          <span className="mt-[38px] h-0.5 w-[18px] flex-none bg-line" />
                          <div
                            role="button"
                            tabIndex={0}
                            aria-label={`${x.name}, ${stLabel}`}
                            aria-expanded={sOpen}
                            onClick={() => toggle('s_' + x.id)}
                            onKeyDown={onActivate(() => toggle('s_' + x.id))}
                            className="w-[270px] flex-none cursor-pointer rounded-[14px] px-3 py-2.5 hover:!shadow-[inset_0_0_0_1.5px_#4870E8]"
                            style={{ background: active ? '#E7EEFB' : '#EEF3FB', boxShadow: active ? 'inset 0 0 0 1.5px #4870E8' : 'none' }}
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-[13.5px] font-semibold text-ink">{x.name}</span>
                              <span className="tnum text-[13px] text-ink-2">{sts.length}</span>
                              <span className="inline-flex items-center gap-[5px] rounded-full py-px pl-1.5 pr-2 text-[11.5px] font-semibold" style={{ background: stSoft, color: stInk }}>
                                <span className="size-1.5 rounded-full" style={{ background: stDot }} />
                                {stLabel}
                              </span>
                              <button
                                type="button"
                                onClick={ev => {
                                  ev.stopPropagation()
                                  overlay.open('sprint', x.id)
                                }}
                                title="Sprint overview"
                                className="ml-auto grid size-[26px] cursor-pointer place-items-center rounded-[7px] border-[1.5px] border-line bg-white p-0 text-blue-ink"
                              >
                                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                  <circle cx="12" cy="12" r="9" />
                                  <path d="M12 11v5M12 8h.01" />
                                </svg>
                              </button>
                            </div>
                            <div className="mt-1 flex items-center gap-2">
                              <span className="whitespace-nowrap text-[12px] text-muted">
                                {range(x.start, x.end)} · {weeks(x.start, x.end)}
                              </span>
                              <span className="ml-auto flex">
                                {x.members.map(n => {
                                  const m = person(n)
                                  return <Avatar key={n} title={n} i={m.i} bg={m.bg} size={20} radius={5} font={8.5} className="!font-bold" ring="0 0 0 2px #EEF3FB" style={{ marginRight: -4 }} />
                                })}
                              </span>
                            </div>
                            {x.goal && <div className="clamp-2 mt-1.5 text-[12.5px] font-semibold leading-[1.4] text-ink">{x.goal}</div>}
                            <div className="mt-2 flex items-center gap-2">
                              <div className="h-1 flex-1 overflow-hidden rounded-sm bg-sky-3">
                                <div className="h-full bg-green" style={{ width: (sts.length ? Math.round((sdn / sts.length) * 100) : 0) + '%' }} />
                              </div>
                              <span className="tnum text-[11.5px] font-semibold text-ink-2">{sdn}/{sts.length} done</span>
                            </div>
                          </div>
                          {sOpen ? (
                            <>
                              <span className="mt-[38px] h-0.5 w-6 flex-none bg-line" />
                              <div className="flex flex-col gap-2 border-l-2 border-dashed border-line py-0.5">
                                {sts.map(t => (
                                  <div key={t.id} className="flex items-center">
                                    <span className="h-0.5 w-3.5 flex-none bg-line" />
                                    <PlanTaskCard t={t} onOpen={() => openTask(t)} />
                                  </div>
                                ))}
                                <div className="flex items-center">
                                  <span className="h-0.5 w-3.5 flex-none bg-line" />
                                  {!isClient && (
                                  <button
                                    type="button"
                                    onClick={() => createTicket({ epic: e.id, sprint: x.id })}
                                    className="h-[34px] w-[374px] cursor-pointer rounded-[10px] border-[1.5px] border-dashed border-faint bg-white px-3 text-left text-[12.5px] font-bold text-blue-ink hover:border-blue hover:bg-sky"
                                  >
                                    + Create ticket
                                  </button>
                                  )}
                                </div>
                              </div>
                            </>
                          ) : (
                            <span
                              role="button"
                              tabIndex={0}
                              onClick={() => toggle('s_' + x.id)}
                              onKeyDown={onActivate(() => toggle('s_' + x.id))}
                              className="ml-3 mt-8 cursor-pointer whitespace-nowrap text-[12.5px] font-semibold text-blue-ink"
                            >
                              {sts.length} task{sts.length === 1 ? '' : 's'} ›
                            </span>
                          )}
                        </div>
                      )
                    })}
                    <div className="flex items-center">
                      <span className="h-0.5 w-[18px] flex-none bg-line" />
                      {!isClient && (
                    <button
                        type="button"
                        onClick={newSprint}
                        className="h-10 w-[270px] cursor-pointer rounded-xl border-[1.5px] border-dashed border-faint bg-white text-[13px] font-semibold text-blue-ink hover:border-blue hover:bg-sky"
                      >
                        + New sprint
                      </button>
                    )}
                    </div>
                  </div>
                </>
              ) : (
                <div
                  role="button"
                  tabIndex={0}
                  aria-expanded={false}
                  onClick={() => toggle('e_' + e.id)}
                  onKeyDown={onActivate(() => toggle('e_' + e.id))}
                  className="ml-4 flex cursor-pointer items-center gap-1.5 self-center"
                >
                  <span className="h-0.5 w-6 bg-line" />
                  {sp.map(x => {
                    const [stInk, stSoft] = SPRINT_STATE[x.state]
                    return (
                      <span
                        key={x.id}
                        title={x.name + ' · ' + range(x.start, x.end)}
                        className="inline-flex h-[26px] min-w-9 items-center justify-center rounded-[7px] px-2 text-[12px] font-bold"
                        style={{ background: stSoft, color: stInk }}
                      >
                        {x.name.replace('Sprint ', 'S')}
                      </span>
                    )
                  })}
                  <span className="ml-1.5 whitespace-nowrap text-[12.5px] font-semibold text-blue-ink">{ts.length} tasks · expand ›</span>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
