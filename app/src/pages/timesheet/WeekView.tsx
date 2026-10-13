import { compareTaskIds } from '../../domain/tasks'
import { useMemo, useState } from 'react'
import { useSend } from '../../api/queries'
import { taskLabel, type ProjectOption } from '../../api/timesheet/projects'
import { addDays, fmt, TODAY } from '../../lib/dates'
import { entryHours, fmtHours, inRange, idleHours, isWeekend, TARGET_DAY, weekdayIndex, WEEKDAY, weekDays, weekLabel, weekStart } from '../../api/timesheet/week'
import { ETYPE_COLOURS } from './types'
import { LogForm } from './LogForm'
import { submissionOf, totalsOf, ui, projectNameOf, type TimeCtx } from './model'
import { Icon, PATHS } from '../../components/ui'
import type { TimeEntry } from '../../api/types'

/** Week view: week switcher, KPIs, day strip, the day's entries and log form, the week overview and the daily chart. */
export function WeekView({ ctx, projects, week, setWeek }: { ctx: TimeCtx; projects: ProjectOption[]; week: string; setWeek: (w: string) => void }) {
  const send = useSend()
  const [day, setDay] = useState(() => (inRange(TODAY, { from: week, to: addDays(week, 6) }) ? TODAY : week))
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const days = weekDays(week)
  const weekEntries = useMemo(
    () => ctx.mine.filter(e => inRange(e.date, { from: week, to: addDays(week, 6) })),
    [ctx.mine, week],
  )
  const sub = submissionOf(ctx, week)
  const locked = !!sub
  const dayTotals = days.map(d => {
    const t = totalsOf(weekEntries.filter(e => e.date === d))
    return { iso: d, hours: t.total, bill: t.bill, non: t.non }
  })
  const week_ = totalsOf(weekEntries)
  const loggedDays = dayTotals.filter(d => d.hours > 0).length
  const idle = idleHours(dayTotals, TODAY)
  const isCurrent = week === weekStart(TODAY)

  const dayEntries = ctx.mine.filter(e => e.date === day).sort((a, b) => compareTaskIds(a.id, b.id))
  const dayTotal = totalsOf(dayEntries).total

  const move = (weeks: number) => {
    const next = addDays(week, weeks * 7)
    setWeek(next)
    setDay(addDays(day, weeks * 7))
    setConfirmId(null)
  }
  const goThisWeek = () => {
    setWeek(weekStart(TODAY))
    setDay(TODAY)
  }

  const submit = () =>
    send({ type: 'week.submit', submission: { userId: ctx.me.id, week, when: `${fmt(TODAY)}, ${new Date().toTimeString().slice(0, 5)}` } })
  const reopen = () => send({ type: 'week.reopen', userId: ctx.me.id, week })

  const kpis = [
    { label: 'This week', value: fmtHours(week_.total), sub: `Average ${fmtHours(loggedDays ? week_.total / loggedDays : 0)} a day`, tone: 'blue' },
    { label: 'Billable', value: fmtHours(week_.bill), sub: week_.total ? `${Math.round((week_.bill / week_.total) * 100)}% of logged time` : 'Nothing logged', tone: 'green' },
    { label: 'Non-billable', value: fmtHours(week_.non), sub: week_.total ? `${Math.round((week_.non / week_.total) * 100)}% of logged time` : 'Nothing logged', tone: 'amber' },
    ctx.freelancer
      ? { label: 'Days logged', value: `${loggedDays} of 7`, sub: 'Weekdays have no daily target here', tone: 'rust' }
      : { label: 'Idle', value: fmtHours(idle), sub: `${TARGET_DAY}h a weekday, up to today`, tone: 'rust' },
  ]
  const tone: Record<string, [string, string, string]> = {
    blue: ['#EEF3FB', '#DCE5FA', '#1F3FAF'],
    green: ['#EEF7F3', '#D6E9E2', '#195040'],
    amber: ['#FDF8EC', '#FBEDC2', '#7A5C0E'],
    rust: ['#FBF3EF', '#F6DDD0', '#7A3818'],
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Week switcher and submit state */}
      <div className="flex flex-wrap items-center gap-2.5">
        <button type="button" aria-label="Previous week" onClick={() => move(-1)} className={`${ui.ghost} grid size-9 place-items-center p-0`}>
          <Icon d={PATHS.back} size={14} sw={2.4} />
        </button>
        <div className="min-w-[210px] text-center text-[15px] font-bold tnum" aria-live="polite">
          {weekLabel(week)}
        </div>
        <button type="button" aria-label="Next week" onClick={() => move(1)} className={`${ui.ghost} grid size-9 place-items-center p-0`}>
          <Icon d={PATHS.next} size={14} sw={2.4} />
        </button>
        {!isCurrent && (
          <button type="button" onClick={goThisWeek} className="cursor-pointer border-0 bg-transparent text-[13px] font-semibold text-blue-ink underline">
            This week
          </button>
        )}
        <div className="ml-auto flex items-center gap-2.5">
          {locked ? (
            <>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-green-soft px-2.5 py-1 text-[12.5px] font-semibold text-green-ink">
                <Icon d={PATHS.lock} size={12} sw={2.4} /> Submitted {sub.when}
              </span>
              <button type="button" onClick={reopen} className={ui.ghost}>
                Reopen week
              </button>
            </>
          ) : (
            <>
              <span className="text-[12.5px] text-ink-2">{week_.total ? 'Open' : 'Nothing logged yet'}</span>
              <button type="button" onClick={submit} disabled={!week_.total} className={ui.primary}>
                Submit week
              </button>
            </>
          )}
        </div>
      </div>
      {locked && (
        <div className="rounded-[12px] border-[1.5px] border-line-2 bg-canvas px-4 py-2.5 text-[13px] text-ink-2">
          This week is locked. Entries cannot be added, changed or deleted until you reopen it.
        </div>
      )}

      {/* KPIs */}
      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(min(200px,100%),1fr))' }}>
        {kpis.map(k => (
          <div key={k.label} className="rounded-2xl border px-[18px] py-4" style={{ background: tone[k.tone][0], borderColor: tone[k.tone][1] }}>
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.08em]" style={{ color: tone[k.tone][2] }}>
              {k.label}
            </div>
            <div className="tnum mt-1.5 text-[28px] font-semibold leading-[1.05] tracking-[-0.01em] text-ink">{k.value}</div>
            <div className="mt-1 text-[12px] text-ink-2">{k.sub}</div>
          </div>
        ))}
      </div>

      {/* Day strip */}
      <div className="grid grid-cols-7 gap-2" role="tablist" aria-label="Days of the week">
        {dayTotals.map((d, i) => {
          const on = d.iso === day
          const isToday = d.iso === TODAY
          return (
            <button
              key={d.iso}
              type="button"
              role="tab"
              aria-selected={on}
              aria-label={`${WEEKDAY[i]} ${fmt(d.iso)}`}
              onClick={() => {
                setDay(d.iso)
                setConfirmId(null)
              }}
              className={`flex cursor-pointer flex-col items-center gap-0.5 rounded-[12px] border-[1.5px] px-1 py-2 text-center ${
                on ? 'border-blue bg-sky' : 'border-line-2 bg-white hover:bg-canvas'
              } ${isWeekend(d.iso) ? 'text-slate' : 'text-ink'}`}
            >
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em]">{WEEKDAY[i]}</span>
              <span className="tnum text-[18px] font-bold leading-none">{d.iso.slice(8)}</span>
              <span className="tnum mt-0.5 text-[11.5px] text-ink-2">{d.hours ? fmtHours(d.hours) : '–'}</span>
              {isToday && <span className="mt-0.5 rounded-full bg-blue px-1.5 text-[10px] font-bold uppercase tracking-[0.06em] text-white">Today</span>}
            </button>
          )
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        {/* Day and form */}
        <section className="flex flex-col gap-3.5 rounded-2xl border-[1.5px] border-line-2 bg-white p-4">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-[16px] font-bold">{fmt(day)}</h2>
            <span className="tnum text-[13px] text-ink-2">{dayTotal ? `${fmtHours(dayTotal)} logged` : 'Nothing logged'}</span>
          </div>
          {dayEntries.length === 0 ? (
            <p className="text-[13.5px] text-ink-2">Nothing logged for this day yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line-3 border-y border-line-3">
              {dayEntries.map(e => (
                <EntryRow
                  key={e.id}
                  e={e}
                  ctx={ctx}
                  locked={locked}
                  confirming={confirmId === e.id}
                  onAsk={() => setConfirmId(e.id)}
                  onCancel={() => setConfirmId(null)}
                  onDelete={() => {
                    send({ type: 'time.remove', id: e.id })
                    setConfirmId(null)
                  }}
                />
              ))}
            </ul>
          )}
          <h3 className="mt-1 text-[14px] font-bold">Log time for {WEEKDAY[weekdayIndex(day)]} {fmt(day)}</h3>
          <LogForm ctx={ctx} day={day} projects={projects} locked={locked} />
        </section>

        <div className="flex flex-col gap-4">
          <WeekOverview ctx={ctx} entries={weekEntries} />
          <DailyChart days={dayTotals} />
        </div>
      </div>
    </div>
  )
}

function EntryRow({
  e,
  ctx,
  locked,
  confirming,
  onAsk,
  onCancel,
  onDelete,
}: {
  e: TimeEntry
  ctx: TimeCtx
  locked: boolean
  confirming: boolean
  onAsk: () => void
  onCancel: () => void
  onDelete: () => void
}) {
  const ty = ETYPE_COLOURS[e.type] || ETYPE_COLOURS.General
  const project = projectNameOf(e, ctx)
  return (
    <li className="flex flex-col gap-1.5 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full py-[2px] pl-2 pr-2.5 text-[11.5px] font-semibold" style={{ background: ty[1], color: ty[0] }}>
          <span className="size-1.5 rounded-full" style={{ background: ty[2] }} />
          {e.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold">{taskLabel(e, ctx.tasks)}</span>
        <span className="tnum text-[13px] font-semibold">{fmtHours(entryHours(e))}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 text-[12.5px] text-ink-2">
        <span className="truncate">{project}</span>
        <span className="tnum">
          {e.bill > 0 && <span className="text-green">Billable {fmtHours(e.bill)}</span>}
          {e.bill > 0 && e.non > 0 && ' · '}
          {e.non > 0 && <span className="text-amber">Non-billable {fmtHours(e.non)}</span>}
        </span>
        {e.notes && <span className="min-w-0 truncate">{e.notes.split('\n')[0]}</span>}
        {!locked &&
          (confirming ? (
            <span className="ml-auto flex items-center gap-2">
              <span>Delete this entry?</span>
              <button type="button" onClick={onDelete} className="cursor-pointer rounded-md border border-rust-line bg-rust-soft px-2 py-0.5 font-semibold text-rust">
                Delete
              </button>
              <button type="button" onClick={onCancel} className="cursor-pointer border-0 bg-transparent font-semibold text-ink-2 underline">
                Keep
              </button>
            </span>
          ) : (
            <button type="button" onClick={onAsk} className="ml-auto cursor-pointer border-0 bg-transparent font-semibold text-rust">
              Delete
            </button>
          ))}
      </div>
    </li>
  )
}

/** Hours per project and task for the week, billable and non-billable. */
function WeekOverview({ ctx, entries }: { ctx: TimeCtx; entries: TimeEntry[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { label: string; bill: number; non: number }>()
    for (const e of entries) {
      const label = `${projectNameOf(e, ctx)} · ${taskLabel(e, ctx.tasks)}`
      const r = map.get(label) ?? { label, bill: 0, non: 0 }
      r.bill += e.bill || 0
      r.non += e.non || 0
      map.set(label, r)
    }
    return [...map.values()].sort((a, b) => b.bill + b.non - (a.bill + a.non))
  }, [entries, ctx])
  const max = Math.max(0, ...rows.map(r => r.bill + r.non))
  return (
    <section className="rounded-2xl border-[1.5px] border-line-2 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold">Week overview</h2>
        <span className="text-[12px] text-ink-2">
          <span className="text-green">■</span> Billable <span className="ml-2 text-amber">■</span> Non-billable
        </span>
      </div>
      {!rows.length ? (
        <p className="text-[13.5px] text-ink-2">No time logged this week.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map(r => {
            const total = r.bill + r.non
            return (
              <li key={r.label} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3 text-[12.5px]">
                  <span className="min-w-0 truncate text-ink-2">{r.label}</span>
                  <span className="tnum shrink-0 font-semibold">{fmtHours(total)}</span>
                </div>
                <div className="flex h-2 overflow-hidden rounded-full bg-canvas" aria-label={`${r.label}: ${fmtHours(total)}`}>
                  <span className="h-full bg-green" style={{ width: `${max ? (r.bill / max) * 100 : 0}%` }} />
                  <span className="h-full bg-amber" style={{ width: `${max ? (r.non / max) * 100 : 0}%` }} />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** One column per day. Weekdays show the 8h target as a line; weekends have none. */
function DailyChart({ days }: { days: { iso: string; hours: number; bill: number; non: number }[] }) {
  const H = 130
  const scale = Math.max(TARGET_DAY + 2, ...days.map(d => d.hours))
  return (
    <section className="rounded-2xl border-[1.5px] border-line-2 bg-white p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="text-[15px] font-bold">Daily total</h2>
        <span className="text-[12px] text-ink-2">Dashed line: {TARGET_DAY}h a weekday</span>
      </div>
      <div className="grid grid-cols-7 gap-2">
        {days.map((d, i) => {
          const barH = (d.hours / scale) * H
          const target = isWeekend(d.iso) ? null : (TARGET_DAY / scale) * H
          return (
            <div key={d.iso} className="flex flex-col items-center gap-1.5">
              <span className="tnum text-[11.5px] font-semibold text-ink-2">{d.hours ? fmtHours(d.hours) : ''}</span>
              <div className="relative flex w-full items-end justify-center rounded-[8px] bg-canvas" style={{ height: H }} aria-label={`${WEEKDAY[i]} ${fmtHours(d.hours)}`}>
                <div className="flex w-[70%] flex-col-reverse overflow-hidden rounded-t-[6px]" style={{ height: barH }}>
                  <span className="bg-green" style={{ height: d.hours ? `${(d.bill / d.hours) * 100}%` : 0 }} />
                  <span className="bg-amber" style={{ height: d.hours ? `${(d.non / d.hours) * 100}%` : 0 }} />
                </div>
                {target !== null && (
                  <span className="absolute inset-x-1 border-t-[1.5px] border-dashed border-ink-2/60" style={{ bottom: target }} />
                )}
              </div>
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-2">{WEEKDAY[i]}</span>
              {target === null && <span className="text-[10.5px] text-slate">No target</span>}
            </div>
          )
        })}
      </div>
    </section>
  )
}
