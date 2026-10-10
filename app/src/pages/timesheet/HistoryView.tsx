import { useEffect, useMemo, useRef, useState } from 'react'
import { fmt, TODAY } from '../../lib/dates'
import { download, toCsv, toPdf, pdfLines, toXlsx } from '../../api/timesheet/export'
import { entryProject, findProject, taskLabel, projectOptions, type ProjectOption } from '../../api/timesheet/projects'
import { entryHours, fmtHours, inRange, PERIOD_LABEL, periodRange, rangeText, WEEKDAY, type Period } from '../../api/timesheet/week'
import type { TimeEntry } from '../../api/types'
import { ETYPE_COLOURS } from './types'
import { projectNameOf, toExportRow, totalsOf, ui, type TimeCtx } from './model'
import { Icon, PATHS } from '../../components/ui'

type GroupBy = 'day' | 'project' | 'task'

const GROUP_LABEL: Record<GroupBy, string> = { day: 'Day', project: 'Project', task: 'Task' }

/** History: period, project and group-by filters, grouped entries with totals, and the download menu. */
export function HistoryView({ ctx }: { ctx: TimeCtx }) {
  const [period, setPeriod] = useState<Period>('all')
  const [custom, setCustom] = useState({ from: '', to: '' })
  const [projectF, setProjectF] = useState('')
  const [groupBy, setGroupBy] = useState<GroupBy>('day')

  // Projects the filter can pick: the company's projects (when filtered) plus any project in the entries.
  const choices = useMemo<ProjectOption[]>(() => {
    const byValue = new Map<string, ProjectOption>()
    for (const p of projectOptions(ctx.companies, ctx.internal, ctx.companyId)) byValue.set(p.value, p)
    for (const e of ctx.mine) {
      const v = entryProject(e, ctx.tasks, ctx.companies)
      if (!v || byValue.has(v)) continue
      const p = findProject(v, ctx.companies, ctx.internal)
      if (p && (!ctx.companyId || p.companyId === ctx.companyId)) byValue.set(v, p)
    }
    return [...byValue.values()].sort((a, b) => a.label.localeCompare(b.label))
  }, [ctx])

  const range = periodRange(period, TODAY, custom)
  const rows = useMemo(
    () =>
      ctx.mine
        .filter(e => inRange(e.date, range))
        .filter(e => !projectF || entryProject(e, ctx.tasks, ctx.companies) === projectF)
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)),
    [ctx.mine, ctx.tasks, ctx.companies, period, custom.from, custom.to, projectF],
  )
  const totals = totalsOf(rows)
  const filtered = period !== 'all' || !!projectF

  const groups = useMemo(() => groupRows(rows, groupBy, ctx), [rows, groupBy, ctx])

  const resetAll = () => {
    setPeriod('all')
    setProjectF('')
    setCustom({ from: '', to: '' })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3 rounded-2xl border-[1.5px] border-line-2 bg-white p-4">
        <label className={`${ui.label} w-[170px]`}>
          Period
          <select value={period} onChange={e => setPeriod(e.target.value as Period)} className={ui.select} aria-label="Period">
            {(['week', 'lastMonth', 'month', 'all', 'custom'] as Period[]).map(p => (
              <option key={p} value={p}>
                {PERIOD_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        {period === 'custom' && (
          <>
            <label className={`${ui.label} w-[160px]`}>
              From
              <input type="date" value={custom.from} onChange={e => setCustom({ ...custom, from: e.target.value })} className={`${ui.control} tnum`} aria-label="From" />
            </label>
            <label className={`${ui.label} w-[160px]`}>
              To
              <input type="date" value={custom.to} onChange={e => setCustom({ ...custom, to: e.target.value })} className={`${ui.control} tnum`} aria-label="To" />
            </label>
          </>
        )}
        <label className={`${ui.label} min-w-[220px] flex-1`}>
          Project
          <select value={projectF} onChange={e => setProjectF(e.target.value)} className={ui.select} aria-label="Project filter">
            <option value="">All projects</option>
            {choices.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${ui.label} w-[150px]`}>
          Group by
          <select value={groupBy} onChange={e => setGroupBy(e.target.value as GroupBy)} className={ui.select} aria-label="Group by">
            {(Object.keys(GROUP_LABEL) as GroupBy[]).map(g => (
              <option key={g} value={g}>
                {GROUP_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
        <DownloadMenu ctx={ctx} rows={rows} range={range} disabled={!rows.length} />
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[13.5px]">
        <span className="font-bold">Timesheet history</span>
        <span className="text-ink-2">{rangeText(range, ctx.mine)}</span>
        <span className="tnum text-ink-2">{rows.length} entries</span>
        <span className="tnum ml-auto">
          Total <b>{fmtHours(totals.total)}</b> <span className="text-green">Billable {fmtHours(totals.bill)}</span>{' '}
          <span className="text-amber">Non-billable {fmtHours(totals.non)}</span>
        </span>
        {filtered && (
          <button type="button" onClick={resetAll} className="cursor-pointer border-0 bg-transparent font-semibold text-blue-ink underline">
            Show all my time
          </button>
        )}
      </div>

      {!rows.length ? (
        <div className="rounded-2xl border-[1.5px] border-line-2 bg-white p-8 text-center">
          <p className="text-[14px] text-ink-2">No entries match these filters.</p>
          {filtered && (
            <button type="button" onClick={resetAll} className={`${ui.ghost} mt-3`}>
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groups.map(g => (
            <section key={g.key} className="overflow-hidden rounded-2xl border-[1.5px] border-line-2 bg-white">
              <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1 bg-sky px-4 py-2.5">
                <h3 className="min-w-0 flex-1 truncate text-[14px] font-bold">{g.label}</h3>
                <span className="tnum text-[13px]">
                  <b>{fmtHours(g.totals.total)}</b>
                </span>
                <span className="tnum text-[12.5px] text-green">Billable {fmtHours(g.totals.bill)}</span>
                <span className="tnum text-[12.5px] text-amber">Non-billable {fmtHours(g.totals.non)}</span>
              </header>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-2">
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-2 py-2 font-semibold">Project</th>
                      <th className="px-2 py-2 font-semibold">Ticket or task</th>
                      <th className="px-2 py-2 font-semibold">Type</th>
                      <th className="px-2 py-2 text-right font-semibold">Billable</th>
                      <th className="px-2 py-2 text-right font-semibold">Non-billable</th>
                      <th className="px-4 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {g.rows.map(e => {
                      const ty = ETYPE_COLOURS[e.type] || ETYPE_COLOURS.General
                      return (
                        <tr key={e.id} className="border-t border-line-3 align-top">
                          <td className="tnum whitespace-nowrap px-4 py-2 text-ink-2">{fmt(e.date)}</td>
                          <td className="max-w-[220px] px-2 py-2 text-ink-2">
                            <span className="line-clamp-2">{projectNameOf(e, ctx)}</span>
                          </td>
                          <td className="px-2 py-2">
                            <span className="font-semibold">{taskLabel(e, ctx.tasks)}</span>
                            {e.notes && <div className="mt-0.5 max-w-[360px] truncate text-[12.5px] text-ink-2">{e.notes.split('\n')[0]}</div>}
                          </td>
                          <td className="px-2 py-2">
                            <span className="inline-flex items-center gap-1.5 rounded-full py-[2px] pl-2 pr-2.5 text-[12px] font-semibold" style={{ background: ty[1], color: ty[0] }}>
                              <span className="size-1.5 rounded-full" style={{ background: ty[2] }} />
                              {e.type}
                            </span>
                          </td>
                          <td className="tnum px-2 py-2 text-right text-green">{e.bill ? fmtHours(e.bill) : '–'}</td>
                          <td className="tnum px-2 py-2 text-right text-amber">{e.non ? fmtHours(e.non) : '–'}</td>
                          <td className="tnum px-4 py-2 text-right font-semibold">{fmtHours(entryHours(e))}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

interface Group {
  key: string
  label: string
  rows: TimeEntry[]
  totals: { bill: number; non: number; total: number }
}

/** Splits the rows into groups. Day groups run newest first; project and task groups run by hours. */
const groupRows = (rows: TimeEntry[], by: GroupBy, ctx: TimeCtx): Group[] => {
  const keyOf = (e: TimeEntry): { key: string; label: string } => {
    if (by === 'day') return { key: e.date, label: `${WEEKDAY[dayIndex(e.date)]} ${fmt(e.date)}` }
    if (by === 'project') return { key: projectNameOf(e, ctx), label: projectNameOf(e, ctx) }
    return { key: taskLabel(e, ctx.tasks), label: taskLabel(e, ctx.tasks) }
  }
  const map = new Map<string, Group>()
  for (const e of rows) {
    const k = keyOf(e)
    const g = map.get(k.key) ?? { key: k.key, label: k.label, rows: [], totals: { bill: 0, non: 0, total: 0 } }
    g.rows.push(e)
    map.set(k.key, g)
  }
  const list = [...map.values()].map(g => ({ ...g, totals: totalsOf(g.rows) }))
  if (by === 'day') return list.sort((a, b) => (a.key < b.key ? 1 : -1))
  return list.sort((a, b) => b.totals.total - a.totals.total || a.label.localeCompare(b.label))
}

/** 0 = Monday … 6 = Sunday, for a 'YYYY-MM-DD' string. */
const dayIndex = (iso: string) => (new Date(iso + 'T12:00:00Z').getUTCDay() + 6) % 7

/** Excel, CSV and PDF downloads of the rows the history shows. */
function DownloadMenu({
  ctx,
  rows,
  range,
  disabled,
}: {
  ctx: TimeCtx
  rows: TimeEntry[]
  range: { from: string; to: string } | null
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const base = range ? `my-timesheet-${range.from}-to-${range.to}` : 'my-timesheet-all-time'
  const exportRows = rows.map(e => toExportRow(e, ctx))
  const who = ctx.me.name
  const period = rangeText(range, ctx.mine)

  const items = [
    {
      label: 'Excel (.xlsx)',
      hint: 'Entries and totals in one sheet',
      run: () => download(base + '.xlsx', toXlsx(exportRows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
    },
    {
      label: 'CSV',
      hint: 'One row per entry',
      run: () => download(base + '.csv', new TextEncoder().encode(toCsv(exportRows)), 'text/csv;charset=utf-8'),
    },
    {
      label: 'PDF report',
      hint: 'Totals by project and every entry',
      run: () => download(base + '.pdf', toPdf(pdfLines(exportRows, period, who)), 'application/pdf'),
    },
  ]

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${ui.ghost} flex items-center gap-2`}
      >
        Download
        <Icon d={PATHS.chevron} size={12} sw={2.6} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+6px)] z-20 w-[240px] rounded-[12px] border-[1.5px] border-line-2 bg-white p-1.5 shadow-[0_8px_24px_rgba(27,45,69,0.14)]">
          {items.map(it => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={() => {
                it.run()
                setOpen(false)
              }}
              className="flex w-full cursor-pointer flex-col items-start rounded-[9px] border-0 bg-transparent px-3 py-2 text-left hover:bg-canvas"
            >
              <span className="text-[13.5px] font-semibold text-ink">{it.label}</span>
              <span className="text-[12px] text-ink-2">{it.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
