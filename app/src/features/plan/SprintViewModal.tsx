import { useState } from 'react'
import { useActorSend, useIsClient, useScopedTasks, useScopedWorkspace } from '../../state/access'
import { CloseButton } from '../../components/ui'
import { diff, range, short, TODAY, weeks } from '../../lib/dates'
import { SPRINT_STATE } from '../../lib/theme'
import { usePage, usePerson } from '../../state/page'
import { useMe } from '../tickets/useMe'
import { useOverlay } from '../../state/ui'
import { statusOf, taskKey } from '../../domain/tasks'
import { useOpenTask } from '../useOpenTask'
import { useEscape } from '../useEscape'
import type { Command } from '../../api/commands'
import type { TaskId } from '../../api/types'
import { onActivate } from './keyboard'

const C = 2 * Math.PI * 50

/** Sprint overview: goal, why it matters, goals checklist and tasks. */
export function SprintViewModal({ id }: { id: string }) {
  const person = usePerson()
  const ws = useScopedWorkspace()!
  const tasks = (useScopedTasks() ?? []).filter(t => !t.parent)
  const send = useActorSend()
  const overlay = useOverlay()
  const openTask = useOpenTask()
  const close = () => overlay.close('sprint')
  useEscape(close)
  const me = useMe()
  const { side } = usePage()
  const [picking, setPicking] = useState(false)
  const [picked, setPicked] = useState<TaskId[]>([])
  const [confirming, setConfirming] = useState(false)

  const x = ws.sprints.find(y => y.id === id)
  if (!x) return null
  // Lifecycle rules (decision 2): one active sprint per epic; completing a sprint moves its unfinished tasks to the next planned sprint of the epic, or to the backlog when there is none.
  const activeOther = ws.sprints.find(y => y.epic === x.epic && y.state === 'active' && y.id !== x.id)
  const nextPlanned = ws.sprints
    .filter(y => y.epic === x.epic && y.state === 'planned' && y.id !== x.id)
    .sort((a, b) => (a.start < b.start ? -1 : 1))[0]
  const unfinished = tasks.filter(t => t.sprint === x.id && t.status !== 'done')
  const backlog = tasks.filter(t => t.epic === x.epic && !t.sprint && t.status !== 'done')
  // Client users read sprints; starting, completing and planning them is the team's job.
  const isClient = useIsClient()
  const teamSide = side === 'team' && !isClient
  const startSprint = () => send({ type: 'sprint.update', id: x.id, patch: { state: 'active' } })
  const completeSprint = () => {
    const cmds: Command[] = [{ type: 'sprint.update', id: x.id, patch: { state: 'done', summary: 'Completed' } }]
    unfinished.forEach(t =>
      cmds.push({
        type: 'task.update',
        who: me.name,
        id: t.id,
        patch: { sprint: nextPlanned?.id ?? null },
        log: nextPlanned ? 'moved it to ' + nextPlanned.name + ' when ' + x.name + ' completed' : 'moved it to the backlog when ' + x.name + ' completed',
      }),
    )
    send({ type: 'batch', cmds })
    setConfirming(false)
  }
  const addPicked = () => {
    const cmds: Command[] = picked.map(tid => ({
      type: 'task.update',
      who: me.name,
      id: tid,
      patch: { sprint: x.id },
      log: 'moved it to ' + x.name,
    }))
    if (cmds.length) send({ type: 'batch', cmds })
    setPicked([])
    setPicking(false)
  }
  const [stInk, stSoft, stDot, stLabel] = SPRINT_STATE[x.state]
  const ts = tasks.filter(t => t.sprint === x.id)
  const dn = ts.filter(t => t.status === 'done').length
  const pct = ts.length ? Math.round((dn / ts.length) * 100) : 0
  const left = diff(x.end, TODAY)
  const gd = x.goalsDone || {}
  const ep = ws.epics.find(e => e.id === x.epic)
  const goals = x.goals || []

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[70] animate-fade-in bg-[rgba(27,45,69,0.45)]" />
      <div className="fixed left-1/2 top-1/2 z-[71] max-h-[calc(100vh-40px)] w-[min(940px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 animate-pop-in overflow-y-auto rounded-[28px] bg-canvas shadow-[0_40px_100px_rgba(27,45,69,0.35)]">
        <div className="relative rounded-t-[28px] bg-sky-3 px-[34px] pb-6 pt-7">
          <CloseButton onClick={close} className="absolute right-[18px] top-[18px]" />
          <div className="flex flex-wrap items-center gap-7 pr-10">
            <div className="min-w-[280px] flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-md bg-blue px-[9px] py-[3px] text-[11px] font-extrabold uppercase tracking-[0.08em] text-white">Sprint</span>
                <span className="inline-flex items-center gap-[5px] rounded-full py-0.5 pl-[7px] pr-[9px] text-[12px] font-bold" style={{ background: stSoft, color: stInk }}>
                  <span className="size-1.5 rounded-full" style={{ background: stDot }} />
                  {stLabel}
                </span>
                <span className="text-[12.5px] font-bold text-blue-ink">
                  {ep?.name} · {range(x.start, x.end)} · {weeks(x.start, x.end)}
                </span>
              </div>
              <div className="mt-2.5 font-serif text-[40px] leading-[1.05] text-ink">{x.name}</div>
              <div className="mt-3 max-w-[560px] text-[19px] font-semibold leading-[1.45] text-ink [text-wrap:pretty]">{x.goal || 'No sprint goal yet.'}</div>
              <div className="mt-3.5 flex items-center gap-2">
                {x.members.map(n => {
                  const m = person(n)
                  return (
                    <span key={n} className="inline-flex h-8 items-center gap-[7px] rounded-[9px] bg-white pl-1 pr-2.5 text-[13px] font-bold">
                      <span className="grid size-6 place-items-center rounded-md text-[10px] font-bold text-white" style={{ background: m.bg }}>
                        {m.i}
                      </span>
                      {n}
                    </span>
                  )
                })}
              </div>
              {teamSide && x.state !== 'done' && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {x.state === 'planned' && (
                    <button
                      type="button"
                      onClick={startSprint}
                      disabled={!!activeOther}
                      title={activeOther ? 'Complete ' + activeOther.name + ' first' : undefined}
                      className="h-9 cursor-pointer rounded-[10px] border-0 bg-blue px-3.5 text-[13.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Start sprint
                    </button>
                  )}
                  {x.state === 'active' && (
                    <button
                      type="button"
                      onClick={() => setConfirming(c => !c)}
                      className="h-9 cursor-pointer rounded-[10px] border-[1.5px] border-line bg-white px-3.5 text-[13.5px] font-semibold text-ink"
                    >
                      Complete sprint
                    </button>
                  )}
                </div>
              )}
              {teamSide && confirming && x.state === 'active' && (
                <div className="mt-3 rounded-xl bg-white px-3.5 py-3 text-[13px] text-ink-2 shadow-[0_0_0_1.5px_#C9D2DD]">
                  <div>
                    {unfinished.length
                      ? unfinished.length + ' unfinished task' + (unfinished.length === 1 ? '' : 's') + ' move to ' + (nextPlanned ? nextPlanned.name : 'the backlog') + '.'
                      : 'Every task is done. Nothing moves.'}
                  </div>
                  <div className="mt-2.5 flex gap-2">
                    <button type="button" onClick={completeSprint} className="h-8 cursor-pointer rounded-lg border-0 bg-ink px-3 text-[12.5px] font-semibold text-white">
                      Complete and move tasks
                    </button>
                    <button type="button" onClick={() => setConfirming(false)} className="h-8 cursor-pointer rounded-lg border-[1.5px] border-line bg-white px-3 text-[12.5px] font-semibold text-ink">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="relative size-[140px] flex-none">
              <svg viewBox="0 0 120 120" width="140" height="140" style={{ transform: 'rotate(-90deg)' }}>
                <circle cx="60" cy="60" r="50" fill="none" stroke="#FFFFFF" strokeWidth="12" />
                <circle cx="60" cy="60" r="50" fill="none" stroke="#4870E8" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${((C * pct) / 100).toFixed(1)} ${C.toFixed(1)}`} />
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-[30px] font-extrabold text-ink">{pct}%</span>
                <span className="text-[12px] font-bold text-ink-2">{x.state === 'done' ? 'Completed' : left >= 0 ? left + ' days left' : 'Ended'}</span>
              </div>
            </div>
          </div>
        </div>
        <div className="grid gap-[18px] px-[34px] pb-[30px] pt-6" style={{ gridTemplateColumns: 'minmax(0,1.1fr) minmax(0,1fr)' }}>
          <div className="flex flex-col gap-[18px]">
            <div className="rounded-[20px] bg-white px-[22px] py-5 shadow-[0_0_0_1.5px_#C9D2DD]">
              <div className="text-[15px] font-extrabold">Why it matters</div>
              <div className="mt-3 border-l-4 border-blue pl-4 font-serif text-[18px] leading-normal [text-wrap:pretty]" style={{ color: x.why ? '#1B2D45' : '#3B4A5E' }}>
                {x.why || 'Not written yet.'}
              </div>
            </div>
            <div className="rounded-[20px] bg-white px-[22px] py-5 shadow-[0_0_0_1.5px_#C9D2DD]">
              <div className="flex items-center">
                <span className="text-[15px] font-extrabold">Goals</span>
                <span className="ml-auto text-[12px] font-bold text-ink-2">
                  {Object.values(gd).filter(Boolean).length}/{goals.length}
                </span>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {goals.map((t, i) => {
                  const on = !!gd[i]
                  const toggleGoal = () => send({ type: 'sprint.update', id: x.id, patch: { goalsDone: { ...gd, [i]: !on } } })
                  return (
                    <div
                      key={i}
                      role="checkbox"
                      aria-checked={on}
                      tabIndex={0}
                      onClick={toggleGoal}
                      onKeyDown={onActivate(toggleGoal)}
                      className="flex cursor-pointer items-center gap-3 rounded-xl px-3.5 py-[11px]"
                      style={{ background: on ? '#EEF7F3' : '#F6F9FC', boxShadow: `inset 0 0 0 1.5px ${on ? '#3F9079' : '#E4EAF0'}` }}
                    >
                      <span
                        className="grid size-[22px] flex-none place-items-center rounded-md border-2 text-[12px] font-extrabold text-white"
                        style={{ borderColor: on ? '#3F9079' : '#A9B6C5', background: on ? '#3F9079' : '#fff' }}
                      >
                        {on ? '✓' : ''}
                      </span>
                      <span className="text-[14px] font-bold" style={{ color: on ? '#3B4A5E' : '#1B2D45', textDecoration: on ? 'line-through' : 'none' }}>
                        {t}
                      </span>
                    </div>
                  )
                })}
                {!goals.length && <div className="text-[13.5px] text-muted">No goals added for this sprint.</div>}
              </div>
            </div>
          </div>
          <div className="self-start rounded-[20px] bg-white px-[22px] py-5 shadow-[0_0_0_1.5px_#C9D2DD]">
            <div className="flex items-center">
              <span className="text-[15px] font-extrabold">Tasks</span>
              <span className="ml-auto text-[12px] font-bold text-ink-2">
                {dn}/{ts.length} done
              </span>
              {teamSide && x.state !== 'done' && (
                <button
                  type="button"
                  onClick={() => setPicking(p => !p)}
                  className="ml-3 h-7 cursor-pointer rounded-lg border-0 bg-sky-2 px-2.5 text-[12px] font-semibold text-blue-ink"
                >
                  + Add from backlog
                </button>
              )}
            </div>
            {teamSide && picking && (
              <div className="mt-3 rounded-xl bg-canvas p-2.5">
                {backlog.length ? (
                  <>
                    <div className="flex flex-col gap-1">
                      {backlog.map(t => {
                        const on = picked.includes(t.id)
                        return (
                          <label key={t.id} className="flex cursor-pointer items-center gap-2.5 rounded-lg bg-white px-2.5 py-2 text-[13px]">
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => setPicked(p => (on ? p.filter(v => v !== t.id) : [...p, t.id]))}
                            />
                            <span className="min-w-0 flex-1 truncate font-semibold">{t.title}</span>
                            <span className="flex-none text-[12px] text-ink-2">{taskKey(t)}</span>
                          </label>
                        )
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={addPicked}
                      disabled={!picked.length}
                      className="mt-2.5 h-8 cursor-pointer rounded-lg border-0 bg-blue px-3 text-[12.5px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Add {picked.length || ''} to {x.name}
                    </button>
                  </>
                ) : (
                  <div className="text-[13px] text-muted">No backlog tasks in this epic.</div>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-col gap-1.5">
              {ts.map(t => {
                const st = statusOf(ws.statuses, t.status)
                const overdue = !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'
                return (
                  <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => openTask(t)}
                    onKeyDown={onActivate(() => openTask(t))}
                    className="flex cursor-pointer items-center gap-2.5 rounded-[10px] bg-canvas px-3 py-[9px] shadow-[inset_0_0_0_1.5px_#E4EAF0] hover:shadow-[inset_0_0_0_1.5px_#4870E8]"
                  >
                    <span className="size-2 flex-none rounded-full" style={{ background: st.c }} />
                    <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{t.title}</span>
                    <span className="flex-none text-[12px]" style={{ fontWeight: overdue ? 800 : 600, color: overdue ? '#C0392B' : '#3B4A5E' }}>
                      {short(t.due)}
                    </span>
                  </div>
                )
              })}
              {!ts.length && <div className="text-[13.5px] text-muted">No tasks in this sprint yet.</div>}
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
