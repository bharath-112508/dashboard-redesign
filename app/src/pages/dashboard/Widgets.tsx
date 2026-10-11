import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { ICON_PATH, TASK_TYPE_ICON, TONE, type BarDay, type ListRow, type ProgRow, type StatusRow, type TixRow, type Tone, type Widget } from '../../api/dashboard/model'
import { hm } from '../../api/dashboard/time'

/** Card shell shared by every widget: icon, title, subtitle and the link to the page. */
export function WidgetCard({ widget, children }: { widget: Widget; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`w-${widget.id}`}
      className="min-w-0 overflow-hidden rounded-2xl bg-white shadow-[0_0_0_1.5px_#D6DEE8]"
    >
      <div className="flex items-center gap-2 border-b-[1.5px] border-line-3 px-[18px] py-[13px]">
        <span className="grid size-[26px] flex-none place-items-center rounded-[7px] bg-sky-2 text-blue-ink" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d={ICON_PATH[widget.icon]} />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 id={`w-${widget.id}`} className="text-[15px] font-bold text-ink">
            {widget.title}
          </h2>
          <div className="truncate text-[12px] text-muted">{widget.sub}</div>
        </div>
        <Link to={widget.href} className="ml-auto flex-none text-[12.5px] font-bold text-blue-ink hover:underline">
          {widget.link} ›
        </Link>
      </div>
      {children}
    </section>
  )
}

function Empty({ text }: { text: string }) {
  return <div className="px-[18px] py-6 text-[13px] text-muted">{text}</div>
}

export function ListWidget({ widget, rows, empty }: { widget: Widget; rows: ListRow[]; empty: string }) {
  return (
    <WidgetCard widget={widget}>
      {rows.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul>
          {rows.map(r => (
            <li key={r.id} className="border-t-[1.5px] border-sky">
              <Link to={r.href} className="flex items-center gap-2.5 px-[18px] py-2.5 text-ink no-underline hover:bg-canvas">
                <span
                  className="inline-flex h-[22px] flex-none items-center rounded-md px-[7px] text-[11px] font-bold whitespace-nowrap tabular-nums"
                  style={{ background: TONE[r.tone].bg, color: TONE[r.tone].ink }}
                >
                  {r.tag}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold text-ink">{r.title}</div>
                  <div className="truncate text-[12px] text-muted">{r.meta}</div>
                </div>
                {r.right && (
                  <span
                    className="flex-none text-[12.5px] font-bold whitespace-nowrap"
                    style={{ color: r.rightTone === 'red' ? '#C0392B' : r.rightTone === 'amber' ? '#7A5C0E' : '#1B2D45' }}
                  >
                    {r.right}
                  </span>
                )}
                <span className="flex-none text-[14px] font-bold text-faint" aria-hidden="true">
                  ›
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  )
}

/** Tickets with their type icon, key, project and epic, a "From client" tag, the due date and a status pill. */
export function TixWidget({ widget, rows, empty }: { widget: Widget; rows: TixRow[]; empty: string }) {
  return (
    <WidgetCard widget={widget}>
      {rows.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul>
          {rows.map(r => {
            const ty = TASK_TYPE_ICON[r.type]
            return (
              <li key={r.id} className="border-t-[1.5px] border-sky">
                <Link to={r.href} className="grid grid-cols-[30px_minmax(0,1fr)_auto] items-center gap-3 px-[18px] py-3 text-ink no-underline hover:bg-canvas">
                  <span title={r.type} className="grid size-[30px] place-items-center rounded-lg" style={{ background: ty.bg, color: ty.ink }}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d={ty.path} />
                    </svg>
                    <span className="sr-only">{r.type}</span>
                  </span>
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="truncate text-[14px] font-[650] leading-[1.25]">{r.title}</div>
                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-[12px] text-muted">
                      <span className="flex-none rounded-[5px] bg-sky-2 px-1.5 py-px text-[11px] font-bold text-blue-ink tabular-nums">{r.key}</span>
                      <span className="size-1.5 flex-none rounded-[2px] bg-blue" aria-hidden="true" />
                      <span className="min-w-0 truncate">
                        {r.project ? (
                          <>
                            <b className="font-[650] text-ink">{r.project}</b> · {r.epic}
                          </>
                        ) : (
                          r.epic
                        )}
                      </span>
                      {r.client && (
                        <span className="flex-none rounded-[5px] bg-[#F6DDD0] px-1.5 py-px text-[11px] font-bold text-[#7A3818]">From client</span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-[5px]">
                    {r.due && (
                      <span className="whitespace-nowrap text-[12.5px] font-bold" style={{ color: r.late ? '#C0392B' : '#1B2D45' }}>
                        {r.due}
                      </span>
                    )}
                    <span
                      className="inline-flex h-5 items-center gap-[5px] whitespace-nowrap rounded-full px-2 text-[11.5px] font-bold"
                      style={{ background: r.statusTone.bg, color: r.statusTone.ink }}
                    >
                      <span className="size-1.5 rounded-full" style={{ background: r.statusTone.dot }} aria-hidden="true" />
                      {r.status}
                    </span>
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </WidgetCard>
  )
}

export function ProgWidget({ widget, rows, empty }: { widget: Widget; rows: ProgRow[]; empty: string }) {
  return (
    <WidgetCard widget={widget}>
      {rows.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul className="px-[18px] pb-2 pt-1">
          {rows.map(r => (
            <li key={r.id} className="border-b-[1.5px] border-sky last:border-0">
              <Link to={r.href} className="block py-2.5 text-ink no-underline hover:text-blue-ink">
                <div className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{r.title}</span>
                  <span className="flex-none text-[13px] font-extrabold tabular-nums" style={{ color: r.valueColor }}>
                    {r.value}
                  </span>
                </div>
                <div className="mt-1.5 h-2 overflow-hidden rounded bg-sky" role="presentation">
                  <span className="block h-full rounded" style={{ width: `${Math.max(0, Math.min(100, r.pct))}%`, background: r.barColor }} />
                </div>
                <div className="mt-1 truncate text-[12px]" style={{ color: r.metaColor }}>
                  {r.meta}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </WidgetCard>
  )
}

/** Stacked Mon–Sun bars: billable, non-billable and idle, scaled to the busiest day (at least a full day for a person). */
export function BarsWidget({ widget, days, foot, idle }: { widget: Widget; days: BarDay[]; foot: string; idle: boolean }) {
  const total = (d: BarDay) => d.billable + d.non + (idle ? d.idle : 0)
  const scale = Math.max(8, ...days.map(total))
  return (
    <WidgetCard widget={widget}>
      <div className="px-[18px] pb-3 pt-4">
        <div className="flex h-[124px] items-end gap-2" role="img" aria-label={`${widget.title}: ${foot}`}>
          {days.map(d => {
            const h = (v: number) => `${(v / scale) * 100}%`
            return (
              <div key={d.date} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1.5">
                <div
                  className="flex w-full max-w-[34px] flex-col-reverse overflow-hidden rounded-md"
                  style={{ height: `${Math.max(2, (total(d) / scale) * 100)}%` }}
                  title={`Billable ${hm(d.billable)} · Non-billable ${hm(d.non)}${idle ? ` · Idle ${hm(d.idle)}` : ''}`}
                >
                  {d.billable > 0 && <span style={{ height: h(d.billable), background: '#4870E8' }} />}
                  {d.non > 0 && <span style={{ height: h(d.non), background: '#E2B23C' }} />}
                  {idle && d.idle > 0 && <span style={{ height: h(d.idle), background: '#D6DEE8' }} />}
                </div>
                <span className="text-[11px] font-semibold text-muted">{d.label}</span>
                <span className="text-[10.5px] tabular-nums text-muted">{d.billable + d.non ? hm(d.billable + d.non) : '–'}</span>
              </div>
            )
          })}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t-[1.5px] border-sky pt-2.5 text-[12px] text-muted">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-blue" />
            Billable
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-[#E2B23C]" />
            Non-billable
          </span>
          {idle && (
            <span className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-sm bg-line-2" />
              Idle
            </span>
          )}
          <span className="ml-auto font-bold text-ink">{foot}</span>
        </div>
      </div>
    </WidgetCard>
  )
}

const DOT_TONE: Record<Tone, string> = { blue: '#4870E8', red: '#C0392B', amber: '#E2B23C', grey: '#A9B6C5', green: '#3F9079', violet: '#7C5CD6' }

/** How many DevOps projects the Dashboard lists before pointing to the full board. */
const STATUS_LIMIT = 6

export function StatusWidget({ widget, rows, empty }: { widget: Widget; rows: StatusRow[]; empty: string }) {
  const shown = rows.slice(0, STATUS_LIMIT)
  return (
    <WidgetCard widget={widget}>
      {rows.length === 0 ? (
        <Empty text={empty} />
      ) : (
        <ul>
          {shown.map(r => (
            <li key={r.id} className="border-t-[1.5px] border-sky">
              <Link to={r.href} className="flex items-center gap-3 px-[18px] py-2.5 text-ink no-underline hover:bg-canvas">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.5px] font-semibold">{r.title}</div>
                  <span
                    className="mt-1 inline-flex h-[20px] max-w-full items-center truncate rounded-md px-2 text-[11px] font-bold"
                    style={{ background: TONE[r.tone].bg, color: TONE[r.tone].ink }}
                  >
                    {r.status}
                  </span>
                </div>
                <div className="flex flex-none gap-1" aria-label={`${r.steps} of 4 steps`}>
                  {[0, 1, 2, 3].map(i => (
                    <span
                      key={i}
                      className="size-2.5 rounded-full"
                      style={{ background: i < r.steps ? DOT_TONE[r.tone] : '#E4EAF0' }}
                    />
                  ))}
                </div>
              </Link>
            </li>
          ))}
          {rows.length > STATUS_LIMIT && (
            <li className="border-t-[1.5px] border-sky">
              <Link to={widget.href} className="block px-[18px] py-2.5 text-[12.5px] font-bold text-blue-ink hover:underline">
                {rows.length - STATUS_LIMIT} more on {widget.link} ›
              </Link>
            </li>
          )}
        </ul>
      )}
    </WidgetCard>
  )
}

/** Picks the renderer for a widget's body. */
export function WidgetView({ widget }: { widget: Widget }) {
  const b = widget.body
  switch (b.kind) {
    case 'list':
      return <ListWidget widget={widget} rows={b.rows} empty={b.empty} />
    case 'prog':
      return <ProgWidget widget={widget} rows={b.rows} empty={b.empty} />
    case 'bars':
      return <BarsWidget widget={widget} days={b.days} foot={b.foot} idle={b.idle} />
    case 'status':
      return <StatusWidget widget={widget} rows={b.rows} empty={b.empty} />
    case 'tix':
      return <TixWidget widget={widget} rows={b.rows} empty={b.empty} />
  }
}
