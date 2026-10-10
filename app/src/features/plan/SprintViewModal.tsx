import { useSend, useTasks, useWorkspace } from '../../api/queries'
import { CloseButton } from '../../components/ui'
import { diff, range, short, TODAY, weeks } from '../../lib/dates'
import { person, SPRINT_STATE } from '../../lib/theme'
import { useOverlay } from '../../state/ui'
import { statusOf } from '../../domain/tasks'
import { useOpenTask } from '../useOpenTask'
import { useEscape } from '../useEscape'

const C = 2 * Math.PI * 50

/** Sprint overview: goal, why it matters, goals checklist and tasks. */
export function SprintViewModal({ id }: { id: string }) {
  const ws = useWorkspace().data!
  const tasks = (useTasks().data ?? []).filter(t => !t.parent)
  const send = useSend()
  const overlay = useOverlay()
  const openTask = useOpenTask()
  const close = () => overlay.close('sprint')
  useEscape(close)

  const x = ws.sprints.find(y => y.id === id)
  if (!x) return null
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
                  return (
                    <div
                      key={i}
                      onClick={() => send({ type: 'sprint.update', id: x.id, patch: { goalsDone: { ...gd, [i]: !on } } })}
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
            </div>
            <div className="mt-3 flex flex-col gap-1.5">
              {ts.map(t => {
                const st = statusOf(ws.statuses, t.status)
                const overdue = !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'
                return (
                  <div
                    key={t.id}
                    onClick={() => openTask(t)}
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
