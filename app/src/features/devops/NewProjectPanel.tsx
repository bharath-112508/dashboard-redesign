import { useState, type CSSProperties } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useCompanies, useSend } from '../../api/queries'
import type { DvProject, DvSettings } from '../../api/devops/types'
import { useDv } from './ctx'
import {
  addD,
  devList,
  fmtD,
  FIELD_LABEL,
  FROMS,
  ladderNames,
  ladderOffsets,
  movedLabel,
  ownerColor,
  PRIOS,
  relD,
  tileOf,
  tileText,
  TODAY,
  teamOf,
  tone,
} from './model'
import { Caret, GlassMenu, PrioIcon, Switch } from './ui'

const makeSchema = (s: DvSettings, names: string[]) =>
  z
    .object({
      name: z.string(),
      infra: z.string(),
      prio: z.string(),
      from: z.string(),
      owner: z.string(),
      dev: z.string(),
      initDue: z.string(),
      latestDue: z.string(),
      phase: z.string(),
      phaseDue: z.string(),
      next: z.string(),
      devDue: z.string(),
      ladder: z.boolean(),
      actDate: z.string(),
      reminder: z.string(),
      note: z.string(),
    })
    .superRefine((v, ctx) => {
      // One message at a time, in the prototype's order.
      const err = !v.name.trim()
        ? ['name', 'Name is required']
        : !v.initDue
          ? ['initDue', 'Initial due date is required']
          : v.phase.trim() && s.rules.requirePhaseDue && !v.phaseDue
            ? ['phaseDue', 'Phase due date is required']
            : names.includes(v.name.trim().toLowerCase())
              ? ['name', 'A project with this name exists']
              : null
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [err[0]], message: err[1] })
    })

type Form = z.infer<ReturnType<typeof makeSchema>>
type PickKey = 'infra' | 'prio' | 'from' | 'dev' | 'owner'
type DateKey = 'initDue' | 'latestDue' | 'phaseDue' | 'devDue' | 'actDate' | 'reminder'

const area = 'mt-1.5 w-full resize-y rounded-xl border-0 bg-white px-3 py-2.5 text-[14px] leading-normal text-ink outline-0 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.06)]'
const card = 'rounded-[14px] bg-white shadow-[0_0_0_0.5px_rgba(0,0,0,0.06),0_1px_2px_rgba(0,0,0,0.03)]'

/** "New project": the same layout as an open project, with the fields in the sidebar. */
export function NewProjectPanel() {
  const { db, open, dd, setDd, me } = useDv()
  const send = useSend()
  const companies = useCompanies().data
  const s = db.settings
  const [dateOpen, setDateOpen] = useState<DateKey | null>(null)
  const schema = makeSchema(
    s,
    db.projects.map(p => p.name.toLowerCase()),
  )
  const { register, setValue, control, handleSubmit, formState } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: '',
      infra: s.statuses[0]?.name ?? 'Not started',
      prio: 'Medium',
      from: 'Client',
      owner: me || 'Unassigned',
      dev: devList(s)[0] ?? 'Not started',
      initDue: '',
      latestDue: '',
      phase: '',
      phaseDue: '',
      next: '',
      devDue: '',
      ladder: true,
      actDate: TODAY,
      reminder: addD(TODAY, Math.max(1, Math.round((ladderOffsets(s)[1] || 48) / 24))),
      note: '',
    },
  })
  const v = useWatch({ control }) as Form
  const valid = schema.safeParse(v)
  const firstErr = valid.success ? '' : valid.error.issues[0]?.message || ''
  const close = () => open({ new: null }, true)
  const nm = (v.name || '').trim()

  const create = handleSubmit(n => {
    const num = Math.max(100, ...db.projects.map(p => +p.key.split('-')[1] || 0)) + 1
    const key = 'OPS-' + num
    const rt = s.rules.remTime
    const lad = ladderNames(s)
    const latest = n.latestDue && n.latestDue !== n.initDue ? n.latestDue : null
    const project: DvProject = {
      key,
      name: n.name.trim(),
      // The client is the company that has a project of this name (none for a free-typed name).
      client: companies?.find(c => c.projects.some(x => x.name === n.name.trim()))?.name || '',
      kind: 'client',
      infra: n.infra,
      prio: n.prio,
      from: n.from,
      owner: n.owner === 'Unassigned' ? null : n.owner,
      initDue: n.initDue,
      latestDue: latest,
      moved: latest ? movedLabel(latest, n.initDue) : null,
      phase: n.phase.trim() || null,
      phaseDue: n.phaseDue || null,
      next: n.next.trim() || null,
      dev: n.dev,
      devDue: n.devDue || null,
      deploy: 'Not set',
      updatedBy: me,
      act: n.ladder ? lad[0] : 'Not required',
      step: n.ladder ? 0 : null,
      seqStart: n.ladder && n.actDate ? n.actDate + 'T' + rt : null,
      actDate: n.ladder && n.actDate ? n.actDate + 'T' + rt : null,
      reminder: n.ladder && n.reminder ? n.reminder + 'T' + rt : null,
      overdue: !!(n.ladder && n.reminder && n.reminder < TODAY),
      notes: n.ladder && n.note.trim() ? { 0: { text: n.note.trim(), when: 'Just now' } } : undefined,
      added: TODAY,
      logs: [
        {
          type: 'Field change',
          text: 'Project created',
          detail: [n.infra, n.prio, 'Initial due ' + fmtD(n.initDue)].join(' · '),
          by: me,
          when: 'Just now',
        },
        ...(n.ladder && n.note.trim() ? [{ type: 'Action update', by: me, when: 'Just now', text: n.note.trim() }] : []),
      ],
    }
    send({ type: 'devops.project.create', project })
    open({ new: null, project: key, tab: null }, true)
  })

  const opts: Record<PickKey, string[]> = {
    infra: s.statuses.map(x => x.name),
    prio: PRIOS,
    from: FROMS,
    dev: [...devList(s), 'Not set'],
    owner: [...teamOf(s, me), 'Unassigned'],
  }
  const set = (k: keyof Form, val: string) => setValue(k, val as never, { shouldValidate: formState.isSubmitted })

  const dates: [DateKey, string, string][] = [
    ['initDue', 'Initial due date', 'Required · fixed once created'],
    ['latestDue', 'Estimated deployment', 'Defaults to initial due'],
    ['phaseDue', 'Phase due date', s.rules.requirePhaseDue ? 'Required with a current phase' : 'Optional'],
    ['devDue', 'Dev phase due date', 'Optional'],
  ]
  if (v.ladder)
    dates.push(['actDate', 'Sequence starts', 'Follow-up'], ['reminder', 'First reminder', 'Follow-up'])

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-50 animate-fade-in bg-[rgba(27,45,69,0.38)]" />
      <aside
        data-testid="new-project"
        className="dv-slide fixed bottom-3 right-3 top-3 z-[51] flex w-[920px] max-w-[calc(100vw-24px)] overflow-hidden rounded-[28px] border border-line-3 bg-white font-normal text-ink shadow-[0_30px_90px_rgba(0,0,0,0.2),0_0_0_0.5px_rgba(0,0,0,0.08)]"
      >
        <form onSubmit={create} className="flex min-w-0 flex-1 flex-col">
          <div className="px-9 pt-7">
            <div className="flex items-start justify-between gap-4">
              <div
                className="flex size-8 flex-none items-center justify-center rounded-md text-[12px] font-bold text-white"
                style={{ background: nm ? tileOf(nm) : '#A9B6C5' }}
              >
                {nm ? tileText(nm) : '+'}
              </div>
              <input
                {...register('name')}
                placeholder="New project name"
                className="min-w-0 flex-1 self-center border-0 bg-transparent p-0 text-[28px] font-bold leading-[1.15] tracking-[-0.025em] text-ink outline-0"
              />
              <button type="button" onClick={close} className="size-7 flex-none cursor-pointer rounded-full border-0 bg-sky-2 text-[15px] leading-none text-muted">
                ×
              </button>
            </div>
            <div className="mt-6 h-[0.5px] bg-black/10" />
          </div>
          <div className="flex-1 overflow-y-auto px-9 pb-9 pt-7">
            <div className="rounded-[20px] bg-canvas px-[22px] pb-[22px] pt-5">
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">DevOps phase</div>
              <div className="mt-3 text-[12px] text-muted">Current phase</div>
              <textarea {...register('phase')} rows={3} placeholder="What is happening now?" className={area} />
              <div className="mt-3.5 text-[12px] text-muted">Up next</div>
              <textarea {...register('next')} rows={2} placeholder="What comes after this?" className={area} />
            </div>
            <div className="mt-4 rounded-[20px] bg-canvas px-[22px] pb-[22px] pt-5">
              <div className="flex items-center gap-4">
                <div className="min-w-0 flex-1">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Follow-up sequence</div>
                  <div className="mt-1.5 text-[13px] text-muted">Starts at {ladderNames(s)[0]} and schedules reminders from Settings.</div>
                </div>
                <Switch big label="Start the follow-up sequence" on={!!v.ladder} onClick={() => setValue('ladder', !v.ladder)} />
              </div>
              {v.ladder && (
                <>
                  <div className="mt-3.5 text-[12px] text-muted">What happened so far?</div>
                  <textarea {...register('note')} rows={2} placeholder="e.g. Onboarding email sent to client" className={area} />
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 border-t-[0.5px] border-black/10 px-9 py-4">
            <span className="text-[12px] text-rust">{formState.isSubmitted ? firstErr : ''}</span>
            <div className="flex-1" />
            <button type="button" onClick={close} className="cursor-pointer rounded-lg border-0 bg-sky-2 px-4 py-2 text-[13px] font-medium text-ink">
              Cancel
            </button>
            <button
              type="submit"
              className="cursor-pointer rounded-lg border-0 bg-blue px-[18px] py-2 text-[13px] font-semibold text-white"
              style={{ opacity: firstErr ? 0.45 : 1 }}
            >
              Create project
            </button>
          </div>
        </form>

        <div className="flex-[0_0_308px] overflow-y-auto border-l-[0.5px] border-black/[0.06] bg-canvas px-[18px] pb-7 pt-16">
          <div className="px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Details</div>
          <div className={card}>
            {(['infra', 'prio', 'from', 'dev', 'owner'] as PickKey[]).map((k, i) => {
              const val = v[k]
              const own = k === 'owner'
              const [tC, tBg] = own ? ['#1B2D45', '#E7EEFB'] : tone(val)
              const ddk = 'np_' + k
              const isOpen = dd === ddk
              return (
                <div key={k} style={{ borderTop: i ? '0.5px solid rgba(0,0,0,0.07)' : 'none' }}>
                  <div className="flex min-h-[46px] items-center justify-between gap-2.5 py-2 pl-3.5 pr-3">
                    <span className="min-w-0 flex-1 truncate whitespace-nowrap text-[13px] text-ink-2">{FIELD_LABEL[k]}</span>
                    <div className="relative flex-none">
                      <button
                        type="button"
                        onClick={() => setDd(isOpen ? null : ddk)}
                        className="flex max-w-[160px] cursor-pointer items-center gap-1.5 rounded-md border-0 py-[5px] pl-[11px] pr-1.5 text-[12px] font-semibold transition-shadow duration-150 hover:![box-shadow:var(--hv)]"
                        style={{ background: tBg, color: tC, boxShadow: isOpen ? '0 0 0 2px #4870E8' : 'inset 0 0 0 1px rgba(0,0,0,0.06)', '--hv': `0 0 0 1.5px ${tC}` } as CSSProperties}
                      >
                        {own && (
                          <span
                            className="-ml-1.5 flex size-[18px] flex-none items-center justify-center rounded-[5px] text-[9px] font-semibold text-white"
                            style={{ background: ownerColor(val) }}
                          >
                            {val !== 'Unassigned' ? val[0] : '–'}
                          </span>
                        )}
                        {k === 'prio' && <PrioIcon p={val} size={14} sw={2.2} style={{ marginLeft: -3 }} />}
                        <span className="min-w-0 truncate whitespace-nowrap">{val}</span>
                        <span className="flex size-[18px] flex-none items-center justify-center rounded-full bg-white/75">
                          <Caret />
                        </span>
                      </button>
                      {isOpen && (
                        <GlassMenu
                          title={FIELD_LABEL[k]}
                          z={52}
                          onClose={() => setDd(null)}
                          options={opts[k].map(o => ({
                            label: o,
                            on: o === val,
                            ...(own ? { avatar: { i: o !== 'Unassigned' ? o[0] : '–', bg: ownerColor(o) } } : { dot: [tone(o)[0], tone(o)[1]] as [string, string] }),
                            pick: () => {
                              setDd(null)
                              set(k, o)
                            },
                          }))}
                        />
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
          <div className="px-1 pb-2 pt-7 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Dates</div>
          <div className={card}>
            {dates.map(([k, label, sub], i) => {
              const val = v[k] as string
              const [rr] = val ? relD(val, false) : ['']
              const missing = !val && (k === 'initDue' || (k === 'phaseDue' && s.rules.requirePhaseDue && !!(v.phase || '').trim()))
              return (
                <div key={k} style={{ borderTop: i ? '0.5px solid rgba(0,0,0,0.07)' : 'none' }}>
                  <div
                    onClick={() => setDateOpen(dateOpen === k ? null : k)}
                    className="flex min-h-[50px] cursor-pointer items-center justify-between gap-2.5 px-3.5 py-2 hover:bg-sky"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate whitespace-nowrap text-[13px] text-ink-2">{label}</div>
                      <div className="mt-px truncate whitespace-nowrap text-[11px]" style={{ color: missing && formState.isSubmitted ? '#A5502C' : '#56657A' }}>
                        {sub}
                      </div>
                    </div>
                    <div className="flex-none text-right">
                      <div className="tnum whitespace-nowrap text-[13px] font-semibold" style={{ color: val ? '#1B2D45' : '#1F3FAF' }}>
                        {val ? fmtD(val) : 'Set date'}
                      </div>
                      <div className="mt-px whitespace-nowrap text-[11px] font-medium text-muted">{val ? rr : ''}</div>
                    </div>
                  </div>
                  {dateOpen === k && (
                    <div className="px-3.5 pb-3">
                      <input
                        type="date"
                        aria-label={label}
                        autoFocus
                        value={val}
                        onChange={e => {
                          const x = e.target.value
                          set(k, x)
                          if (k === 'initDue' && !v.latestDue) set('latestDue', x)
                          setDateOpen(null)
                        }}
                        className="w-full rounded-[9px] border-0 bg-canvas px-[9px] py-[7px] text-[13px] text-ink outline-0 shadow-[0_0_0_2px_#4870E8]"
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </aside>
    </>
  )
}
