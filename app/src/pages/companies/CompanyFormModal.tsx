import { useEffect, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import { useCompanies, useSendAsync } from '../../api/queries'
import type { Company } from '../../api/types'
import { newId, normalizeWebsite } from '../../domain/ids'
import { Dialog, btnPrimary, btnSecondary, errorCls, fieldCls, labelCls } from '../../components/Dialog'
import { LogoField } from './LogoField'

/** A website is a domain, with an optional path, after any http(s):// is removed. */
const isWebsite = (v: string) => !v || /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(normalizeWebsite(v))
const isEmail = (v: string) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)

const schema = z.object({
  name: z.string().trim().min(1, 'Add a company name'),
  industry: z.string().trim(),
  country: z.string().trim(),
  web: z.string().trim().refine(isWebsite, 'Enter a website such as daco.no'),
  contactName: z.string().trim(),
  contactEmail: z.string().trim().refine(isEmail, 'Enter an email such as name@company.com'),
  notes: z.string(),
  logo: z.string(),
})
type Form = z.infer<typeof schema>

/**
 * Create or edit a company. Every field can be changed after creation
 * (decision 6). `focus` puts the cursor in one field, for "+ Website".
 */
export function CompanyFormModal({
  mode,
  company,
  focus,
  onClose,
}: {
  mode: 'create' | 'edit'
  company?: Company
  focus?: 'web'
  onClose: () => void
}) {
  const navigate = useNavigate()
  const send = useSendAsync()
  const companies = useCompanies().data ?? []
  const [saveError, setSaveError] = useState<string | null>(null)
  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: company?.name ?? '',
      industry: company?.industry ?? '',
      country: company?.country ?? '',
      web: company?.web ?? '',
      contactName: company?.contacts[0]?.name ?? '',
      contactEmail: company?.contacts[0]?.email ?? '',
      notes: company?.notes ?? '',
      logo: company?.logo ?? '',
    },
  })
  const { errors, isSubmitting } = form.formState
  const shownError = saveError ?? errors.name?.message ?? errors.web?.message ?? errors.contactEmail?.message ?? ''

  useEffect(() => {
    if (focus) form.setFocus(focus)
    // Focus once, when the window opens.
  }, [])

  const onSubmit = form.handleSubmit(async v => {
    setSaveError(null)
    const fields = {
      name: v.name,
      industry: v.industry,
      country: v.country,
      web: normalizeWebsite(v.web),
      notes: v.notes,
      logo: v.logo,
    }
    try {
      if (mode === 'create') {
        const id = newId('c')
        const created: Company = {
          id,
          ...fields,
          p: companies.length,
          contacts: v.contactName
            ? [{ personId: null, name: v.contactName, role: 'Main contact', email: v.contactEmail, projects: [] }]
            : [],
          projects: [],
          ourRoles: {},
          archived: false,
          archivedAt: null,
        }
        await send({ type: 'company.create', company: created })
        onClose()
        navigate(`/companies/${id}`)
        return
      }
      if (!company) return
      await send({
        type: 'company.update',
        id: company.id,
        patch: fields,
        main: { name: v.contactName, email: v.contactEmail },
      })
      onClose()
    } catch {
      setSaveError('The company could not be saved. Try again.')
    }
  })

  const title = mode === 'create' ? 'Add a company' : 'Edit company'
  return (
    <Dialog titleId="company-form-title" eyebrow={mode === 'create' ? 'New company' : company?.name} title={title} onClose={onClose} width={640}>
      <form onSubmit={onSubmit} noValidate className="mt-5">
        <div className="grid grid-cols-2 gap-3.5 max-[600px]:grid-cols-1">
          <label className="col-span-2 max-[600px]:col-span-1">
            <span className={labelCls}>Company name *</span>
            <input className={fieldCls} autoFocus={mode === 'create'} {...form.register('name')} />
          </label>
          <label>
            <span className={labelCls}>Industry</span>
            <input className={fieldCls} {...form.register('industry')} />
          </label>
          <label>
            <span className={labelCls}>Country</span>
            <input className={fieldCls} {...form.register('country')} />
          </label>
          <label>
            <span className={labelCls}>Website</span>
            <input className={fieldCls} placeholder="daco.no" {...form.register('web')} />
          </label>
          <div>
            <span className={labelCls}>Company logo</span>
            <Controller
              control={form.control}
              name="logo"
              render={({ field }) => (
                <LogoField name={form.watch('name')} p={company?.p ?? companies.length} value={field.value} onChange={field.onChange} size={48} />
              )}
            />
          </div>
          <label>
            <span className={labelCls}>Main contact</span>
            <input className={fieldCls} {...form.register('contactName')} />
          </label>
          <label>
            <span className={labelCls}>Contact email</span>
            <input className={fieldCls} type="email" {...form.register('contactEmail')} />
          </label>
          <label className="col-span-2 max-[600px]:col-span-1">
            <span className={labelCls}>Notes</span>
            <textarea className={`${fieldCls} h-auto min-h-[84px] py-2`} {...form.register('notes')} />
          </label>
        </div>
        <div className="mt-5 flex items-center gap-2.5">
          <span role="status" className={`min-w-0 flex-1 ${errorCls}`}>
            {shownError}
          </span>
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting} className={btnPrimary}>
            {mode === 'create' ? 'Create company' : 'Save changes'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
