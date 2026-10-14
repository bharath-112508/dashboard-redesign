import { useState, type FormEvent } from 'react'
import { apiVerifyMfa } from '../../api/http/auth'
import type { Session } from '../../api/types'

/** The sign-in form's field style (LoginPage.tsx). */
const input = 'w-full rounded-[10px] border-[1.5px] bg-white px-[13px] text-[14px] text-ink outline-0'

/**
 * The second sign-in step for an account with two-step sign-in: the 6-digit code from
 * the authenticator app, or one of the backup codes. Shown in the sign-in card instead of the form.
 */
export function MfaStep({ token, onDone, onBack }: { token: string; onDone: (s: Session) => void; onBack: () => void }) {
  const [code, setCode] = useState('')
  const [backup, setBackup] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    const r = await apiVerifyMfa(token, code, backup)
    setBusy(false)
    if (r.ok) return onDone(r.session)
    // The step expired: start again from email and password.
    if (r.field === 'expired') return onBack()
    setError(r.message)
  }

  return (
    <form onSubmit={submit} noValidate>
      <label className="mt-5 block">
        <span className="mb-1.5 block text-[12px] font-bold text-ink-2">{backup ? 'Backup code' : 'Code from your authenticator app'}</span>
        <input
          autoFocus
          inputMode={backup ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          placeholder={backup ? 'xxxx-xxxx' : '123456'}
          value={code}
          onChange={e => {
            setCode(e.target.value)
            setError(null)
          }}
          className={`${input} h-11 text-[14px] ${error ? 'border-[#D9534F]' : 'border-line'}`}
        />
      </label>
      {error && (
        <div role="alert" className="mt-2.5 text-[13px] font-semibold text-[#C0392B]">
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={busy}
        className="mt-[18px] h-11 w-full rounded-[10px] bg-blue text-[14.5px] font-bold text-white hover:bg-blue-600 disabled:opacity-60"
      >
        Verify
      </button>
      <div className="mt-3 flex justify-between text-[12.5px]">
        <button type="button" onClick={onBack} className="font-bold text-blue-ink">
          ‹ Back
        </button>
        <button
          type="button"
          onClick={() => {
            setBackup(b => !b)
            setCode('')
            setError(null)
          }}
          className="font-bold text-blue-ink"
        >
          {backup ? 'Use the app code' : 'Use a backup code'}
        </button>
      </div>
    </form>
  )
}
