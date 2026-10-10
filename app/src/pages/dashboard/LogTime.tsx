import { useMemo, useState, type ReactNode } from 'react'
import { Controller, useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend } from '../../api/queries'
import { hm } from '../../api/dashboard/time'
import { logTime } from '../../api/timesheet'
import { avatarOf } from '../../api/people/avatar'
import type { Person, Session, Status, Task, TimeEntry } from '../../api/types'
import { statusOf, taskKey } from '../../domain/tasks'
import { Backdrop, Icon, PATHS } from '../../components/ui'
import { useEscape } from '../../features/useEscape'

/** Hours 0–24 and the minute steps the picker offers. */
const HOURS = Array.from({ length: 25 }, (_, i) => i)
const MINUTES = [0, 5, 10, 15, 30, 45]

const schema = z
  .object({
    mode: z.enum(['ticket', 'text']),
    task: z.string(),
    area: z.string().trim(),
    notes: z.string().trim().max(300, 'Keep the note under 300 characters'),
    /** Minutes, so the picker's steps stay whole numbers. */
    billMin: z.number().int().min(0).max(24 * 60),
    nonMin: z.number().int().min(0).max(24 * 60),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'ticket' && !v.task) ctx.addIssue({ code: 'custom', path: ['task'], message: 'Choose a ticket' })
    if (v.mode === 'text' && !v.area) ctx.addIssue({ code: 'custom', path: ['area'], message: 'Say what you worked on' })
    if (v.billMin + v.nonMin <= 0) ctx.addIssue({ code: 'custom', path: ['billMin'], message: 'Enter a duration' })
  })

type LogForm = z.infer<typeof schema>

const BLANK: LogForm = { mode: 'ticket', task: '', area: '', notes: '', billMin: 0, nonMin: 0 }

const minutesLabel = (m: number) => (m ? hm(m / 60) : '0h 0m')

const TONE_BADGE = { blue: ['#E7EEFB', '#1F3FAF'], amber: ['#FBEDC2', '#7A5C0E'] } as const

interface Props {
  me: Session
  person: Person | undefined
  /** Open top-level tickets, the ones the picker offers. */
  tickets: Task[]
  statuses: Status[]
  /** All tasks, for looking up the title of a logged entry. */
  allTasks: Task[]
  /** Every time entry, to pick the next id. */
  /** The signed-in person's entries for today. */
  todays: TimeEntry[]
  today: string
  dayShort: string
}

/** The quick-log card for developers and DevOps: writes a TimeEntry through the shared time command. */
export function LogTime({ me, person, tickets, statuses, allTasks, todays, today, dayShort }: Props) {
  const send = useSend()
  const { control, register, handleSubmit, reset, setValue, getValues } = useForm<LogForm>({
    resolver: zodResolver(schema),
    defaultValues: BLANK,
    mode: 'onChange',
  })
  const watched = useWatch({ control })
  const valid = useMemo(() => schema.safeParse({ ...BLANK, ...watched }).success, [watched])
  const mode = useWatch({ control, name: 'mode' })
  const total = todays.reduce((a, e) => a + e.bill + e.non, 0)
  const initials = avatarOf(person ?? { name: me.name, colour: '#1B2D45', photo: '' }, { showPhoto: false }).initials

  const onSave = handleSubmit(v => {
    const task = v.mode === 'ticket' ? allTasks.find(t => t.id === +v.task) : undefined
    send(logTime({
        date: today,
        userId: me.personId,
        user: me.name,
        type: 'General',
        task: task?.id ?? null,
        ...(v.mode === 'text' ? { area: v.area } : {}),
        ...(task?.epic ? { epic: task.epic } : {}),
        notes: v.notes,
        bill: v.billMin / 60,
        non: v.nonMin / 60,
    }))
    reset({ ...BLANK, mode: v.mode })
  })

  const remove = (id: number) => send({ type: 'time.remove', id })
  const byId = useMemo(() => new Map(allTasks.map(t => [t.id, t])), [allTasks])

  const saveBg = valid ? '#3F9079' : '#A9B6C5'
  const label = 'flex h-[22px] items-center text-[12px] font-bold uppercase tracking-[0.05em] text-muted'

  return (
    <section aria-labelledby="log-time-title" className="relative z-[5] rounded-2xl bg-canvas shadow-[0_0_0_1.5px_#D6DEE8]">
      <div className="flex items-center gap-2.5 rounded-t-[15px] bg-white px-4 py-3 shadow-[inset_0_-1.5px_0_#E4EAF0]">
        <span className="grid size-7 flex-none place-items-center rounded-lg bg-ink text-[11px] font-bold text-white">{initials}</span>
        <div className="flex-none">
          <h2 id="log-time-title" className="text-[14.5px] font-bold whitespace-nowrap text-ink">
            Log your time
          </h2>
          <div className="text-[12px] whitespace-nowrap text-muted">
            {me.name} · Today, {dayShort}
          </div>
        </div>
        <span className="ml-auto text-[13px] font-bold text-ink" aria-live="polite">
          Today {hm(total)}
        </span>
      </div>

      <form
        onSubmit={onSave}
        className="grid grid-cols-1 items-end gap-3 p-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_140px_140px_auto]"
      >
        <div className="min-w-0">
          <div className="mb-1.5 flex h-[22px] items-center gap-2">
            <span className={label}>Log against</span>
            <div role="group" aria-label="Log against" className="inline-flex gap-0.5 rounded-lg bg-white p-0.5 shadow-[inset_0_0_0_1.5px_#A9B6C5]">
              {(['ticket', 'text'] as const).map(m => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => setValue('mode', m, { shouldValidate: true })}
                  className={`h-[22px] cursor-pointer rounded-md border-0 px-2.5 text-[12px] font-bold ${mode === m ? 'bg-ink text-white' : 'bg-transparent text-muted'}`}
                >
                  {m === 'ticket' ? 'Ticket' : 'Text'}
                </button>
              ))}
            </div>
          </div>
          {mode === 'text' ? (
            <input
              aria-label="Area worked on"
              placeholder="Area worked on, e.g. Sprint planning"
              className="h-[42px] w-full rounded-[10px] border-[1.5px] border-line bg-white px-3 text-[14px] text-ink outline-0 focus:border-blue"
              {...register('area')}
            />
          ) : (
            <Controller
              control={control}
              name="task"
              render={({ field }) => (
                <TicketPicker value={field.value} onChange={field.onChange} tickets={tickets} statuses={statuses} />
              )}
            />
          )}
        </div>

        <div className="min-w-0">
          <label htmlFor="log-notes" className={`${label} whitespace-nowrap`}>
            Notes
          </label>
          <input
            id="log-notes"
            placeholder="What did you do?"
            className="h-[42px] w-full rounded-[10px] border-[1.5px] border-line bg-white px-3 text-[14px] text-ink outline-0 focus:border-blue"
            {...register('notes')}
          />
        </div>

        <Controller
          control={control}
          name="billMin"
          render={({ field }) => <DurationField label="Billable" tone="blue" value={field.value} onChange={field.onChange} />}
        />
        <Controller
          control={control}
          name="nonMin"
          render={({ field }) => <DurationField label="Non-billable" tone="amber" value={field.value} onChange={field.onChange} />}
        />

        <div className="flex gap-1.5">
          <button
            type="submit"
            title="Save"
            aria-label="Save time entry"
            aria-disabled={!valid}
            className="grid size-[42px] cursor-pointer place-items-center rounded-[10px] border-0 p-0 text-white"
            style={{ background: saveBg }}
          >
            <Icon d={PATHS.check} size={16} sw={2.8} />
          </button>
          <button
            type="button"
            title="Clear"
            aria-label="Clear form"
            onClick={() => reset({ ...BLANK, mode: getValues('mode') })}
            className="grid size-[42px] cursor-pointer place-items-center rounded-[10px] border-[1.5px] border-line bg-white p-0 text-muted hover:border-blue"
          >
            <Icon d={PATHS.close} size={14} sw={2.4} />
          </button>
        </div>
      </form>

      {todays.length > 0 && (
        <ul className="overflow-hidden rounded-b-[15px] border-t-[1.5px] border-line-3 bg-white">
          {todays
            .slice()
            .sort((a, b) => b.id - a.id)
            .map(e => {
              const t = e.task !== null ? byId.get(e.task) : undefined
              const hours = e.bill + e.non
              return (
                <li
                  key={e.id}
                  className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1.2fr)_110px_auto_32px] items-center gap-3 border-t-[1.5px] border-sky px-4 py-2 max-md:grid-cols-[minmax(0,1fr)_auto_32px]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {t && (
                      <span className="flex-none rounded-[5px] bg-sky-2 px-1.5 py-0.5 text-[11px] font-semibold text-blue-ink">{taskKey(t)}</span>
                    )}
                    <span className="min-w-0 truncate text-[13.5px] font-semibold">{t ? t.title : e.area || 'Area'}</span>
                  </span>
                  <span className="min-w-0 truncate text-[12.5px] text-muted max-md:hidden">{e.notes || '—'}</span>
                  <span className="text-[13.5px] font-extrabold tabular-nums">{hm(hours)}</span>
                  <span className="flex gap-1 max-md:hidden">
                    {e.bill > 0 && <KindPill tone="blue" text="Billable" />}
                    {e.non > 0 && <KindPill tone="amber" text="Non-billable" />}
                  </span>
                  <button
                    type="button"
                    onClick={() => remove(e.id)}
                    title="Remove"
                    aria-label={`Remove ${t ? taskKey(t) : e.area || 'entry'}`}
                    className="grid size-7 cursor-pointer place-items-center rounded-[7px] border-0 bg-transparent text-[16px] text-faint hover:bg-rust-soft hover:text-rust"
                  >
                    ×
                  </button>
                </li>
              )
            })}
        </ul>
      )}
    </section>
  )
}

function KindPill({ tone, text }: { tone: keyof typeof TONE_BADGE; text: string }) {
  const [bg, ink] = TONE_BADGE[tone]
  return (
    <span className="inline-flex h-[22px] items-center gap-1.5 rounded-md px-2 text-[11.5px] font-bold whitespace-nowrap" style={{ background: bg, color: ink }}>
      <span className="size-1.5 rounded-full" style={{ background: ink }} />
      {text}
    </span>
  )
}

/** The ticket picker: a button that opens a searchable list of open tickets. */
function TicketPicker({ value, onChange, tickets, statuses }: { value: string; onChange: (v: string) => void; tickets: Task[]; statuses: Status[] }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const current = tickets.find(t => String(t.id) === value)
  const needle = q.trim().toLowerCase()
  const shown = tickets.filter(t => !needle || `${taskKey(t)} ${t.title}`.toLowerCase().includes(needle))
  useEscape(() => setOpen(false))

  return (
    <span className="relative block">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`flex h-[42px] w-full cursor-pointer items-center gap-2 rounded-[10px] border-[1.5px] bg-white px-3 text-left text-[14px] text-ink ${open ? 'border-blue' : 'border-line'}`}
      >
        {current ? (
          <>
            <span className="flex-none rounded-[5px] bg-sky-2 px-1.5 py-0.5 text-[11px] font-semibold text-blue-ink">{taskKey(current)}</span>
            <span className="min-w-0 truncate font-semibold">{current.title}</span>
          </>
        ) : (
          <span className="text-muted">Choose a ticket</span>
        )}
        <span className="ml-auto flex-none text-muted" aria-hidden="true">▾</span>
      </button>
      {open && (
        <>
          <Backdrop onClick={() => setOpen(false)} z={60} />
          <div role="listbox" aria-label="Tickets" className="absolute left-0 top-[calc(100%+6px)] z-[61] w-[min(460px,90vw)] rounded-xl border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]">
            <input
              aria-label="Search tickets"
              placeholder="Search tickets"
              value={q}
              onChange={e => setQ(e.target.value)}
              autoFocus
              className="mb-1 h-9 w-full rounded-lg border-[1.5px] border-line-2 px-2.5 text-[13.5px] outline-0 focus:border-blue"
            />
            <div className="max-h-[260px] overflow-y-auto">
              {shown.length === 0 && <div className="px-2.5 py-3 text-[13px] text-muted">No tickets found</div>}
              {shown.map(t => (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={String(t.id) === value}
                  onClick={() => {
                    onChange(String(t.id))
                    setOpen(false)
                    setQ('')
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-2.5 py-2 text-left hover:bg-canvas"
                >
                  <span className="flex-none rounded-[5px] bg-sky-2 px-1.5 py-0.5 text-[11px] font-semibold text-blue-ink">{taskKey(t)}</span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink">{t.title}</span>
                  <span className="flex-none text-[11.5px] text-muted">{statusOf(statuses, t.status).name}</span>
                  {String(t.id) === value && <span className="flex-none text-blue-ink" aria-hidden="true">✓</span>}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </span>
  )
}

/** Billable or non-billable duration: hours and minutes in two columns, stored as minutes. */
function DurationField({ label, tone, value, onChange }: { label: string; tone: 'blue' | 'amber'; value: number; onChange: (v: number) => void }) {
  const [open, setOpen] = useState(false)
  const hours = Math.floor(value / 60)
  const mins = value % 60
  const colour = tone === 'blue' ? '#195040' : '#7A5C0E'
  const pick = (h: number, m: number) => onChange(h * 60 + m)
  return (
    <div className="min-w-0">
      <div className="mb-1.5 flex h-[22px] items-center whitespace-nowrap text-[12px] font-bold uppercase tracking-[0.05em]" style={{ color: colour }}>
        {label}
      </div>
      <span className="relative block">
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label} duration`}
          onClick={() => setOpen(o => !o)}
          className={`flex h-[42px] w-full cursor-pointer items-center justify-between rounded-[10px] border-[1.5px] bg-white px-3 text-[14px] font-semibold text-ink ${open ? 'border-blue' : 'border-line'}`}
        >
          <span className="tabular-nums">{minutesLabel(value)}</span>
          <span className="text-muted" aria-hidden="true">▾</span>
        </button>
        {open && (
          <>
            <Backdrop onClick={() => setOpen(false)} z={60} />
            <div role="dialog" aria-label={`${label} duration`} className="absolute left-0 top-[calc(100%+6px)] z-[61] w-[220px] rounded-xl border-[1.5px] border-line bg-white p-1.5 shadow-[0_18px_50px_rgba(27,45,69,0.2)]">
              <div className="flex gap-1.5">
                <div className="min-w-0 flex-1">
                  <div className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Hours</div>
                  <div className="flex max-h-[240px] flex-col gap-0.5 overflow-y-auto">
                    {HOURS.map(h => (
                      <OptionButton key={h} on={h === hours} onClick={() => pick(h, mins)}>
                        {h}h
                      </OptionButton>
                    ))}
                  </div>
                </div>
                <div className="w-px bg-line-3" />
                <div className="min-w-0 flex-1">
                  <div className="px-2 pb-1.5 pt-1 text-[11px] font-bold uppercase tracking-[0.05em] text-muted">Minutes</div>
                  <div className="flex flex-col gap-0.5">
                    {MINUTES.map(m => (
                      <OptionButton key={m} on={m === mins} onClick={() => pick(hours, m)}>
                        {m}m
                      </OptionButton>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-1.5 flex items-center justify-between border-t-[1.5px] border-sky px-1 pb-0.5 pt-1.5">
                <button type="button" onClick={() => onChange(0)} className="h-7 cursor-pointer border-0 bg-transparent px-2.5 text-[12.5px] font-bold text-muted">
                  Clear
                </button>
                <button type="button" onClick={() => setOpen(false)} className="h-7 cursor-pointer rounded-md border-0 bg-ink px-3 text-[12.5px] font-bold text-white">
                  Done
                </button>
              </div>
            </div>
          </>
        )}
      </span>
    </div>
  )
}

function OptionButton({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-7 cursor-pointer items-center rounded-md border-0 px-2.5 text-left text-[13px] ${on ? 'bg-sky-2 font-bold text-blue-ink' : 'bg-transparent font-semibold text-ink hover:bg-canvas'}`}
    >
      {children}
    </button>
  )
}
