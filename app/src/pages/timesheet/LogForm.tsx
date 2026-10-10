import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend } from '../../api/queries'
import { logTime } from '../../api/timesheet'
import { ticketOptions, TEXT_TASKS, type ProjectOption } from '../../api/timesheet/projects'
import { toHours } from '../../api/timesheet/week'
import { ETYPES } from './types'
import { ui, type TimeCtx } from './model'

const WHOLE = (max: number, label: string) =>
  z.string().refine(v => v === '' || (/^\d+$/.test(v) && +v <= max), `${label} must be a whole number up to ${max}`)

const schema = z
  .object({
    project: z.string().min(1, 'Choose a project'),
    mode: z.enum(['ticket', 'text']),
    ticket: z.string(),
    textPreset: z.string(),
    textCustom: z.string(),
    hours: WHOLE(24, 'Hours'),
    minutes: WHOLE(59, 'Minutes'),
    billing: z.enum(['bill', 'non']),
    workType: z.string().min(1),
    note: z.string(),
  })
  .superRefine((f, ctx) => {
    if (f.mode === 'ticket' && !f.ticket) ctx.addIssue({ code: 'custom', path: ['ticket'], message: 'Choose a ticket' })
    if (f.mode === 'text') {
      const text = f.textPreset === 'Custom' ? f.textCustom.trim() : f.textPreset
      if (!text) ctx.addIssue({ code: 'custom', path: ['textCustom'], message: 'Write what you worked on' })
    }
    if (!(+(f.hours || 0) * 60 + +(f.minutes || 0))) ctx.addIssue({ code: 'custom', path: ['hours'], message: 'Add some hours' })
  })

type Form = z.input<typeof schema>

const defaults = (project: string): Form => ({
  project,
  mode: 'ticket',
  ticket: '',
  textPreset: 'Custom',
  textCustom: '',
  hours: '',
  minutes: '',
  billing: 'bill',
  workType: 'General',
  note: '',
})

const hhmm = () => new Date().toTimeString().slice(0, 5)

/** The "Log time" form for one day. It is disabled while the week is submitted. */
export function LogForm({
  ctx,
  day,
  projects,
  locked,
}: {
  ctx: TimeCtx
  day: string
  projects: ProjectOption[]
  locked: boolean
}) {
  const send = useSend()
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const { register, handleSubmit, reset, watch, setValue, getValues, formState } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: defaults(projects.length === 1 ? projects[0].value : ''),
  })
  const w = watch()
  const project = projects.find(p => p.value === w.project)
  const tickets = project ? ticketOptions(project.value, ctx.tasks, ctx.companies, ctx.internal) : []
  const err = formState.errors

  const onSubmit = (f: Form) => {
    const h = toHours(0, +(f.hours || 0) * 60 + +(f.minutes || 0))
    const text = f.textPreset === 'Custom' ? f.textCustom.trim() : f.textPreset
    const ticket = f.mode === 'ticket' ? tickets.find(t => String(t.id) === f.ticket) : undefined
    send(
      logTime({
        date: day,
        userId: ctx.me.id,
        user: ctx.me.name,
        type: f.workType,
        task: ticket ? ticket.id : null,
        ...(f.mode === 'text' ? { area: text } : {}),
        ...(ticket ? { epic: ticket.epic } : {}),
        project: f.project,
        notes: f.note.trim(),
        bill: f.billing === 'bill' ? h : 0,
        non: f.billing === 'non' ? h : 0,
      }),
    )
    setSavedAt(hhmm())
    reset({ ...getValues(), hours: '', minutes: '', note: '' })
  }

  const mode = w.mode
  const setMode = (m: 'ticket' | 'text') => setValue('mode', m)

  const seg = (on: boolean) =>
    `h-9 flex-1 cursor-pointer rounded-[9px] border-0 px-3 text-[13px] font-semibold ${on ? 'bg-white text-ink shadow-[0_1px_2px_rgba(27,45,69,0.12)]' : 'bg-transparent text-ink-2'}`

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-3" aria-label="Log time">
      <fieldset disabled={locked} className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0">
        <label className={ui.label}>
          Project
          <select
            {...register('project', { onChange: () => setValue('ticket', '') })}
            className={ui.select}
            aria-label="Project"
          >
            <option value="">{projects.length ? 'Choose a project' : 'No projects'}</option>
            {projects.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {err.project && <span className={ui.error}>{err.project.message}</span>}
        </label>

        <div className="flex flex-col gap-[5px]">
          <span className="text-[12px] font-semibold text-ink-2">Log against</span>
          <div className="flex gap-1 rounded-[11px] bg-sky-2 p-1" role="group" aria-label="Log mode">
            <button type="button" aria-pressed={mode === 'ticket'} className={seg(mode === 'ticket')} onClick={() => setMode('ticket')}>
              Ticket
            </button>
            <button type="button" aria-pressed={mode === 'text'} className={seg(mode === 'text')} onClick={() => setMode('text')}>
              Text
            </button>
          </div>
        </div>

        {mode === 'ticket' ? (
          <label className={ui.label}>
            Ticket
            <select {...register('ticket')} className={ui.select} aria-label="Ticket" disabled={!project || !tickets.length}>
              <option value="">
                {!project ? 'Choose a project first' : tickets.length ? 'Choose a ticket' : 'No tickets in this project'}
              </option>
              {tickets.map(t => (
                <option key={t.id} value={String(t.id)}>
                  {(t.subKey || 'PMT-' + t.id) + ' · ' + t.title}
                </option>
              ))}
            </select>
            {err.ticket && <span className={ui.error}>{err.ticket.message}</span>}
            {project && !tickets.length && (
              <span className="text-[12px] font-normal text-ink-2">
                No tickets in this project. Switch to{' '}
                <button type="button" className="cursor-pointer border-0 bg-transparent p-0 font-semibold text-blue-ink underline" onClick={() => setMode('text')}>
                  Text
                </button>
                .
              </span>
            )}
          </label>
        ) : (
          <div className="flex flex-col gap-2">
            <label className={ui.label}>
              Task
              <select {...register('textPreset')} className={ui.select} aria-label="Task">
                {TEXT_TASKS.map(t => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
                <option value="Custom">Custom</option>
              </select>
            </label>
            {w.textPreset === 'Custom' && (
              <label className={ui.label}>
                Describe the work
                <input {...register('textCustom')} placeholder="Write what you worked on" className={ui.control} aria-label="Describe the work" />
                {err.textCustom && <span className={ui.error}>{err.textCustom.message}</span>}
              </label>
            )}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <label className={ui.label}>
            Hours
            <input type="number" inputMode="numeric" min="0" max="24" step="1" {...register('hours')} className={`${ui.control} tnum`} aria-label="Hours" />
          </label>
          <label className={ui.label}>
            Minutes
            <input type="number" inputMode="numeric" min="0" max="59" step="5" {...register('minutes')} className={`${ui.control} tnum`} aria-label="Minutes" />
          </label>
        </div>
        {err.hours && <span className={ui.error}>{err.hours.message}</span>}
        {err.minutes && <span className={ui.error}>{err.minutes.message}</span>}

        <div className="flex flex-col gap-[5px]">
          <span className="text-[12px] font-semibold text-ink-2">Type</span>
          <div className="flex gap-1 rounded-[11px] bg-sky-2 p-1" role="radiogroup" aria-label="Billable">
            <label className={`${seg(w.billing === 'bill')} inline-flex items-center justify-center`}>
              <input type="radio" value="bill" {...register('billing')} className="sr-only" />
              Billable
            </label>
            <label className={`${seg(w.billing === 'non')} inline-flex items-center justify-center`}>
              <input type="radio" value="non" {...register('billing')} className="sr-only" />
              Non-billable
            </label>
          </div>
        </div>

        <label className={ui.label}>
          Work type
          <select {...register('workType')} className={ui.select} aria-label="Work type">
            {ETYPES.map(k => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>

        <label className={ui.label}>
          Note (optional)
          <input {...register('note')} placeholder="What did you work on?" className={ui.control} aria-label="Note" />
        </label>

        <div className="flex items-center gap-3">
          <button type="submit" className={`${ui.primary} bg-ink hover:bg-ink-2`}>
            Log time
          </button>
          <span className="text-[12px] text-ink-2" role="status">
            {savedAt ? `Saved ${savedAt}` : 'Every entry saves automatically'}
          </span>
        </div>
      </fieldset>
      {locked && <span className="text-[12px] text-ink-2">This week is submitted. Reopen the week to log time.</span>}
    </form>
  )
}
