import { useEffect, useState } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSendAsync } from '../../api/queries'
import { avatarOf } from '../../api/people/avatar'
import { sha256 } from '../../api/session/signIn'
import { isClientRole, ROLE_LABEL } from '../../api/session/access'
import { writeSession } from '../../api/session/store'
import type { NotifPrefs, Person, Session } from '../../api/types'

const TIME_ZONES = ['Europe/Oslo', 'Europe/Stockholm', 'Europe/London', 'Asia/Kolkata', 'America/New_York'] as const
const DEFAULT_TZ = 'Europe/Oslo'

const NOTIFICATIONS: { key: keyof NotifPrefs; label: string; sub: string }[] = [
  { key: 'tickets', label: 'Ticket assigned to me', sub: 'When someone assigns or mentions you' },
  { key: 'due', label: 'Due date reminders', sub: 'The day before a ticket is due' },
  { key: 'questions', label: 'Client replies', sub: 'When a client answers a question' },
  { key: 'weekly', label: 'Weekly timesheet reminder', sub: 'Fridays at 15:00 if hours are missing' },
]

const schema = z
  .object({
    name: z.string().trim().min(1, 'Add your name'),
    phone: z.string().trim(),
    tz: z.enum(TIME_ZONES),
    notif: z.object({ tickets: z.boolean(), due: z.boolean(), questions: z.boolean(), weekly: z.boolean() }),
    pw1: z.string(),
    pw2: z.string(),
  })
  .superRefine((v, ctx) => {
    if (!v.pw1 && !v.pw2) return
    if (v.pw1 !== v.pw2) ctx.addIssue({ code: 'custom', path: ['pw2'], message: 'Passwords do not match' })
    else if (v.pw1.length < 8) ctx.addIssue({ code: 'custom', path: ['pw1'], message: 'Password needs at least 8 characters' })
  })

type Form = z.infer<typeof schema>

const field = 'h-[38px] w-full rounded-[9px] border-[1.5px] border-line bg-white px-3 text-[13.5px] text-ink outline-0 focus:border-blue'
const label = 'mb-1.5 block text-[12px] font-bold text-ink-2'

interface Props {
  session: Session
  person: Person | undefined
  onClose: () => void
}

/** Profile settings: name, phone, time zone, notifications and password. Saves to the session and the directory. */
export function ProfileModal({ session, person, onClose }: Props) {
  const send = useSendAsync()
  const [saveError, setSaveError] = useState<string | null>(null)
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: session.name,
      phone: session.phone ?? '',
      tz: (TIME_ZONES as readonly string[]).includes(session.tz ?? '') ? (session.tz as Form['tz']) : DEFAULT_TZ,
      notif: { tickets: true, due: true, questions: true, weekly: true, ...session.notif },
      pw1: '',
      pw2: '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const message = saveError ?? errors.name?.message ?? errors.pw2?.message ?? errors.pw1?.message ?? ''
  const avatar = avatarOf(person ?? { name: session.name, colour: '#1B2D45', photo: '' }, { showPhoto: !isClientRole(session.role) })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const onSubmit = form.handleSubmit(async v => {
    setSaveError(null)
    let pwHash: string | undefined
    if (v.pw1) {
      try {
        pwHash = await sha256(v.pw1)
      } catch {
        setSaveError('Passwords can only be changed on https or localhost.')
        return
      }
    }
    const patch = { name: v.name, phone: v.phone, tz: v.tz, notif: v.notif, ...(pwHash ? { pwHash } : {}) }
    try {
      await send({ type: 'profile.update', id: session.personId, patch })
    } catch {
      setSaveError('Your changes could not be saved. Try again.')
      return
    }
    writeSession({ ...session, name: v.name, phone: v.phone, tz: v.tz, notif: v.notif })
    onClose()
  })

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-[rgba(27,45,69,0.42)]" onClick={onClose} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-title"
        className="fixed left-1/2 top-1/2 z-[71] max-h-[calc(100vh-40px)] w-[min(620px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[22px] border-[1.5px] border-line bg-white px-[26px] py-6 shadow-[0_30px_90px_rgba(27,45,69,0.3)]"
      >
        <form onSubmit={onSubmit} noValidate>
          <div className="flex items-center gap-3.5">
            <span
              className="grid size-[52px] flex-none place-items-center rounded-[13px] bg-cover bg-center text-[18px] font-bold text-white"
              style={{ background: avatar.photo ? `url("${avatar.photo}") center / cover` : avatar.colour }}
            >
              {avatar.photo ? null : avatar.initials}
            </span>
            <div className="min-w-0">
              <div id="profile-title" className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-blue-ink">
                Profile settings
              </div>
              <div className="mt-0.5 truncate text-[20px] font-extrabold">{session.name}</div>
              <div className="mt-0.5 text-[13px] text-muted">{`${ROLE_LABEL[session.role]} · ${session.org}`}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              aria-label="Close"
              className="ml-auto grid size-8 flex-none place-items-center rounded-lg border border-rust-line bg-rust-soft text-rust"
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          <div className="mt-5 text-[14px] font-extrabold">Personal details</div>
          <div className="mt-2.5 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <label>
              <span className={label}>Full name</span>
              <input className={field} {...form.register('name')} />
            </label>
            <label>
              <span className={label}>Email</span>
              <input className={`${field} bg-canvas text-muted`} value={session.email} readOnly />
            </label>
            <label>
              <span className={label}>Phone</span>
              <input className={field} placeholder="+47 …" {...form.register('phone')} />
            </label>
            <label>
              <span className={label}>Time zone</span>
              <select className={`${field} cursor-pointer`} {...form.register('tz')}>
                {TIME_ZONES.map(z => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="mt-5 text-[14px] font-extrabold">Notifications</div>
          <div className="mt-2 flex flex-col gap-1.5">
            <Controller
              control={form.control}
              name="notif"
              render={({ field: notif }) => (
                <>
                  {NOTIFICATIONS.map(n => {
                    const on = notif.value[n.key]
                    return (
                      <button
                        type="button"
                        key={n.key}
                        role="switch"
                        aria-checked={on}
                        onClick={() => notif.onChange({ ...notif.value, [n.key]: !on })}
                        className="flex items-center gap-3 rounded-[10px] bg-canvas px-3 py-2.5 text-left"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13.5px] font-semibold text-ink">{n.label}</span>
                          <span className="block text-[12px] text-muted">{n.sub}</span>
                        </span>
                        <span className="relative h-[22px] w-[38px] flex-none rounded-full transition-colors" style={{ background: on ? '#4870E8' : '#C9D2DD' }}>
                          <span
                            className="absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-[left]"
                            style={{ left: on ? 19 : 3 }}
                          />
                        </span>
                      </button>
                    )
                  })}
                </>
              )}
            />
          </div>

          <div className="mt-5 text-[14px] font-extrabold">Change password</div>
          <div className="mt-2.5 grid grid-cols-2 gap-3 max-[560px]:grid-cols-1">
            <label>
              <span className={label}>New password</span>
              <input type="password" className={field} placeholder="At least 8 characters" autoComplete="new-password" {...form.register('pw1')} />
            </label>
            <label>
              <span className={label}>Repeat password</span>
              <input type="password" className={field} autoComplete="new-password" {...form.register('pw2')} />
            </label>
          </div>

          <div className="mt-5 flex items-center gap-2.5">
            <span className="min-w-0 flex-1 text-[12.5px] font-semibold text-red" role="status">
              {message}
            </span>
            <button type="button" onClick={onClose} className="h-10 rounded-[10px] border-[1.5px] border-faint bg-white px-4 text-[13.5px] font-semibold text-ink">
              Cancel
            </button>
            <button type="submit" disabled={isSubmitting} className="h-10 rounded-[10px] bg-blue px-5 text-[13.5px] font-bold text-white disabled:opacity-60">
              Save changes
            </button>
          </div>
        </form>
      </div>
    </>
  )
}
