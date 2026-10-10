import { useWorkspace } from '../../api/queries'
import { Avatar, unassigned } from '../../components/ui'
import { diff, short, TODAY } from '../../lib/dates'
import { PRIO, TYPES } from '../../lib/theme'
import { usePerson } from '../../state/page'
import { statusOf, taskKey } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'
import { useBoardTasks } from '../clients/BoardView'

const COLS = '96px minmax(240px,1fr) 100px 150px 110px 190px 110px'

/** The "Tasks" tab: every ticket matching the filters, as a table. */
export function ListView() {
  const ws = useWorkspace().data!
  const person = usePerson()
  const list = useBoardTasks()
  const openTask = useOpenTask()

  return (
    <div className="overflow-hidden rounded-[20px] border-[1.5px] border-line-2 bg-white">
      <div className="overflow-x-auto">
        <div className="min-w-[960px]">
          <div
            className="tnum grid h-[42px] items-center gap-4 bg-sky-2 px-[22px] text-[11px] font-semibold uppercase tracking-[0.06em] text-blue-ink"
            style={{ gridTemplateColumns: COLS }}
          >
            <span>Key</span>
            <span>Title</span>
            <span>Type</span>
            <span>Status</span>
            <span>Priority</span>
            <span>Assignee</span>
            <span>Due</span>
          </div>
          {list.map(t => {
            const st = statusOf(ws.statuses, t.status)
            const ty = TYPES[t.type]
            const pr = PRIO[t.prio] || PRIO.Low
            const a = t.assignee ? { ...person(t.assignee), color: '#fff', ring: 'none' } : unassigned
            const late = !!t.due && diff(t.due, TODAY) < 0 && t.status !== 'done'
            return (
              <div
                key={t.id}
                onClick={() => openTask(t)}
                className="grid min-h-12 cursor-pointer items-center gap-4 border-t-[1.5px] border-line-2 px-[22px] py-2 hover:bg-canvas"
                style={{ gridTemplateColumns: COLS, boxShadow: `inset 3px 0 0 ${ty[0]}` }}
              >
                <span className="tnum text-[12px] text-ink-2">{taskKey(t)}</span>
                <span className="truncate text-[14px] font-semibold">{t.title}</span>
                <span className="text-[13px] font-semibold" style={{ color: ty[2] }}>
                  {t.type}
                </span>
                <span>
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full py-[3px] pl-2 pr-2.5 text-[12.5px] font-semibold"
                    style={{ background: st.soft, color: st.ink }}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: st.c }} />
                    {st.name}
                  </span>
                </span>
                <span>
                  <span className="inline-flex h-[22px] items-center rounded-full px-[9px] text-[12px] font-semibold" style={{ background: pr[1], color: pr[0] }}>
                    {t.prio}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-2 text-[13px]">
                  <Avatar i={a.i} bg={a.bg} color={a.color} ring={a.ring} size={22} radius={5} font={9.5} />
                  <span className="truncate" style={{ color: t.assignee ? '#1B2D45' : '#3B4A5E' }}>
                    {t.assignee || 'Unassigned'}
                  </span>
                </span>
                <span className="tnum text-[12px]" style={{ color: late ? '#C0392B' : '#3B4A5E' }}>
                  {short(t.due)}
                </span>
              </div>
            )
          })}
          {!list.length && (
            <div className="border-t-[1.5px] border-line-2 p-12 text-center text-[14px] text-ink-2">No tasks match these filters.</div>
          )}
        </div>
      </div>
    </div>
  )
}
