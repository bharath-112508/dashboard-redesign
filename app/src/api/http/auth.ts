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
    // Tokens may already be stored (the profile read failed after login): drop them, the person is not signed in.
    clearTokens()
    if (!(err instanceof ApiError)) {
      return { ok: false, field: 'password', message: 'Could not reach the server. Check your connection and try again.' }
    }
    const refusal = REFUSALS[err.code]
    if (refusal) return { ok: false, ...refusal }
    if (err.status === 429) return { ok: false, field: 'password', message: 'Too many sign-in attempts. Wait a few minutes and try again.' }
    return { ok: false, field: 'password', message: 'Sign-in failed. Try again in a moment.' }
  }
}

/** Signs out here and on the server, so the refresh token cannot be used again. */
export const apiSignOut = async () => {
  const t = readTokens()
  clearTokens()
  if (t) await api.post('/auth/logout', { refresh_token: t.refresh }).catch(() => undefined)
}

export type PasswordResult = { ok: boolean; message: string }

const OFFLINE = 'Could not reach the server. Check your connection and try again.'
const TOO_MANY = 'Too many attempts. Wait a few minutes and try again.'

/** Asks the backend to email a set-a-new-password link. The answer never says whether the account exists. */
export const apiForgotPassword = async (email: string): Promise<PasswordResult> => {
  if (!email.trim()) return { ok: false, message: 'Enter your email.' }
  try {
    await api.post('/auth/forgot-password', { email: email.trim() })
    return { ok: true, message: 'If an account uses this email, we have sent it a link to set a new password.' }
  } catch (err) {
    if (!(err instanceof ApiError)) return { ok: false, message: OFFLINE }
    if (err.status === 429) return { ok: false, message: TOO_MANY }
    return { ok: false, message: err.fieldMessage ?? 'Enter a valid email.' }
  }
}

/** Sets a new password with the token from an emailed link (a reset, or a new contact's invitation). */
export const apiResetPassword = async (token: string, password: string, repeat: string): Promise<PasswordResult> => {
  if (!token) return { ok: false, message: 'This link is incomplete. Ask for a new one.' }
  if (!password) return { ok: false, message: 'Enter a new password.' }
  if (password !== repeat) return { ok: false, message: "The two passwords don't match." }
  try {
    await api.post('/auth/reset-password', { token, new_password: password })
    return { ok: true, message: 'Your password is set. You can sign in now.' }
  } catch (err) {
    if (!(err instanceof ApiError)) return { ok: false, message: OFFLINE }
    if (err.status === 429) return { ok: false, message: TOO_MANY }
    if (err.code === 'ACCOUNT_DEACTIVATED') return { ok: false, message: 'This account is deactivated. Ask an admin to reactivate it.' }
    if (err.fieldMessage) return { ok: false, message: err.fieldMessage }
    if (/invalid or expired/i.test(err.message)) return { ok: false, message: 'This link is invalid or has expired. Ask for a new one.' }
    return { ok: false, message: err.message || 'The password could not be set. Try again.' }
  }
}
