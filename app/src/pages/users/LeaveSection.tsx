import { RefusedError } from '../../api/server'
import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSendAsync } from '../../api/queries'
import type { LeaveRequest, LeaveStatus, Notification, Person, Session } from '../../api/types'
import { leaveDays } from '../../api/users/derive'
import { leaveLabel, useLeaveBook } from '../../api/users/leaveBook'
import { range, TODAY } from '../../lib/dates'
import { useToast } from '../shell/toast'
import { btnGhost, btnPrimary, btnSmall, card, field, label } from './ui'

const STATUS_CLASS: Record<LeaveStatus, string> = {
  Approved: 'bg-green-soft text-green-ink',
  Pending: 'bg-amber-soft text-amber-ink',
  Rejected: 'bg-peach text-rust',
}

const schema = z
  .object({
    type: z.string().min(1, 'Pick a type'),
    from: z.string().min(1, 'Pick a start date'),
    to: z.string().min(1, 'Pick an end date'),
    reason: z.string().trim(),
  })
  .refine(v => !v.from || !v.to || v.to >= v.from, { message: "The end date can't be before the start date.", path: ['to'] })
type Form = z.infer<typeof schema>

interface Props {
  person: Person
  leave: LeaveRequest[]
  notes: Notification[]
  canEdit: boolean
  session: Session
}

/** Leave balance, requests (add, approve, reject) and the notices recorded for the person. */
export function LeaveSection({ person, leave, notes, canEdit, session }: Props) {
  const send = useSendAsync()
  const show = useToast()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Types and the main type's balance: the design's in mock mode, the backend's in API mode.
  const book = useLeaveBook(leave, person.id)
  const { register, handleSubmit, reset, formState, getValues, setValue } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { type: book.main, from: TODAY, to: TODAY, reason: '' },
  })
  // The backend's types arrive after the first render.
  useEffect(() => {
    if (book.main && !getValues('type')) setValue('type', book.main)
  }, [book.main])

  const mine = leave.filter(r => r.userId === person.id).sort((a, b) => b.from.localeCompare(a.from))
  const used = book.used
  const pend = book.pending
  const left = book.left
  const mainLabel = leaveLabel(book.main)

  const decide = async (r: LeaveRequest, status: Exclude<LeaveStatus, 'Pending'>) => {
    setError(null)
    if (status === 'Approved' && r.type === book.main && leaveDays(r) > left) {
      return setError(`Only ${left} days of ${mainLabel.toLowerCase()} are left for ${person.name}.`)
    }
    try {
      await send({ type: 'leave.decide', id: r.id, status, by: session.name, when: TODAY })
      show(status === 'Approved' ? `Approved leave for ${person.name}. A notice was recorded.` : `Rejected leave for ${person.name}.`)
    } catch (err) {
      setError(err instanceof RefusedError ? err.message : 'The decision could not be saved. Try again.')
    }
  }

  const onAdd = handleSubmit(async v => {
    setError(null)
    const id = String(Math.max(0, ...leave.map(r => Number(r.id)).filter(Number.isFinite)) + 1)
    try {
      await send({
        type: 'leave.create',
        request: { id, userId: person.id, type: v.type, from: v.from, to: v.to, reason: v.reason, status: 'Pending' },
      })
      show('Leave requested. It stays pending until it is approved.')
      reset()
      setAdding(false)
    } catch (err) {
      setError(err instanceof RefusedError ? err.message : 'The request could not be saved. Try again.')
    }
  })

  return (
    <section className={`${card} p-5`} aria-labelledby="leave-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="leave-title" className="text-[16px] font-bold text-ink">Leave</h2>
        {canEdit && !adding && (
          <button type="button" className={btnSmall} onClick={() => setAdding(true)}>
            Add leave
          </button>
        )}
      </div>

      <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
        <Box big={`${left} days left`} small={`${mainLabel}, ${book.allowance} a year`} />
        <Box big={`${used} used`} small={`Approved ${mainLabel.toLowerCase()}`} />
        <Box big={`${pend} pending`} small="Waiting for a decision" />
      </div>

      {adding && (
        <form onSubmit={onAdd} noValidate className="mt-4 grid gap-3 rounded-[14px] border-[1.5px] border-line-2 p-4 sm:grid-cols-2">
          <label>
            <span className={label}>Type</span>
            <select className={field} {...register('type')}>
              {book.types.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={label}>Reason</span>
            <input className={field} placeholder="Optional" {...register('reason')} />
          </label>
          <label>
            <span className={label}>From</span>
            <input type="date" className={field} aria-invalid={!!formState.errors.from} {...register('from')} />
            {formState.errors.from && <span className="mt-1 block text-[12px] font-semibold text-red">{formState.errors.from.message}</span>}
          </label>
          <label>
            <span className={label}>To</span>
            <input type="date" className={field} aria-invalid={!!formState.errors.to} {...register('to')} />
            {formState.errors.to && <span className="mt-1 block text-[12px] font-semibold text-red">{formState.errors.to.message}</span>}
          </label>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <button type="button" className={btnGhost} onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={formState.isSubmitting}>
              Save request
            </button>
          </div>
        </form>
      )}

      {error && <p role="alert" className="mt-3 text-[13px] font-semibold text-red">{error}</p>}

      <div className="mt-4">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.06em] text-slate">Requests</h3>
        {!mine.length ? (
          <p className="mt-2 text-[13.5px] text-slate">No leave requests yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line-3">
            {mine.map(r => {
              const days = leaveDays(r)
              const tooMany = r.type === book.main && days > left
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-[13.5px]">
                  <div className="min-w-[160px] flex-1">
                    <div className="font-bold text-ink">
                      {r.type} · {range(r.from, r.to)}
                    </div>
                    <div className="text-[12.5px] text-slate">
                      {days} {days === 1 ? 'day' : 'days'}
                      {r.reason ? ` · ${r.reason}` : ''}
                    </div>
                  </div>
                  <span className={`rounded-full px-2.5 py-[3px] text-[11.5px] font-bold ${STATUS_CLASS[r.status]}`}>{r.status}</span>
                  {canEdit && r.status === 'Pending' && (
                    <div className="flex gap-2">
                      <button
                        type="button"
                        className={btnSmall}
                        disabled={tooMany}
                        title={tooMany ? `Only ${left} days of ${mainLabel.toLowerCase()} are left` : undefined}
                        onClick={() => decide(r, 'Approved')}
                      >
                        Approve
                      </button>
                      <button type="button" className={btnSmall} onClick={() => decide(r, 'Rejected')}>
                        Reject
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <div className="mt-5">
        <h3 className="text-[12px] font-bold uppercase tracking-[0.06em] text-slate">Notifications</h3>
        {!notes.length ? (
          <p className="mt-2 text-[13.5px] text-slate">Nothing recorded yet.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {notes.map(n => (
              <li key={n.id} className="text-[13.5px] text-ink-2">
                {n.text} <span className="text-[12px] text-slate">· {n.when}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function Box({ big, small }: { big: string; small: string }) {
  return (
    <div className="rounded-[12px] bg-canvas px-4 py-3">
      <div className="text-[18px] font-extrabold text-ink">{big}</div>
      <div className="text-[12px] text-slate">{small}</div>
    </div>
  )
}
