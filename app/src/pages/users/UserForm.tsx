import { apiMode } from '../../api/http/config'
import { RefusedError } from '../../api/server'
import { useMemo, useState, type ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSendAsync } from '../../api/queries'
import { ROLE_LABEL } from '../../api/session/access'
import { writeSession } from '../../api/session/store'
import type { Company, InternalProject, Person, Role, Session } from '../../api/types'
import { projectPool, projectsToSave, isClientPerson } from '../../api/users/derive'
import {
  CLIENT_PERSON_COLOUR,
  EMAIL_RE,
  NEW_PERSON_COLOURS,
  ROLE_ORDER,
  isClientRoleKey,
} from '../../api/users/access'
import { useToast } from '../shell/toast'
import { Dialog, btnDanger, btnGhost, btnPrimary, btnSmall, field, label, PersonAvatar } from './ui'

const MAX_PHOTO_BYTES = 1_000_000

interface Props {
  /** Undefined for a new person. */
  person?: Person
  /** 'colleagues' is the client admin's view: one company, client roles only. */
  scope: 'all' | 'colleagues'
  session: Session
  people: Person[]
  companies: Company[]
  internal: InternalProject[]
  /** Whether `companies` and `internal` have loaded; until then saving keeps the person's projects as they are. */
  projectsLoaded?: boolean
  devTypes: string[]
  onClose: () => void
}

type Access = 'all' | 'pick'

/** The form's values. `photo` undefined means the built-in face, '' no photo, otherwise a data URL. */
interface Values {
  name: string
  email: string
  role: string
  company: string
  devType: string
  emp: 'employee' | 'freelancer'
  photo?: string
  access: Access
  projects: string[]
  active: boolean
}

/** A free person id for the mock: one past the largest numeric id. */
const nextPersonId = (people: Person[]) => String(Math.max(0, ...people.map(p => Number(p.id)).filter(Number.isFinite)) + 1)

/** Add or edit a person. A new person is always Invited: nothing is sent and they cannot sign in until an admin activates them. */
export function UserForm({ person, scope, session, people, companies, internal, projectsLoaded = true, devTypes, onClose }: Props) {
  const send = useSendAsync()
  const show = useToast()
  const isNew = !person
  const isSelf = !!person && person.id === session.personId
  const colleagues = scope === 'colleagues'
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [photoError, setPhotoError] = useState<string | null>(null)
  const [newType, setNewType] = useState<string | null>(null)
  const [pq, setPq] = useState('')

  /** Who may be picked as a role: client admins only client roles; admins not super admin. */
  const roles: Role[] = colleagues
    ? ['cadmin', 'cuser']
    : ROLE_ORDER.filter(r => r !== 'super' || session.role === 'super')
  const fixedCompany = colleagues ? session.orgId ?? '' : ''
  const liveCompanies = companies.filter(c => !c.archived)

  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, 'Add a name'),
          email: z.string().trim().regex(EMAIL_RE, 'Enter a valid email'),
          role: z.string(),
          company: z.string(),
          devType: z.string(),
          emp: z.enum(['employee', 'freelancer']),
          photo: z.string().optional(),
          access: z.enum(['all', 'pick']),
          projects: z.array(z.string()),
          active: z.boolean(),
        })
        .superRefine((v, ctx) => {
          if (isClientRoleKey(v.role as Role) && !v.company) {
            ctx.addIssue({ code: 'custom', path: ['company'], message: 'Choose a company first.' })
          }
          const e = v.email.trim().toLowerCase()
          if (people.some(p => p.id !== person?.id && p.email.toLowerCase() === e)) {
            ctx.addIssue({ code: 'custom', path: ['email'], message: 'Another person already uses this email.' })
          }
        }),
    [people, person?.id],
  )

  const initial: Values = person
    ? {
        name: person.name,
        email: person.email,
        role: person.role,
        company: isClientPerson(person) ? person.org : '',
        devType: person.devType ?? '',
        emp: person.emp ?? 'employee',
        photo: person.photo,
        access: person.projects === 'all' ? 'all' : 'pick',
        projects: person.projects === 'all' ? [] : [...person.projects],
        active: person.active,
      }
    : {
        name: '',
        email: '',
        role: colleagues ? 'cuser' : 'dev',
        company: fixedCompany,
        devType: '',
        emp: 'employee',
        photo: undefined,
        access: 'all',
        projects: [],
        active: false,
      }

  const { register, handleSubmit, watch, setValue, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: initial,
  })
  const v = watch()
  const client = isClientRoleKey(v.role as Role)
  const pool = client && !v.company ? [] : projectPool(companies, internal, client ? v.company : undefined)
  const shownPool = pq.trim() ? pool.filter(p => (p.name + ' ' + p.company).toLowerCase().includes(pq.trim().toLowerCase())) : pool
  const title = isNew ? 'Add a user' : person.name

  const setPick = (id: string, on: boolean) => {
    const cur = v.projects
    setValue('projects', on ? [...new Set([...cur, id])] : cur.filter(x => x !== id), { shouldDirty: true })
  }

  const onPhoto = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!file.type.startsWith('image/')) return setPhotoError('Choose an image file.')
    if (file.size > MAX_PHOTO_BYTES) return setPhotoError('Choose a photo under 1 MB.')
    setPhotoError(null)
    const reader = new FileReader()
    reader.onload = () => setValue('photo', String(reader.result), { shouldDirty: true })
    reader.readAsDataURL(file)
  }

  const addDevType = async () => {
    const name = (newType ?? '').trim()
    if (!name) return
    const existing = devTypes.find(d => d.toLowerCase() === name.toLowerCase())
    if (!existing) await send({ type: 'access.addDevType', name })
    setValue('devType', existing ?? name, { shouldDirty: true })
    setNewType(null)
  }

  const onSubmit = handleSubmit(async values => {
    setFormError(null)
    const isClient = isClientRoleKey(values.role as Role)
    const org = isClient ? values.company : 'vt'
    const allowed = projectPool(companies, internal, isClient ? values.company : undefined).map(p => p.id)
    const projects: 'all' | string[] = values.access === 'all' ? 'all' : projectsToSave(values.projects, allowed, projectsLoaded)
    const role = values.role as Role
    const shared = {
      name: values.name.trim(),
      email: values.email.trim(),
      role,
      org,
      projects,
      devType: isClient ? undefined : values.devType || undefined,
      emp: isClient ? undefined : values.emp,
      photo: isClient ? person?.photo : values.photo,
    }
    try {
      if (!person) {
        const id = nextPersonId(people)
        const result = await send({
          type: 'user.create',
          person: {
            ...shared,
            id,
            colour: isClient ? CLIENT_PERSON_COLOUR : NEW_PERSON_COLOURS[Number(id) % NEW_PERSON_COLOURS.length],
            active: false,
            invited: true,
            last: 'Invited',
          },
        })
        show(result?.notice ?? (apiMode ? `Invited ${shared.name}. They get an email to set their password.` : `Invited ${shared.name}. No email is sent yet.`))
        onClose()
        return
      }
      // Your own role and active flag can't be changed from here.
      const self = person.id === session.personId
      const active = self ? person.active : values.active
      const activating = !self && values.active && !!person.invited
      await send({
        type: 'user.update',
        id: person.id,
        patch: {
          ...shared,
          active,
          ...(activating ? { invited: false, last: 'Not signed in yet' } : {}),
        },
      })
      if (self) writeSession({ ...session, name: shared.name, email: shared.email })
      show(`Saved ${shared.name}.`)
      onClose()
    } catch (err) {
      setFormError(err instanceof RefusedError ? err.message : 'The change could not be saved. Try again.')
    }
  })

  const remove = async () => {
    if (!person) return
    try {
      await send({ type: 'user.remove', id: person.id })
      show(`Removed ${person.name}. Their time entries and ticket history are kept.`)
      onClose()
    } catch (err) {
      setFormError(err instanceof RefusedError ? err.message : 'The person could not be removed. Try again.')
      setConfirmRemove(false)
    }
  }

  if (confirmRemove && person) {
    return (
      <Dialog titleId="remove-title" onClose={onClose} width={460}>
        <h2 id="remove-title" className="text-[20px] font-extrabold text-ink">
          Remove {person.name}?
        </h2>
        <p className="mt-2 text-[14px] leading-[1.55] text-ink-2">
          They lose access and leave this list. Their time entries and ticket history stay in place.
        </p>
        {formError && <p role="alert" className="mt-3 text-[13px] font-semibold text-red">{formError}</p>}
        <div className="mt-6 flex justify-end gap-2.5">
          <button type="button" className={btnGhost} onClick={() => setConfirmRemove(false)}>
            Cancel
          </button>
          <button type="button" className={btnDanger} onClick={remove}>
            Remove user
          </button>
        </div>
      </Dialog>
    )
  }

  const err = formState.errors
  const pickedNames = v.projects.map(id => pool.find(p => p.id === id)?.name ?? id)

  return (
    <Dialog titleId="user-form-title" onClose={onClose}>
      <form onSubmit={onSubmit} noValidate>
        <p className="text-[11.5px] font-bold uppercase tracking-[0.08em] text-slate">{isNew ? 'New user' : 'Edit user'}</p>
        <div className="mt-1 flex items-center gap-3">
          {!isNew && <PersonAvatar person={{ ...person, photo: v.photo }} size={48} showPhoto={!client} />}
          <h2 id="user-form-title" className="text-[22px] font-extrabold tracking-[-0.01em] text-ink">
            {title}
          </h2>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2">
          <label className="sm:col-span-1">
            <span className={label}>Full name *</span>
            <input className={field} placeholder="e.g. Kari Berg" aria-invalid={!!err.name} {...register('name')} />
            {err.name && <span className="mt-1 block text-[12px] font-semibold text-red">{err.name.message}</span>}
          </label>
          <label>
            <span className={label}>Email *</span>
            <input className={field} placeholder="name@company.com" aria-invalid={!!err.email} {...register('email')} />
            {err.email && <span className="mt-1 block text-[12px] font-semibold text-red">{err.email.message}</span>}
          </label>

          <label>
            <span className={label}>Role</span>
            <select className={field} disabled={isSelf} {...register('role')}>
              {roles.map(r => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            {isSelf && <span className="mt-1 block text-[12px] text-slate">You can't change your own role here.</span>}
          </label>

          {client && !colleagues && (
            <label>
              <span className={label}>Company *</span>
              <select className={field} aria-invalid={!!err.company} {...register('company')}>
                <option value="">Choose a company</option>
                {liveCompanies.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {err.company && <span className="mt-1 block text-[12px] font-semibold text-red">{err.company.message}</span>}
            </label>
          )}

          {!client && (
            <>
              <div>
                <span className={label}>
                  User type <span className="font-normal text-slate">(optional)</span>
                </span>
                <div className="flex gap-2">
                  <select className={`${field} flex-1`} aria-label="User type" {...register('devType')}>
                    <option value="">None</option>
                    {devTypes.map(d => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                  {newType === null ? (
                    <button type="button" className={btnSmall} onClick={() => setNewType('')}>
                      + Add
                    </button>
                  ) : null}
                </div>
                {newType !== null && (
                  <div className="mt-2 flex gap-2">
                    <input
                      className={field}
                      aria-label="New developer type"
                      placeholder="e.g. Data"
                      value={newType}
                      onChange={e => setNewType(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void addDevType()
                        }
                      }}
                    />
                    <button type="button" className={btnSmall} onClick={() => void addDevType()}>
                      Add type
                    </button>
                  </div>
                )}
              </div>

              <fieldset>
                <legend className={label}>Employment</legend>
                <div className="flex h-[38px] items-center gap-4 text-[13.5px] text-ink">
                  <label className="flex items-center gap-1.5">
                    <input type="radio" value="employee" {...register('emp')} /> Employee
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="radio" value="freelancer" {...register('emp')} /> Freelancer
                  </label>
                </div>
              </fieldset>
            </>
          )}
        </div>

        {!client && (
          <div className="mt-5">
            <span className={label}>Profile photo</span>
            <div className="flex flex-wrap items-center gap-3">
              <PersonAvatar
                person={{ name: v.name || 'New user', colour: isNew ? NEW_PERSON_COLOURS[0] : person.colour, photo: v.photo }}
                size={52}
              />
              <label className={`${btnSmall} cursor-pointer`}>
                Change photo
                <input type="file" accept="image/*" className="sr-only" onChange={onPhoto} aria-label="Change photo" />
              </label>
              <button type="button" className={btnSmall} onClick={() => setValue('photo', '', { shouldDirty: true })}>
                Remove
              </button>
            </div>
            <p className="mt-1.5 text-[12px] text-slate">Shown to the Viljetech team only. Clients always see initials.</p>
            {photoError && <p className="mt-1 text-[12px] font-semibold text-red">{photoError}</p>}
          </div>
        )}

        <div className="mt-5">
          <span className={label}>Project access</span>
          <div className="flex flex-wrap gap-4 text-[13.5px] text-ink">
            <label className="flex items-center gap-1.5">
              <input type="radio" value="all" {...register('access')} />
              {client ? 'All company projects' : 'All projects, including new ones'}
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" value="pick" {...register('access')} /> Choose projects
            </label>
          </div>
          {v.role === 'super' && (
            <p className="mt-1.5 text-[12px] text-slate">Super admins always have access to every project, including new ones.</p>
          )}
          {v.access === 'pick' && (
            <div className="mt-2.5 rounded-[12px] border-[1.5px] border-line-2 p-3">
              <input className={field} placeholder="Search projects" aria-label="Search projects" value={pq} onChange={e => setPq(e.target.value)} />
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {shownPool.map(p => {
                  const on = v.projects.includes(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPick(p.id, !on)}
                      className={`rounded-full border-[1.5px] px-3 py-1 text-[12.5px] font-semibold ${
                        on ? 'border-blue bg-sky-2 text-blue-ink' : 'border-line bg-white text-ink-2 hover:border-blue'
                      }`}
                    >
                      {p.name} <span className="font-normal text-slate">· {p.company}</span>
                    </button>
                  )
                })}
              </div>
              {!shownPool.length && (
                <p className="mt-2 text-[12.5px] text-slate">
                  {pq.trim() ? 'No projects match your search.' : client ? 'This company has no projects yet.' : 'No projects yet.'}
                </p>
              )}
              {pickedNames.length > 0 && <p className="mt-2 text-[12px] text-slate">Selected: {pickedNames.join(', ')}</p>}
            </div>
          )}
        </div>

        {!isNew && (
          <div className="mt-5 flex items-start justify-between gap-4 rounded-[12px] border-[1.5px] border-line-2 p-3.5">
            <div>
              <div className="text-[13.5px] font-bold text-ink">Account active</div>
              <p className="mt-0.5 text-[12px] text-slate">
                {person.invited
                  ? 'Turning this on activates the invited account.'
                  : "Deactivated users can't sign in. Their history is kept."}
              </p>
              {isSelf && <p className="mt-0.5 text-[12px] text-slate">You can't deactivate your own account.</p>}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={v.active}
              aria-label="Account active"
              disabled={isSelf}
              onClick={() => setValue('active', !v.active, { shouldDirty: true })}
              className={`relative h-6 w-11 flex-none rounded-full transition-colors disabled:opacity-50 ${v.active ? 'bg-green' : 'bg-faint'}`}
            >
              <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] ${v.active ? 'left-[22px]' : 'left-0.5'}`} />
            </button>
          </div>
        )}

        {formError && <p role="alert" className="mt-4 text-[13px] font-semibold text-red">{formError}</p>}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {!isNew && !isSelf ? (
            <button type="button" className={btnDanger} onClick={() => setConfirmRemove(true)}>
              Remove user
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2.5">
            <button type="button" className={btnGhost} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={btnPrimary} disabled={formState.isSubmitting}>
              {isNew ? 'Send invite' : 'Save changes'}
            </button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
