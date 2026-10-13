import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk, useCompanies } from '../../api/queries'
import { findPersonByEmail } from '../../api/people/directory'
import { apiSignIn } from '../../api/http/auth'
import { apiMode } from '../../api/http/config'
import { server } from '../../api/server'
import { ROLE_LABEL } from '../../api/session/access'
import { DEMO_PASSWORD, signIn } from '../../api/session/signIn'
import { startSession, useSession } from '../../api/session/store'
import type { Role } from '../../api/types'
import { initials } from '../../lib/media'

/** The sample users, one per user type, in the order the prototype lists them. */
const SAMPLE_EMAILS = [
  'rahul@viljetech.com',
  'vivek@viljetech.com',
  'bhavana@viljetech.com',
  'chary@viljetech.com',
  'sofia@freelance.dev',
  'arjun@viljetech.com',
  'ingrid@daco.no',
  'lars@daco.no',
]

/** Role chip colours: [background, text]. */
const CHIP: Record<Role, [string, string]> = {
  super: ['#1B2D45', '#FFFFFF'],
  admin: ['#E7EEFB', '#1F3FAF'],
  pm: ['#EEE9FB', '#5B3FB8'],
  dev: ['#DFF1EA', '#195040'],
  devops: ['#E6F0F7', '#1D5A7A'],
  cadmin: ['#FBF1D6', '#7A5C0E'],
  cuser: ['#FBE7E3', '#A5302B'],
}

const schema = z.object({
  email: z.string().trim().min(1, 'Enter your email.'),
  password: z.string(),
})
type Form = z.infer<typeof schema>

const input = 'w-full rounded-[10px] border-[1.5px] bg-white px-[13px] text-[14px] text-ink outline-0'

/** The sign-in page (no sidebar). Team members and clients use the same form. */
export function LoginPage() {
  const session = useSession()
  const navigate = useNavigate()
  // The sample users panel always lists the sample data, in API mode too, so the page looks the same.
  const people = useQuery({ queryKey: ['loginSamples'], queryFn: () => server.get('people') }).data ?? []
  const companies = useCompanies().data ?? []
  const form = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { email: '', password: '' } })
  const { errors, isSubmitting } = form.formState
  const email = form.watch('email')
  const message = errors.email?.message ?? errors.password?.message

  const qc = useQueryClient()

  const mockSignIn = async (v: Form) => {
    // The directory may still be loading when the form is submitted, so read it here.
    const [dir, orgs] = await Promise.all([
      qc.fetchQuery({ queryKey: qk.people, queryFn: () => server.get('people') }),
      qc.fetchQuery({ queryKey: qk.companies, queryFn: () => server.get('companies') }),
    ])
    return signIn(v.email, v.password, dir, orgs)
  }

  const onSubmit = form.handleSubmit(async v => {
    const result = apiMode ? await apiSignIn(v.email, v.password) : await mockSignIn(v)
    if (!result.ok) {
      form.setError(result.field, { type: 'manual', message: result.message })
      return
    }
    startSession(result.session)
    // The directory depends on who is signed in (API mode), so load it again.
    await qc.invalidateQueries({ queryKey: qk.people })
    navigate('/dashboard', { replace: true })
  })

  const pick = (addr: string) => {
    form.setValue('email', addr)
    form.setValue('password', DEMO_PASSWORD)
    form.clearErrors()
  }

  const orgName = (orgId: string) => companies.find(c => c.id === orgId)?.name ?? orgId

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-5 py-8 font-medium text-ink">
      <div className="grid w-full max-w-[960px] grid-cols-[repeat(auto-fit,minmax(340px,1fr))] items-start gap-5">
        <section className="rounded-[20px] bg-white px-7 pb-6 pt-7 shadow-[0_0_0_1.5px_#D6DEE8]">
          <div className="flex items-center gap-2.5">
            <span className="grid size-[34px] place-items-center rounded-[10px] bg-blue-600 text-[14px] font-bold text-white">V</span>
            <span className="text-[15px] font-bold">Viljetech</span>
          </div>

          {session && (
            <div className="mt-[18px] flex items-center gap-2.5 rounded-xl bg-sky px-3 py-2.5 shadow-[inset_0_0_0_1.5px_#C9D7F6]">
              <span className="text-[13px] text-ink">
                Signed in as <b>{session.name}</b>
              </span>
              <Link to="/dashboard" className="ml-auto text-[13px] font-bold text-blue-ink">
                Continue ›
              </Link>
            </div>
          )}

          <h1 className="mb-0 mt-[22px] text-[26px] font-extrabold tracking-[-0.02em]">Sign in</h1>
          <div className="mt-1 text-[14px] text-ink-2">Team members and clients use the same sign-in.</div>

          <form onSubmit={onSubmit} noValidate>
            <label className="mt-5 block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-2">Email</span>
              <input
                type="email"
                autoComplete="username"
                placeholder="name@company.com"
                className={`${input} h-11 text-[14px] ${errors.email ? 'border-[#D9534F]' : 'border-line'}`}
                {...form.register('email', { onChange: () => form.clearErrors() })}
              />
            </label>
            <label className="mt-3 block">
              <span className="mb-1.5 block text-[12px] font-bold text-ink-2">Password</span>
              <input
                type="password"
                autoComplete="current-password"
                placeholder="••••••••"
                className={`${input} h-11 border-line text-[14px]`}
                {...form.register('password', { onChange: () => form.clearErrors() })}
              />
            </label>
            {message && (
              <div role="alert" className="mt-2.5 text-[13px] font-semibold text-[#C0392B]">
                {message}
              </div>
            )}
            <button
              type="submit"
              disabled={isSubmitting}
              className="mt-[18px] h-11 w-full rounded-[10px] bg-blue text-[14.5px] font-bold text-white hover:bg-blue-600 disabled:opacity-60"
            >
              Sign in
            </button>
          </form>
          <div className="mt-3 text-[12.5px] text-muted">
            Demo password for the sample users: <b>demo</b>. Pick a sample user on the right to fill in both fields.
          </div>
        </section>

        <section className="overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1.5px_#D6DEE8]">
          <div className="border-b-[1.5px] border-line-3 px-5 py-4">
            <div className="text-[15px] font-bold">Sample users</div>
            <div className="text-[12.5px] text-muted">One per user type</div>
          </div>
          {SAMPLE_EMAILS.map(addr => {
            const u = findPersonByEmail(people, addr)
            if (!u) return null
            const on = email.trim().toLowerCase() === addr
            const [chipBg, chipInk] = CHIP[u.role]
            return (
              <div
                key={addr}
                role="button"
                tabIndex={0}
                onClick={() => pick(addr)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pick(addr)
                  }
                }}
                className={`flex cursor-pointer items-center gap-3 border-t-[1.5px] border-[#EEF3FB] px-5 py-3 ${on ? 'bg-[#F2F6FE]' : 'hover:bg-canvas'}`}
              >
                <span className="grid size-[34px] flex-none place-items-center rounded-lg bg-ink text-[12px] font-bold text-white">{initials(u.name)}</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-bold">
                    {u.name}
                    {u.emp === 'freelancer' ? ' · Freelancer' : ''}
                  </div>
                  <div className="truncate text-[12.5px] text-muted">
                    {u.email} · {u.org === 'vt' ? 'Viljetech' : orgName(u.org)}
                  </div>
                </div>
                <span
                  className="inline-flex h-[22px] flex-none items-center gap-1.5 whitespace-nowrap rounded-md pl-[7px] pr-2 text-[11.5px] font-bold"
                  style={{ background: chipBg, color: chipInk }}
                >
                  <span className="size-1.5 rounded-full" style={{ background: chipInk }} />
                  {ROLE_LABEL[u.role]}
                </span>
              </div>
            )
          })}
        </section>
      </div>
    </div>
  )
}
