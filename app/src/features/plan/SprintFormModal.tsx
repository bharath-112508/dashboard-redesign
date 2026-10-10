import { useEffect, useState, type KeyboardEvent } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend, useWorkspace } from '../../api/queries'
import { addDays, fmt, TODAY } from '../../lib/dates'
import { useTeamPeople } from '../tickets/useMe'
import { useOverlay } from '../../state/ui'
import { sprintsOf } from '../../domain/tasks'
import { useEscape } from '../useEscape'
import { fieldCls, labelCls } from './EpicFormModal'

const schema = z
  .object({
    name: z.string(),
    goal: z.string().trim().min(1, 'Add a sprint goal'),
    why: z.string(),
    len: z.number(),
    start: z.string().min(1),
    end: z.string().min(1),
    m1: z.string(),
    m2: z.string(),
  })
  .refine(f => f.end >= f.start, { path: ['end'], message: 'The sprint must end after it starts' })
type Form = z.infer<typeof schema>

/** "New sprint": what the sprint will deliver, its length and who works on it. */
export function SprintFormModal({ epicId }: { epicId: string }) {
  const ws = useWorkspace().data!
  const team = useTeamPeople()
  const send = useSend()
  const overlay = useOverlay()
  const close = () => overlay.close('newSprint')
  useEscape(close)
  const epic = ws.epics.find(e => e.id === epicId)
  // An unknown epic (e.g. ?newSprint=nope) has nothing to attach a sprint to: drop the URL param and show nothing.
  useEffect(() => {
    if (!epic) overlay.close('newSprint')
  }, [epic])
  const sp = sprintsOf(ws.sprints, epicId)
  const last = sp[sp.length - 1]
  const start0 = last ? addDays(last.end, 1) : TODAY
  const [items, setItems] = useState<string[]>([])
  const [itemDraft, setItemDraft] = useState('')
  const { register, handleSubmit, watch, setValue, getValues } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { name: 'Sprint ' + (sp.length + 1), goal: '', why: '', len: 14, start: start0, end: addDays(start0, 13), m1: '', m2: '' },
  })
  const f = watch()
  const ok = !!f.goal.trim() && !!f.start && !!f.end && f.end >= f.start
  // The reason shown next to the disabled Create button.
  const reason = !f.goal.trim()
    ? 'Add a sprint goal'
    : !f.start
      ? 'Pick a start date'
      : !f.end
        ? 'Pick a length or an end date'
        : f.end < f.start
          ? 'The sprint must end after it starts'
          : ''

  const setLen = (L: number) => {
    setValue('len', L)
    setValue('end', addDays(getValues('start'), L - 1))
  }
  const startField = register('start', {
    onChange: e => {
      const len = getValues('len')
      setValue('end', len ? addDays(e.target.value, len - 1) : '')
    },
  })
  // Only the goal-item input reacts to Enter. Enter anywhere else in the form must not submit it.
  const blockEnter = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type !== 'submit' && e.target.type !== 'button') e.preventDefault()
  }
  const addItem = () => {
    const t = itemDraft.trim()
    if (!t) return
    setItems(x => [...x, t])
    setItemDraft('')
  }

  const onSubmit = (v: Form) => {
    if (!epic) return
    const goals = [...items, ...(itemDraft.trim() ? [itemDraft.trim()] : [])]
    const hasActive = ws.sprints.some(x => x.epic === epicId && x.state === 'active')
    send({
      type: 'sprint.create',
      sprint: {
        id: epicId + '_' + Date.now(),
        epic: epicId,
        name: v.name.trim() || 'Sprint',
        goal: v.goal.trim(),
        why: v.why.trim(),
        goals,
        start: v.start,
        end: v.end,
        members: [...new Set([v.m1, v.m2].filter(Boolean))],
        state: v.start <= TODAY && v.end >= TODAY && !hasActive ? 'active' : v.end < TODAY ? 'done' : 'planned',
      },
    })
    close()
  }

  const personSelect = (k: 'm1' | 'm2', label: string) => (
    <label>
      <span className={labelCls}>
        {label} <span className="font-medium text-muted">(optional)</span>
      </span>
      <select {...register(k)} className={fieldCls + ' cursor-pointer'}>
        <option value="">Add later</option>
        {team.map(p => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  )

  if (!epic) return null

  return (
    <>
      <div onClick={close} className="fixed inset-0 z-[70] bg-[rgba(27,45,69,0.38)]" />
      <form
        onSubmit={handleSubmit(onSubmit)}
        onKeyDown={blockEnter}
        noValidate
        className="fixed left-1/2 top-1/2 z-[71] max-h-[calc(100vh-48px)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[22px] border-[1.5px] border-line bg-white px-[26px] py-6 shadow-[0_30px_90px_rgba(27,45,69,0.3)]"
      >
        <div className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-blue-ink">New sprint · {epic?.name}</div>
        <div className="mt-1 text-[20px] font-extrabold text-ink">What will this sprint deliver?</div>
        <label className="mt-4 block">
          <span className={labelCls}>Name</span>
          <input {...register('name')} className={fieldCls} />
        </label>
        <label className="mt-3.5 block">
          <span className={labelCls}>Sprint goal *</span>
          <input {...register('goal')} autoFocus placeholder="e.g. Clients can log in and see their projects" className={fieldCls} />
        </label>
        <label className="mt-3.5 block">
          <span className={labelCls}>Why it matters</span>
          <textarea
            {...register('why')}
            rows={3}
            placeholder="What changes for the client or team when this sprint is done"
            className={fieldCls + ' resize-y leading-[1.55]'}
          />
        </label>
        <div className="mt-3.5">
          <span className={labelCls}>Goals</span>
          <div className="flex flex-col gap-1.5">
            {items.map((t, i) => (
              <div key={i} className="flex items-center gap-2.5 rounded-[10px] bg-canvas px-3 py-[9px] shadow-[inset_0_0_0_1.5px_#E4EAF0]">
                <span className="size-[18px] flex-none rounded-[5px] border-2 border-faint bg-white" />
                <span className="flex-1 text-[14px] font-semibold">{t}</span>
                <button type="button" onClick={() => setItems(x => x.filter((_, j) => j !== i))} className="cursor-pointer border-0 bg-transparent text-[17px] text-faint hover:text-rust">
                  ×
                </button>
              </div>
            ))}
            <div className="flex gap-2">
              <input
                value={itemDraft}
                onChange={e => setItemDraft(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addItem()
                  }
                }}
                placeholder="e.g. BankID login works end to end"
                className={fieldCls + ' flex-1'}
              />
              <button type="button" onClick={addItem} className="h-10 flex-none cursor-pointer rounded-[10px] border-0 bg-sky-2 px-3.5 text-[13px] font-bold text-blue-ink">
                + Add goal
              </button>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <span className={labelCls}>Length</span>
          <div className="inline-flex gap-0.5 rounded-[10px] bg-sky-2 p-[3px]">
            {[
              [7, '1 week'],
              [14, '2 weeks'],
            ].map(([v, label]) => {
              const on = f.len === v
              return (
                <button
                  key={v}
                  type="button"
                  onClick={() => setLen(v as number)}
                  className="h-8 cursor-pointer rounded-lg border-0 px-3.5 text-[13px] font-bold"
                  style={{ background: on ? '#FFFFFF' : 'transparent', color: on ? '#1B2D45' : '#1F3FAF' }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2.5">
            <label>
              <span className={labelCls}>Start</span>
              <input type="date" {...startField} className={fieldCls + ' tnum !text-[13px]'} />
            </label>
            <div>
              <span className={labelCls}>End</span>
              <div className="flex h-10 items-center rounded-[10px] bg-canvas px-3 text-[14px] font-bold text-ink">{f.end ? fmt(f.end) : '—'}</div>
            </div>
          </div>
        </div>
        <div className="mt-3.5 grid grid-cols-2 gap-2.5">
          {personSelect('m1', 'Person 1')}
          {personSelect('m2', 'Person 2')}
        </div>
        <div className="mt-5 flex items-center justify-end gap-2.5">
          {!ok && reason && <span className="mr-auto text-[12.5px] font-semibold text-rust">{reason}</span>}
          <button type="button" onClick={close} className="h-[38px] cursor-pointer rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink">
            Cancel
          </button>
          <button
            type="submit"
            disabled={!ok}
            className="h-[38px] cursor-pointer rounded-[10px] border-0 bg-blue px-[18px] text-[13.5px] font-bold text-white disabled:cursor-not-allowed"
            style={{ opacity: ok ? 1 : 0.45 }}
          >
            Create sprint
          </button>
        </div>
      </form>
    </>
  )
}
