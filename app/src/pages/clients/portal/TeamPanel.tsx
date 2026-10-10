import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useSend } from '../../../api/queries'
import type { ClientTeamMember, Company } from '../../../api/types'
import { Avatar } from '../../../components/ui'
import { initials } from '../../../lib/media'

const schema = z.object({
  name: z.string().trim().min(1, 'Enter a name'),
  email: z.string().trim().email('Enter a valid email address'),
  title: z.string().trim().max(80, 'Keep it under 80 characters'),
})
type Form = z.infer<typeof schema>

const newId = () => 'ct-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)

/**
 * "Your team". The company's contacts (Companies page) are the source; the
 * members the client adds here are only people who are not contacts (DECISIONS item 3).
 */
export function TeamPanel({ company, members, canManage }: { company: Company; members: ClientTeamMember[]; canManage: boolean }) {
  const send = useSend()
  const [adding, setAdding] = useState(false)
  const total = company.contacts.length + members.length

  return (
    <aside className="rounded-2xl bg-white p-5 shadow-[0_0_0_1.5px_#D6DEE8]" aria-label="Your team">
      <div className="flex items-center gap-2">
        <h2 className="text-[17px] font-bold text-ink">Your team</h2>
        <span className="tnum text-[13px] text-ink-2">{total}</span>
        {canManage && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="ml-auto h-8 cursor-pointer rounded-lg border-0 bg-blue px-3 text-[12.5px] font-semibold text-white hover:bg-blue-600"
          >
            Add member
          </button>
        )}
      </div>
      <p className="mt-1 text-[13px] text-ink-2">They can report bugs and answer questions.</p>

      <ul className="mt-3 flex flex-col gap-2">
        {company.contacts.map(c => (
          <li key={'c-' + c.email} className="flex items-center gap-3 rounded-xl bg-canvas px-3 py-2.5">
            <Avatar i={initials(c.name)} bg="#56657A" size={30} radius={8} font={10} className="!font-bold" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-ink">{c.name}</div>
              <div className="truncate text-[12.5px] text-ink-2">
                {c.role ? c.role + ' · ' : ''}
                {c.email}
              </div>
            </div>
            <span className="flex-none rounded-md bg-sky-2 px-2 py-0.5 text-[11.5px] font-semibold text-blue-ink">Company contact</span>
          </li>
        ))}
        {members.map(m => (
          <li key={m.id} className="flex items-center gap-3 rounded-xl bg-canvas px-3 py-2.5">
            <Avatar i={initials(m.name)} bg="#56657A" size={30} radius={8} font={10} className="!font-bold" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold text-ink">{m.name}</div>
              <div className="truncate text-[12.5px] text-ink-2">
                {m.title ? m.title + ' · ' : ''}
                {m.email}
              </div>
            </div>
            {canManage && (
              <button
                type="button"
                aria-label={`Remove ${m.name}`}
                title="Remove"
                onClick={() => send({ type: 'clientTeam.remove', id: m.id })}
                className="size-[26px] flex-none cursor-pointer rounded-md border-0 bg-rust-soft p-0 text-[15px] leading-none text-rust"
              >
                ×
              </button>
            )}
          </li>
        ))}
        {!total && <li className="py-3 text-center text-[13.5px] text-muted">No one in your team yet.</li>}
      </ul>

      {canManage && adding && (
        <AddMemberForm
          companyId={company.id}
          taken={[...company.contacts.map(c => ({ email: c.email, name: c.name, contact: true })), ...members.map(m => ({ email: m.email, name: m.name, contact: false }))]}
          onDone={() => setAdding(false)}
        />
      )}
    </aside>
  )
}

function AddMemberForm({
  companyId,
  taken,
  onDone,
}: {
  companyId: string
  taken: { email: string; name: string; contact: boolean }[]
  onDone: () => void
}) {
  const send = useSend()
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { name: '', email: '', title: '' } })

  const onSubmit = (f: Form) => {
    const email = f.email.toLowerCase()
    const hit = taken.find(t => t.email.toLowerCase() === email)
    if (hit) {
      setError('email', {
        message: hit.contact ? `${hit.name} is already a company contact, so they are in your team.` : `${hit.name} is already in your team.`,
      })
      return
    }
    send({
      type: 'clientTeam.add',
      member: { id: newId(), companyId, name: f.name.trim(), email: f.email.trim(), ...(f.title.trim() ? { title: f.title.trim() } : {}) },
    })
    onDone()
  }

  const field = 'h-[36px] w-full rounded-lg border-[1.5px] border-line bg-white px-2.5 text-[13.5px] text-ink outline-0 focus:border-blue'
  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-4 flex flex-col gap-3 rounded-xl border-[1.5px] border-line bg-canvas p-3.5">
      <div className="text-[13.5px] font-bold text-ink">Add someone from your team</div>
      <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
        Name
        <input {...register('name')} className={field} placeholder="e.g. Maria Berg" />
        {errors.name && <span role="alert" className="text-[12px] font-semibold text-rust">{errors.name.message}</span>}
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
        Email
        <input {...register('email')} type="email" className={field} placeholder="name@company.com" />
        {errors.email && <span role="alert" className="text-[12px] font-semibold text-rust">{errors.email.message}</span>}
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
        Title (optional)
        <input {...register('title')} className={field} placeholder="e.g. Site manager" />
        {errors.title && <span role="alert" className="text-[12px] font-semibold text-rust">{errors.title.message}</span>}
      </label>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="h-9 cursor-pointer rounded-[9px] border-[1.5px] border-faint bg-white px-3.5 text-[13px] font-semibold text-ink">
          Cancel
        </button>
        <button type="submit" className="h-9 cursor-pointer rounded-[9px] border-0 bg-blue px-4 text-[13px] font-bold text-white">
          Add to team
        </button>
      </div>
    </form>
  )
}
