import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { apiForgotPassword, apiResetPassword, type PasswordResult } from '../../api/http/auth'

/**
 * "Forgot password" and "Set your password" (from an emailed link), in the
 * same card as the sign-in page. API mode only: the mock has no email.
 */

const input = 'h-11 w-full rounded-[10px] border-[1.5px] border-line bg-white px-[13px] text-[14px] text-ink outline-0'
const button = 'mt-[18px] h-11 w-full rounded-[10px] bg-blue text-[14.5px] font-bold text-white hover:bg-blue-600 disabled:opacity-60'

function Card({ title, intro, children }: { title: string; intro: string; children: ReactNode }) {
  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-5 py-8 font-medium text-ink">
      <section className="w-full max-w-[470px] rounded-[20px] bg-white px-7 pb-6 pt-7 shadow-[0_0_0_1.5px_#D6DEE8]">
        <div className="flex items-center gap-2.5">
          <span className="grid size-[34px] place-items-center rounded-[10px] bg-blue-600 text-[14px] font-bold text-white">V</span>
          <span className="text-[15px] font-bold">Viljetech</span>
        </div>
        <h1 className="mb-0 mt-[22px] text-[26px] font-extrabold tracking-[-0.02em]">{title}</h1>
        <div className="mt-1 text-[14px] text-ink-2">{intro}</div>
        {children}
        <div className="mt-4 text-[13px]">
          <Link to="/login" className="font-bold text-blue-ink">
            ‹ Back to sign in
          </Link>
        </div>
      </section>
    </div>
  )
}

function Result({ result }: { result: PasswordResult | null }) {
  if (!result) return null
  return (
    <div role={result.ok ? 'status' : 'alert'} className={`mt-2.5 text-[13px] font-semibold ${result.ok ? 'text-[#2E7D5B]' : 'text-[#C0392B]'}`}>
      {result.message}
    </div>
  )
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PasswordResult | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setResult(await apiForgotPassword(email))
    setBusy(false)
  }

  return (
    <Card title="Forgot your password?" intro="Enter your email and we will send you a link to set a new password.">
      <form onSubmit={submit} noValidate>
        <label className="mt-5 block">
          <span className="mb-1.5 block text-[12px] font-bold text-ink-2">Email</span>
          <input type="email" autoComplete="username" autoFocus placeholder="name@company.com" className={input} value={email} onChange={e => setEmail(e.target.value)} />
        </label>
        <Result result={result} />
        <button type="submit" disabled={busy} className={button}>
          Send link
        </button>
      </form>
    </Card>
  )
}

export function ResetPasswordPage() {
  const [params] = useSearchParams()
  // Read once, then taken out of the address bar and history so the link can't be reused from there.
  const [token] = useState(() => params.get('token') ?? '')
  // The invitation a new contact gets uses this same page.
  const welcome = params.get('welcome') === '1'
  useEffect(() => {
    if (params.has('token')) window.history.replaceState(null, '', `/reset-password${welcome ? '?welcome=1' : ''}`)
  }, [params, welcome])
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<PasswordResult | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setResult(await apiResetPassword(token, password, repeat))
    setBusy(false)
  }

  return (
    <Card
      title={welcome ? 'Choose your password' : 'Set a new password'}
      intro={welcome ? 'Your account is ready. Choose a password to sign in with.' : 'Choose a new password for your account.'}
    >
      {result?.ok ? (
        <>
          <Result result={result} />
          <Link to="/login" className={`${button} grid place-items-center`}>
            Sign in
          </Link>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          <label className="mt-5 block">
            <span className="mb-1.5 block text-[12px] font-bold text-ink-2">New password</span>
            <input type="password" autoComplete="new-password" autoFocus placeholder="••••••••" className={input} value={password} onChange={e => setPassword(e.target.value)} />
          </label>
          <label className="mt-3 block">
            <span className="mb-1.5 block text-[12px] font-bold text-ink-2">Repeat password</span>
            <input type="password" autoComplete="new-password" placeholder="Type it again" className={input} value={repeat} onChange={e => setRepeat(e.target.value)} />
          </label>
          <Result result={result} />
          <button type="submit" disabled={busy} className={button}>
            {welcome ? 'Set password' : 'Save new password'}
          </button>
        </form>
      )}
    </Card>
  )
}
