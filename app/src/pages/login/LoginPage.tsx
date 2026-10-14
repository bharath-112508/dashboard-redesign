import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Link, useNavigate } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { qk, useCompanies } from '../../api/queries'
import { findPersonByEmail } from '../../api/people/directory'
import { apiSignIn } from '../../api/http/auth'
import { apiMode, demoAccounts } from '../../api/http/config'
import { DEMO_DB_ACCOUNTS } from '../../api/http/sampleAccounts'
import { MfaStep } from './MfaStep'
import { server } from '../../api/server'
import { ROLE_LABEL } from '../../api/session/access'
import { DEMO_PASSWORD, signIn } from '../../api/session/signIn'
import { startSession, useSession } from '../../api/session/store'
import type { Role, Session } from '../../api/types'
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

/** One entry in the account list next to the form. Without an email it is a role the backend lacks. */
interface AccountRow {
  key: string
  name: string
  sub: string
  role: Role
  email?: string
}

const input = 'w-full rounded-[10px] border-[1.5px] bg-white px-[13px] text-[14px] text-ink outline-0'

/** The sign-in page (no sidebar). Team members and clients use the same form. */
export function LoginPage() {
  const session = useSession()
  const navigate = useNavigate()
  // The sample users panel always lists the sample data, in API mode too, so the page looks the same.
  // Always fresh on arrival, so a rename made by an admin shows up straight away.
  const people = useQuery({ queryKey: ['loginSamples'], queryFn: () => server.get('people'), staleTime: 0 }).data ?? []
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

  // API mode: the account uses two-step sign-in, and this is the token for the code step.
  const [mfa, setMfa] = useState<string | null>(null)

  const finish = async (s: Session) => {
    // Nothing read for someone else (or before signing in) may show for this person.
    if (apiMode) qc.clear()
    startSession(s)
    // The directory depends on who is signed in, so load it again (mock mode keeps the rest).
    if (!apiMode) await qc.invalidateQueries({ queryKey: qk.people })
    navigate('/dashboard', { replace: true })
  }

  const onSubmit = form.handleSubmit(async v => {
    const result = apiMode ? await apiSignIn(v.email, v.password) : await mockSignIn(v)
    if (!result.ok) {
      if ('mfa' in result) return setMfa(result.mfa)
      form.setError(result.field, { type: 'manual', message: result.message })
      return
    }
    await finish(result.session)
  })

  const pick = (addr: string) => {
    form.setValue('email', addr)
    // API mode: real accounts, so the person types the password; the app never holds it.
    form.setValue('password', apiMode ? '' : DEMO_PASSWORD)
    form.clearErrors()
    if (apiMode) form.setFocus('password')
  }

  const orgName = (orgId: string) => companies.find(c => c.id === orgId)?.name ?? orgId

  /** The account list: the sample users in mock mode, the Demo DB accounts (and the roles it lacks) in API mode. */
  const rows: AccountRow[] = apiMode
    ? DEMO_DB_ACCOUNTS.map((a, i) =>
        a.account
          ? {
              key: a.account.email,
              name: a.account.name + (a.variant ? ` · ${a.variant}` : ''),
              sub: `${a.account.email} · ${a.account.org}`,
              role: a.role,
              email: a.account.email,
            }
          : { key: `missing-${i}`, name: ROLE_LABEL[a.role], sub: a.missing ?? '', role: a.role },
      )
    : SAMPLE_EMAILS.flatMap(addr => {
        const u = findPersonByEmail(people, addr)
        return u
          ? [
              {
                key: addr,
                name: u.name + (u.emp === 'freelancer' ? ' · Freelancer' : ''),
                sub: `${u.email} · ${u.org === 'vt' ? 'Viljetech' : orgName(u.org)}`,
                role: u.role,
                email: addr,
              },
            ]
          : []
      })

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

          {mfa ? (
            <MfaStep token={mfa} onDone={s => void finish(s)} onBack={() => setMfa(null)} />
          ) : (
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
          )}
          <div className="mt-3 text-[12.5px] text-muted">
            {apiMode ? (
              <>
                {demoAccounts && 'Signing in to the Demo DB. Pick an account on the right to fill in its email, then enter its password. '}
                <Link to="/forgot-password" className="font-bold text-blue-ink">
                  Forgot password?
                </Link>
              </>
            ) : (
              <>
                Demo password for the sample users: <b>demo</b>. Pick a sample user on the right to fill in both fields.
              </>
            )}
          </div>
        </section>

        {/* The account list: the sample users in mock mode; the Demo DB accounts only in a demo API build. */}
        {(!apiMode || demoAccounts) && (
          <section className="overflow-hidden rounded-[20px] bg-white shadow-[0_0_0_1.5px_#D6DEE8]">
            <div className="border-b-[1.5px] border-line-3 px-5 py-4">
              <div className="text-[15px] font-bold">{apiMode ? 'Demo DB accounts' : 'Sample users'}</div>
              <div className="text-[12.5px] text-muted">
                {apiMode ? 'One per user type, and the types the backend does not have yet' : 'One per user type'}
              </div>
            </div>
            {rows.map(r => {
              const addr = r.email
              if (!addr) {
                // A role the backend has no account for yet: shown, not selectable.
                return (
                  <div key={r.key} className="flex items-center gap-3 border-t-[1.5px] border-[#EEF3FB] px-5 py-3 opacity-60">
                    <span className="grid size-[34px] flex-none place-items-center rounded-lg bg-line text-[12px] font-bold text-muted">
                      –
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[14px] font-bold">{r.name}</div>
                      <div className="text-[12.5px] text-muted">{r.sub}</div>
                    </div>
                    <span className="inline-flex h-[22px] flex-none items-center whitespace-nowrap rounded-md bg-canvas px-2 text-[11.5px] font-bold text-muted">
                      Not in backend
                    </span>
                  </div>
                )
              }
              const on = email.trim().toLowerCase() === addr
              const [chipBg, chipInk] = CHIP[r.role]
              return (
                <div
                  key={r.key}
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
                  <span className="grid size-[34px] flex-none place-items-center rounded-lg bg-ink text-[12px] font-bold text-white">
                    {initials(r.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-bold">{r.name}</div>
                    <div className="truncate text-[12.5px] text-muted">{r.sub}</div>
                  </div>
                  <span
                    className="inline-flex h-[22px] flex-none items-center gap-1.5 whitespace-nowrap rounded-md pl-[7px] pr-2 text-[11.5px] font-bold"
                    style={{ background: chipBg, color: chipInk }}
                  >
                    <span className="size-1.5 rounded-full" style={{ background: chipInk }} />
                    {ROLE_LABEL[r.role]}
                  </span>
                </div>
              )
            })}
          </section>
        )}
      </div>
    </div>
  )
}
