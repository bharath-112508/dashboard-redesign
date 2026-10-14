import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSendAsync } from '../../api/queries'
import type { ClientProject, CompanyContact } from '../../api/types'
import { Dialog, btnPrimary, btnSecondary, errorCls, fieldCls, labelCls } from '../../components/Dialog'
import { useToast } from '../shell/toast'

const schema = z.object({
  name: z.string().trim().min(1, 'Add a name'),
  role: z.string().trim(),
  email: z
    .string()
    .trim()
    .refine(v => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter an email such as name@company.com'),
  admin: z.boolean(),
  projects: z.array(z.string()),
})
type Form = z.infer<typeof schema>

/** Add or edit a client contact of a company, with the company's projects they work on. */
export function ContactDialog({
  companyId,
  projects,
  contact,
  index,
  onClose,
}: {
  companyId: string
  projects: ClientProject[]
  /** The contact being edited, or null when adding. */
  contact: CompanyContact | null
  index: number | null
  onClose: () => void
}) {
  const send = useSendAsync()
  const show = useToast()
  const [saveError, setSaveError] = useState<string | null>(null)
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: contact?.name ?? '',
      role: contact?.role ?? '',
      email: contact?.email ?? '',
      admin: contact?.admin ?? false,
      projects: contact?.projects ?? [],
    },
  })
  const { errors, isSubmitting } = form.formState
  const admin = form.watch('admin')
  const chosen = form.watch('projects')
  const message = saveError ?? errors.name?.message ?? errors.email?.message ?? ''

  const toggleProject = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter(x => x !== id) : [...chosen, id]
    form.setValue('projects', next, { shouldDirty: true })
  }

  const onSubmit = form.handleSubmit(async v => {
    setSaveError(null)
    try {
      const result = await send({
        type: 'company.contact.save',
        companyId,
        index,
        contact: { personId: contact?.personId ?? null, name: v.name, role: v.role, email: v.email, projects: v.projects, admin: v.admin },
      })
      onClose()
      if (result?.notice) show(result.notice)
    } catch {
      setSaveError('The contact could not be saved. Try again.')
    }
  })

  const remove = async () => {
    if (index === null) return
    setSaveError(null)
    try {
      await send({ type: 'company.contact.remove', companyId, index, personId: contact?.personId ?? null })
      onClose()
    } catch {
      setSaveError('The contact could not be removed. Try again.')
    }
  }

  return (
    <Dialog titleId="contact-title" eyebrow="Client contact" title={contact ? 'Edit contact' : 'Add a client contact'} onClose={onClose}>
      <form onSubmit={onSubmit} noValidate className="mt-5">
        <div className="grid grid-cols-2 gap-3.5 max-[600px]:grid-cols-1">
          <label>
            <span className={labelCls}>Name *</span>
            <input placeholder="e.g. Ingrid Solberg" className={fieldCls} autoFocus {...form.register('name')} />
          </label>
          <label>
            <span className={labelCls}>Role</span>
            <input className={fieldCls} placeholder="CTO, product owner…" {...form.register('role')} />
          </label>
          <label className="col-span-2 max-[600px]:col-span-1">
            <span className={labelCls}>Email</span>
            <input placeholder="name@company.com" className={fieldCls} type="email" {...form.register('email')} />
          </label>
        </div>

        <div className="mt-4 flex items-center gap-3 rounded-[10px] bg-canvas px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <span className="block text-[13.5px] font-semibold">Admin in client portal</span>
            <span className="block text-[12px] text-muted">{admin ? 'Admins see everything on their projects.' : 'Sees only the projects chosen below.'}</span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={admin}
            aria-label="Admin in client portal"
            onClick={() => form.setValue('admin', !admin, { shouldDirty: true })}
            className="relative h-[22px] w-[38px] flex-none cursor-pointer rounded-full transition-colors"
            style={{ background: admin ? '#4870E8' : '#C9D2DD' }}
          >
            <span className="absolute top-[3px] size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.2)] transition-[left]" style={{ left: admin ? 19 : 3 }} />
          </button>
        </div>

        <div className="mt-4">
          <span className={labelCls}>Projects</span>
          {projects.length === 0 ? (
            <p className="m-0 text-[12.5px] text-muted">This company has no projects yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {projects.map(p => {
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
          {contact && index !== null ? (
            <button type="button" onClick={remove} className="h-10 cursor-pointer rounded-[10px] px-2 text-[13.5px] font-semibold text-red hover:underline">
              Remove
            </button>
          ) : null}
          <span role="status" className={`min-w-0 flex-1 text-right ${errorCls}`}>
            {message}
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
