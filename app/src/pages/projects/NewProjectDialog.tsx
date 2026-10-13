import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useCompanies, useSendAsync } from '../../api/queries'
import { usePeople } from '../../api/people/directory'
import { useSession } from '../../api/session/store'
import type { ClientProject, InternalProject, ProjectRef, ProjectState } from '../../api/types'
import { newId } from '../../domain/ids'
import { AREAS, stateFromStart } from '../../domain/projects'
import { selectableCompanies } from '../../domain/companies'
import { Dialog, btnPrimary, btnSecondary, errorCls, fieldCls, labelCls } from '../../components/Dialog'
import { LogoTile, PersonDot } from '../../components/Bits'
import { TODAY } from '../../lib/dates'

const schema = z
  .object({
    kind: z.enum(['client', 'internal']),
    companyId: z.string(),
    area: z.string(),
    name: z.string().trim().min(1, 'Add a project name'),
    desc: z.string(),
    start: z.string(),
    due: z.string(),
    team: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'client' && !v.companyId) ctx.addIssue({ code: 'custom', path: ['companyId'], message: 'Choose a company' })
    if (v.kind === 'internal' && !v.area) ctx.addIssue({ code: 'custom', path: ['area'], message: 'Choose an area' })
  })
type Form = z.infer<typeof schema>

const KIND_SUB = { client: 'Work we deliver for a company', internal: 'Our own tools, infra or website' } as const

/**
 * Starts a project. With `companyId` it is a client project of that company
 * (opened from a company). Without it, the kind can be chosen. `initialState`
 * is the column it was opened from: the project keeps that state (fixes PR-06).
 */
export function NewProjectDialog({
  companyId,
  initialState,
  onClose,
  onCreated,
}: {
  companyId?: string
  initialState?: ProjectState
  onClose: () => void
  onCreated?: (ref: ProjectRef) => void
}) {
  const companies = useCompanies().data ?? []
  const people = usePeople().data ?? []
  const session = useSession()
  const send = useSendAsync()
  const [saveError, setSaveError] = useState<string | null>(null)
  const fixed = companyId ? companies.find(c => c.id === companyId) : undefined
  const vtPeople = people.filter(p => p.org === 'vt' && p.active)
  // A developer's new project starts with themselves on the team.
  const defaultTeam = session?.role === 'dev' ? [session.personId] : []

  const form = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      kind: 'client',
      companyId: companyId ?? '',
      area: AREAS[0],
      name: '',
      desc: '',
      start: initialState === 'planned' ? '' : TODAY,
      due: '',
      team: defaultTeam,
    },
  })
  const { errors, isSubmitting } = form.formState
  const kind = form.watch('kind')
  const team = form.watch('team')
  const message = saveError ?? errors.name?.message ?? errors.companyId?.message ?? errors.area?.message ?? ''

  const toggleTeam = (id: string) => {
    const cur = form.getValues('team')
    form.setValue('team', cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id], { shouldDirty: true })
  }

  const onSubmit = form.handleSubmit(async v => {
    setSaveError(null)
    const state: ProjectState = initialState ?? stateFromStart(v.start)
    const start = v.start ? { start: v.start } : {}
    try {
      if (v.kind === 'client') {
        const project: ClientProject = {
          id: newId('p'),
          name: v.name,
          desc: v.desc,
          state,
          pct: 0,
          due: v.due,
          team: v.team,
          epics: [],
          ...start,
        }
        const result = await send({ type: 'company.project.create', companyId: v.companyId, project })
        onCreated?.({ kind: 'client', companyId: v.companyId, id: result?.apiId ?? project.id })
      } else {
        const project: InternalProject = {
          id: newId('i'),
          name: v.name,
          desc: v.desc,
          area: v.area,
          state,
          pct: 0,
          due: v.due,
          team: v.team,
          ...start,
        }
        const result = await send({ type: 'project.internal.create', project })
        onCreated?.({ kind: 'internal', id: result?.apiId ?? project.id })
      }
      onClose()
    } catch {
      setSaveError('The project could not be saved. Try again.')
    }
  })

  const title = fixed ? `New project · ${fixed.name}` : 'New project'
  return (
    <Dialog titleId="new-project-title" eyebrow={title} title="Start a new project" onClose={onClose} width={600}>
      <form onSubmit={onSubmit} noValidate className="mt-5">
        {!companyId && (
          <div className="mb-4 grid grid-cols-2 gap-2.5 max-[560px]:grid-cols-1" role="radiogroup" aria-label="Project kind">
            {(['client', 'internal'] as const).map(k => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={kind === k}
                onClick={() => form.setValue('kind', k)}
                className={`cursor-pointer rounded-[12px] border-[1.5px] px-3.5 py-2.5 text-left ${kind === k ? 'border-blue bg-sky-2' : 'border-line bg-white'}`}
              >
                <span className="block text-[13.5px] font-bold text-ink">{k === 'client' ? 'Client project' : 'Internal project'}</span>
                <span className="block text-[12px] text-muted">{KIND_SUB[k]}</span>
              </button>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-3.5 max-[600px]:grid-cols-1">
          {kind === 'client' ? (
            <div className="col-span-2 max-[600px]:col-span-1">
              <span className={labelCls}>Company *</span>
              {fixed ? (
                <div className="flex items-center gap-2.5 rounded-[9px] border-[1.5px] border-line bg-canvas px-3 py-2">
                  <LogoTile name={fixed.name} p={fixed.p} logo={fixed.logo} size={26} />
                  <span className="text-[13.5px] font-semibold">{fixed.name}</span>
                </div>
              ) : (
                <CompanyPicker
                  companies={companies}
                  value={form.watch('companyId')}
                  onPick={id => form.setValue('companyId', id, { shouldDirty: true, shouldValidate: true })}
                  error={errors.companyId?.message}
                />
              )}
            </div>
          ) : (
            <label className="col-span-2 max-[600px]:col-span-1">
              <span className={labelCls}>Area</span>
              <select className={`${fieldCls} cursor-pointer`} {...form.register('area')}>
                {AREAS.map(a => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="col-span-2 max-[600px]:col-span-1">
            <span className={labelCls}>Project name *</span>
            <input className={fieldCls} autoFocus {...form.register('name')} />
          </label>
          <label className="col-span-2 max-[600px]:col-span-1">
            <span className={labelCls}>What are we building?</span>
            <textarea className={`${fieldCls} h-auto min-h-[70px] py-2`} {...form.register('desc')} />
          </label>
          <label>
            <span className={labelCls}>Start date</span>
            <input type="date" className={fieldCls} {...form.register('start')} />
          </label>
          <label>
            <span className={labelCls}>Deadline</span>
            <input type="date" className={fieldCls} {...form.register('due')} />
          </label>
        </div>

        <div className="mt-4">
          <span className={labelCls}>
            Team <span className="font-semibold text-muted">(optional)</span>
          </span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Team">
            {vtPeople.map(p => {
              const on = team.includes(p.id)
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleTeam(p.id)}
                  className={`inline-flex cursor-pointer items-center gap-2 rounded-full border-[1.5px] py-1 pl-1 pr-3 text-[12.5px] font-semibold ${
                    on ? 'border-blue bg-sky-3 text-blue-ink' : 'border-line bg-white text-ink-2'
                  }`}
                >
                  <PersonDot name={p.name} colour={p.colour} size={22} />
                  {p.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="mt-5 flex items-center gap-2.5">
          <span role="status" className={`min-w-0 flex-1 ${errorCls}`}>
            {message}
          </span>
          <button type="button" onClick={onClose} className={btnSecondary}>
            Cancel
          </button>
          <button type="submit" disabled={isSubmitting} className={btnPrimary}>
            Start project
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/** Company dropdown with search, and "+ Add new company" inline. */
function CompanyPicker({
  companies,
  value,
  onPick,
  error,
}: {
  companies: ReturnType<typeof selectableCompanies>
  value: string
  onPick: (id: string) => void
  error?: string
}) {
  const send = useSendAsync()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [addName, setAddName] = useState('')
  const [addIndustry, setAddIndustry] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const live = selectableCompanies(companies)
  const chosen = live.find(c => c.id === value)
  const matches = live.filter(c => c.name.toLowerCase().includes(q.trim().toLowerCase()))

  const openAdd = () => {
    setAddName(q.trim())
    setAddIndustry('')
    setAddError(null)
    setAdding(true)
  }

  const addCompany = async () => {
    const name = addName.trim()
    if (!name) {
      setAddError('Add a company name')
      return
    }
    const id = newId('c')
    try {
      const result = await send({
        type: 'company.create',
        company: {
          id,
          name,
          industry: addIndustry.trim(),
          country: '',
          web: '',
          p: companies.length,
          notes: '',
          contacts: [],
          projects: [],
          ourRoles: {},
          archived: false,
          archivedAt: null,
        },
      })
      onPick(result?.apiId ?? id)
      setAdding(false)
      setOpen(false)
    } catch {
      setAddError('The company could not be added. Try again.')
    }
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
        className={`flex h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-[9px] border-[1.5px] bg-white px-3 text-left text-[13.5px] ${error ? 'border-red' : 'border-line'}`}
      >
        {chosen ? (
          <>
            <LogoTile name={chosen.name} p={chosen.p} logo={chosen.logo} size={22} />
            <span className="min-w-0 flex-1 truncate font-semibold">{chosen.name}</span>
          </>
        ) : (
          <span className="flex-1 text-muted">Choose a company</span>
        )}
      </button>
      {open && (
        <div className="mt-2 rounded-[10px] border-[1.5px] border-line bg-white p-2">
          {adding ? (
            <div className="space-y-2">
              <input className={fieldCls} placeholder="Company name" value={addName} onChange={e => setAddName(e.target.value)} aria-label="Company name" />
              <input className={fieldCls} placeholder="Industry" value={addIndustry} onChange={e => setAddIndustry(e.target.value)} aria-label="Industry" />
              <div className="flex items-center gap-2">
                <span role="status" className={`mr-auto ${errorCls}`}>
                  {addError}
                </span>
                <button type="button" onClick={() => setAdding(false)} className="h-8 cursor-pointer rounded-[8px] px-2.5 text-[12.5px] font-semibold text-ink-2">
                  Cancel
                </button>
                <button type="button" onClick={addCompany} className="h-8 cursor-pointer rounded-[8px] bg-blue px-3 text-[12.5px] font-bold text-white">
                  Add company
                </button>
              </div>
            </div>
          ) : (
            <>
              <input
                type="search"
                value={q}
                onChange={e => setQ(e.target.value)}
                placeholder="Search companies"
                aria-label="Search companies"
                className={fieldCls}
              />
              <ul className="m-0 mt-1.5 max-h-44 list-none overflow-y-auto p-0">
                {matches.map(c => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => {
                        onPick(c.id)
                        setOpen(false)
                      }}
                      className="flex w-full cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-1.5 text-left text-[13.5px] hover:bg-canvas"
                    >
                      <LogoTile name={c.name} p={c.p} logo={c.logo} size={22} />
                      <span className="font-semibold">{c.name}</span>
                      {c.industry && <span className="text-[12px] text-muted">{c.industry}</span>}
                    </button>
                  </li>
                ))}
                {matches.length === 0 && <li className="px-2 py-1.5 text-[13px] text-muted">No companies found</li>}
              </ul>
              <button type="button" onClick={openAdd} className="mt-1 w-full cursor-pointer rounded-[8px] px-2 py-1.5 text-left text-[13px] font-semibold text-blue-ink hover:bg-canvas">
                {q.trim() ? `+ Add new company "${q.trim()}"` : '+ Add new company'}
              </button>
            </>
          )}
        </div>
      )}
      {error && <p className={`mt-1 ${errorCls}`}>{error}</p>}
    </div>
  )
}
