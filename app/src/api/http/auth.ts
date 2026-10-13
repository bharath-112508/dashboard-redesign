import { ApiError, api } from './client'
import { sessionFromMe, type BackendMe } from './mappers'
import { clearTokens, readTokens, writeTokens } from './tokens'
import type { SignInResult } from '../session/signIn'

type LoginBody = { access_token: string; refresh_token: string } | { mfa_required: true; mfa_session_token: string }

/** What to tell the person for each backend sign-in refusal, and which field it belongs to. */
const REFUSALS: Record<string, { field: 'email' | 'password'; message: string }> = {
  INVALID_CREDENTIALS: { field: 'password', message: 'That email or password is not right.' },
  ACCOUNT_DEACTIVATED: { field: 'email', message: 'This account is deactivated. Ask an admin to reactivate it.' },
  ACCOUNT_LOCKED: { field: 'email', message: 'Too many attempts. This account is locked for a while; try again later.' },
}

/** Signs in against the backend and returns the session the app keeps. */
export const apiSignIn = async (email: string, password: string): Promise<SignInResult> => {
  if (!email.trim()) return { ok: false, field: 'email', message: 'Enter your email.' }
  if (!password) return { ok: false, field: 'password', message: 'Enter your password.' }
  try {
    const body = await api.post<LoginBody>('/auth/login', { email: email.trim(), password })
    if ('mfa_required' in body) {
      // ponytail: two-step sign-in is not built yet; it must be before go-live, since live accounts may use it.
      return { ok: false, field: 'password', message: 'This account uses two-step sign-in, which the new app does not support yet.' }
    }
    writeTokens({ access: body.access_token, refresh: body.refresh_token })
    return { ok: true, session: sessionFromMe(await api.get<BackendMe>('/auth/me')) }
  } catch (err) {
    const refusal = err instanceof ApiError ? REFUSALS[err.code] : undefined
    if (refusal) return { ok: false, ...refusal }
    return { ok: false, field: 'password', message: 'Could not reach the server. Check your connection and try again.' }
  }
}

/** Signs out here and on the server, so the refresh token cannot be used again. */
export const apiSignOut = async () => {
  const t = readTokens()
  clearTokens()
  if (t) await api.post('/auth/logout', { refresh_token: t.refresh }).catch(() => undefined)
}
