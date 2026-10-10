import { useState, type DragEvent } from 'react'
import { useSend, useTasks, useWorkspace } from '../../api/queries'
import type { Task } from '../../api/types'
import { Icon, PATHS } from '../../components/ui'
import { todayLabel } from '../../lib/dates'
import { readFiles } from '../../lib/files'
import { pal } from '../../lib/theme'
import { useUi } from '../../state/ui'
import { taskKey } from '../../domain/tasks'
import { useOpenTask } from '../../features/useOpenTask'

const KIND: Record<string, string[]> = {
  img: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'],
  doc: ['pdf', 'doc', 'docx', 'txt', 'md'],
  sheet: ['xls', 'xlsx', 'csv'],
  code: ['zip', 'json', 'js', 'html'],
}
/** [background, ink] for the file badge */
const KIND_C: Record<string, [string, string]> = {
  img: ['#E6DFFA', '#3F2E94'],
  doc: ['#FBE3DF', '#A5502C'],
  sheet: ['#D6E9E2', '#195040'],
  code: ['#E7EEFB', '#1F3FAF'],
  other: ['#EEF3FB', '#22354C'],
}
const kindOf = (n: string) => {
  const x = (n.split('.').pop() || '').toLowerCase()
  return Object.keys(KIND).find(k => KIND[k].includes(x)) || 'other'
}
const COLS = 'minmax(0,2.4fr) minmax(0,1.6fr) 110px 80px 110px 40px'

/** The "Files" tab: every attachment on every ticket, with upload by drag and drop. */
export function FilesView() {
  const ws = useWorkspace().data!
  const tasks = (useTasks().data ?? []).filter(t => !t.parent)
  const ui = useUi()
  const send = useSend()
  const openTask = useOpenTask()
  const [q, setQ] = useState('')
  const [epF, setEpF] = useState('all')
  const [kF, setKF] = useState('all')
  const [drag, setDrag] = useState(false)

  const query = q.trim().toLowerCase()
  const rows = tasks.flatMap(t =>
    t.atts.flatMap((a, i) => {
      const k = kindOf(a.name)
      if (epF !== 'all' && t.epic !== epF) return []
      if (kF !== 'all' && k !== kF) return []
      if (query && !(a.name + ' ' + t.title).toLowerCase().includes(query)) return []
      return [{ t, a, i, k }]
    }),
  )
  const targetEpic = epF === 'all' ? ui.epic : epF
  const epName = ws.epics.find(e => e.id === targetEpic)?.name ?? ''

  // New files go on the first ticket of the epic, as in the prototype.
  const add = async (list: FileList | File[] | null | undefined) => {
    const files = [...(list || [])]
    const tgt = tasks.find(t => t.epic === targetEpic)
    if (!files.length || !tgt) return
    const F = await readFiles(files)
    const ds = todayLabel()
    send({
      type: 'task.update',
      id: tgt.id,
      patch: { atts: [...tgt.atts, ...F.map(f => ({ name: f.name, size: f.size, date: ds, url: f.url }))] },
      log: 'attached ' + F.length + ' file' + (F.length > 1 ? 's' : ''),
    })
  }
  const remove = (t: Task, i: number) =>
    send({ type: 'task.update', id: t.id, patch: { atts: t.atts.filter((_, j) => j !== i) }, log: 'removed ' + t.atts[i].name })

  const select = 'h-9 cursor-pointer appearance-none rounded-[10px] border-[1.5px] border-line bg-white pl-3 pr-[30px] text-[13.5px] font-semibold text-ink outline-0'
  const chevron = <Icon d={PATHS.chevron} size={11} sw={2.8} className="pointer-events-none absolute right-[11px] top-1/2 -translate-y-1/2 text-ink-2" />

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative inline-flex items-center">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#22354C" strokeWidth="2.2" strokeLinecap="round" className="absolute left-[11px]">
            <circle cx="11" cy="11" r="7" />
            <path d={PATHS.search} />
          </svg>
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search files"
            className="h-9 w-[220px] rounded-[10px] border-[1.5px] border-line bg-white pl-8 pr-3 text-[13.5px] text-ink outline-0"
          />
        </span>
        <span className="relative inline-flex">
          <select value={epF} onChange={e => setEpF(e.target.value)} aria-label="Epic" className={select}>
            <option value="all">All epics</option>
            {ws.epics.map(e => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
          {chevron}
        </span>
        <span className="relative inline-flex">
          <select value={kF} onChange={e => setKF(e.target.value)} aria-label="File type" className={select}>
            <option value="all">All types</option>
            <option value="img">Images</option>
            <option value="doc">Documents</option>
            <option value="sheet">Spreadsheets</option>
            <option value="code">Code &amp; archives</option>
            <option value="other">Other</option>
          </select>
          {chevron}
        </span>
        <span className="ml-auto text-[13px] font-semibold text-ink-2">
          {rows.length} file{rows.length === 1 ? '' : 's'}
        </span>
        <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-[10px] bg-blue px-3.5 text-[13.5px] font-semibold text-white">
          <Icon d={PATHS.plus} size={14} sw={2.6} />
          Upload
          <input
            type="file"
            multiple
            className="hidden"
            onChange={e => {
              add(e.target.files)
              e.target.value = ''
            }}
          />
        </label>
      </div>
      <div
        onDragOver={(e: DragEvent) => {
          e.preventDefault()
          if (!drag) setDrag(true)
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e: DragEvent) => {
          e.preventDefault()
          setDrag(false)
          add(e.dataTransfer?.files)
        }}
        className="flex items-center justify-center gap-2.5 rounded-[14px] border-[1.5px] border-dashed p-4 text-[13.5px] font-semibold text-ink-2"
        style={{ borderColor: drag ? '#4870E8' : '#A9B6C5', background: drag ? '#E7EEFB' : '#FFFFFF' }}
      >
        <Icon d={PATHS.upload} size={18} sw={2.2} stroke="#4870E8" />
        {/* Two flex items, like the prototype: the gap sits before the epic name. */}
        <span>Drag and drop files here to add them to</span>
        <span>{epName}</span>
      </div>
      <div className="overflow-hidden rounded-[14px] bg-white shadow-[0_0_0_1.5px_#D6DEE8,0_1px_2px_rgba(27,45,69,0.04)]">
        <div
          className="grid gap-3 bg-sky px-4 py-2.5 text-[12px] font-bold uppercase tracking-[0.04em] text-ink-2"
          style={{ gridTemplateColumns: COLS }}
        >
          <span>Name</span>
          <span>Ticket</span>
          <span>Epic</span>
          <span>Size</span>
          <span>Added</span>
          <span />
        </div>
        {rows.map(({ t, a, i, k }) => {
          const E = ws.epics.find(e => e.id === t.epic)
          const [bg, c] = KIND_C[k]
          return (
            <div
              key={t.id + '-' + i}
              className="grid items-center gap-3 border-t-[1.5px] border-sky px-4 py-2.5 hover:bg-canvas"
              style={{ gridTemplateColumns: COLS }}
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-[34px] flex-none place-items-center rounded-lg text-[10px] font-extrabold" style={{ background: bg, color: c }}>
                  {(a.name.split('.').pop() || '').slice(0, 4).toUpperCase()}
                </span>
                <span className="truncate text-[14px] font-semibold text-ink">{a.name}</span>
              </span>
              <span onClick={() => openTask(t)} className="flex min-w-0 cursor-pointer items-center gap-2">
                <span className="tnum flex-none whitespace-nowrap rounded-md bg-sky-2 px-[7px] py-[3px] text-[11.5px] font-semibold text-blue-ink">{taskKey(t)}</span>
                <span className="truncate text-[13px] text-ink-2">{t.title}</span>
              </span>
              <span className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap text-[13px] text-ink">
                <span className="size-2 flex-none rounded-[2px]" style={{ background: E ? pal(E.p)[0] : '#A9B6C5' }} />
                {E?.name || ''}
              </span>
              <span className="tnum text-[13px] text-ink-2">{a.size || '—'}</span>
              <span className="whitespace-nowrap text-[13px] text-ink-2">{a.date || '—'}</span>
              <button
                type="button"
                onClick={() => remove(t, i)}
                title="Remove"
                className="grid size-[30px] cursor-pointer place-items-center rounded-lg border-0 bg-transparent p-0 text-muted hover:bg-rust-soft hover:text-rust"
              >
                <Icon d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" size={14} sw={2.2} />
              </button>
            </div>
          )
        })}
        {!rows.length && <div className="p-7 text-center text-[13.5px] text-muted">No files yet. Files attached to tickets show up here.</div>}
      </div>
    </div>
  )
}
