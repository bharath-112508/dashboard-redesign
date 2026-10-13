import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSendAsync } from '../../api/queries'
import type { Company, CompanyRole, Person } from '../../api/types'
import { COMPANY_ROLES, PERMISSIONS, ROLE_INFO } from '../../domain/projects'
import { Dialog, btnPrimary, btnSecondary, errorCls, fieldCls, labelCls } from '../../components/Dialog'
import { PersonDot } from '../../components/Bits'

const schema = z.object({
  role: z.enum(['Super admin', 'Admin', 'Developer', 'Viewer']),
  projects: z.array(z.string()),
})
type Form = z.infer<typeof schema>

/**
 * Add or edit a person from Viljetech who is responsible for a company. Their
 * membership in the chosen projects is set on save; removing them takes them
 * off every project and drops their role.
 */
export function ResponsibleDialog({
  company,
  people,
  personId,
  onClose,
}: {
  company: Company
  /** Active Viljetech people, the only ones who can be added. */
  people: Person[]
  /** The person being edited, or null when adding. */
  personId: string | null
  onClose: () => void
}) {
  const send = useSendAsync()
  const [picked, setPicked] = useState<string | null>(personId)
  const [pickError, setPickError] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const current = personId !== null ? people.find(p => p.id === personId) : undefined
  const editing = personId !== null
  const taken = (id: string) => !editing && company.ourRoles[id] !== undefined

  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      role: (personId !== null ? company.ourRoles[personId] : undefined) ?? 'Developer',
      projects: company.projects.filter(p => personId !== null && p.team.includes(personId)).map(p => p.id),
    },
  })
  const { isSubmitting } = form.formState
  const role = form.watch('role') as CompanyRole
  const chosen = form.watch('projects')
  const info = ROLE_INFO[role]

  const toggleProject = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]
    form.setValue('projects', next, { shouldDirty: true })
  }

  const onSubmit = form.handleSubmit(async v => {
    if (picked === null) {
      setPickError(true)
      return
    }
    setSaveError(null)
    try {
      await send({ type: 'company.responsible.save', companyId: company.id, personId: picked, role: v.role, projects: v.projects })
      onClose()
    } catch {
      setSaveError('The responsibility could not be saved. Try again.')
    }
  })

  const remove = async () => {
    if (personId === null) return
    setSaveError(null)
    try {
      await send({ type: 'company.responsible.remove', companyId: company.id, personId })
      onClose()
    } catch {
      setSaveError('The responsibility could not be removed. Try again.')
    }
  }

  return (
    <Dialog
      titleId="responsible-title"
      eyebrow="Responsible from Viljetech"
      title={editing ? 'Edit responsibility' : 'Add someone responsible'}
      onClose={onClose}
    >
      <form onSubmit={onSubmit} noValidate className="mt-5">
        <div>
          <span className={labelCls}>Person *</span>
          {editing ? (
            <div className="flex items-center gap-2.5 text-[14px] font-semibold">
              {current && <PersonDot name={current.name} colour={current.colour} size={28} />}
              {current?.name ?? 'Unknown person'}
            </div>
          ) : (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Person">
              {people.map(p => {
                const on = picked === p.id
                const disabled = taken(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    disabled={disabled}
                    aria-pressed={on}
                    onClick={() => {
                      setPicked(p.id)
                      setPickError(false)
                    }}
                    className={`inline-flex items-center gap-2 rounded-full border-[1.5px] py-1 pl-1 pr-3 text-[12.5px] font-semibold ${
                      on ? 'border-blue bg-sky-3 text-blue-ink' : 'border-line bg-white text-ink-2'
                    } disabled:cursor-default disabled:opacity-45`}
                    title={disabled ? 'Already responsible for this company' : undefined}
                  >
                    <PersonDot name={p.name} colour={p.colour} size={22} />
                    {p.name}
                  </button>
                )
              })}
            </div>
          )}
          {pickError && <p className={`mt-1.5 ${errorCls}`}>Pick a person</p>}
        </div>

        <div className="mt-4 grid grid-cols-[180px_1fr] gap-4 max-[600px]:grid-cols-1">
          <label>
            <span className={labelCls}>Role &amp; access</span>
            <select className={`${fieldCls} cursor-pointer`} {...form.register('role')}>
              {COMPANY_ROLES.map(r => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <div className="rounded-[10px] bg-canvas px-3 py-2.5">
            <p className="m-0 text-[12.5px] text-muted">{info.desc}</p>
            <ul className="m-0 mt-2 list-none p-0 text-[12px]">
              {PERMISSIONS.map((perm, i) => (
                <li key={perm} className="flex gap-2 py-0.5">
                  <span className={info.perms[i] ? 'font-bold text-green' : 'text-faint'} aria-hidden="true">
                    {info.perms[i] ? '✓' : '–'}
                  </span>
                  <span className={info.perms[i] ? 'text-ink' : 'text-muted'}>{perm}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Projects</span>
          {company.projects.length === 0 ? (
            <p className="m-0 text-[12.5px] text-muted">This company has no projects yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {company.projects.map(p => {
                const on = chosen.includes(p.id)
                return (
                  <button
                    key={p.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleProject(p.id)}
                    className={`cursor-pointer rounded-full border-[1.5px] px-3 py-1 text-[12.5px] font-semibold ${on ? 'border-blue bg-sky-3 text-blue-ink' : 'border-line bg-white text-ink-2'}`}
                  >
                    {p.name}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div className="mt-5 flex items-center gap-2.5">
          {editing && (
            <button type="button" onClick={remove} className="h-10 cursor-pointer rounded-[10px] px-2 text-[13.5px] font-semibold text-red hover:underline">
              Remove
            </button>
          )}
          <span role="status" className={`min-w-0 flex-1 text-right ${errorCls}`}>
            {saveError}
          </span>
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting} className={btnPrimary}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
