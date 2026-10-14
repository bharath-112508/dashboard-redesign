import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'

const { post, get, writeTokens, clearTokens } = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  writeTokens: vi.fn(),
  clearTokens: vi.fn(),
}))
vi.mock('./client', async importOriginal => ({
  ...(await importOriginal<typeof import('./client')>()),
  api: { post, get },
}))
vi.mock('./tokens', () => ({ writeTokens, clearTokens, readTokens: () => ({ access: 'a', refresh: 'r' }) }))

const { apiSignIn, apiSignOut, apiForgotPassword, apiResetPassword, apiVerifyMfa } = await import('./auth')

const me = {
  id: 'u1',
  email: 'a@viljetech.com',
  full_name: 'Asha',
  role: 'admin',
  role_keys: ['admin'],
  timezone: 'UTC',
  employment_type: null,
  company_id: null,
  company_name: null,
  phone: null,
}

describe('apiSignIn', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for the email, then the password, before calling the server', async () => {
    expect(await apiSignIn(' ', 'x')).toEqual({ ok: false, field: 'email', message: 'Enter your email.' })
    expect(await apiSignIn('a@viljetech.com', '')).toEqual({ ok: false, field: 'password', message: 'Enter your password.' })
    expect(post).not.toHaveBeenCalled()
  })

  it('stores the tokens and builds the session from /auth/me', async () => {
    post.mockResolvedValue({ access_token: 'a1', refresh_token: 'r1', user: { id: 'u1' } })
    get.mockResolvedValue(me)
    const r = await apiSignIn(' a@viljetech.com ', 'pw')
    expect(post).toHaveBeenCalledWith('/auth/login', { email: 'a@viljetech.com', password: 'pw' })
    expect(writeTokens).toHaveBeenCalledWith({ access: 'a1', refresh: 'r1' })
    expect(r).toMatchObject({ ok: true, session: { personId: 'u1', role: 'super', org: 'Viljetech' } })
  })

  it('gives one message for a wrong email or a wrong password', async () => {
    post.mockRejectedValue(new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid'))
    expect(await apiSignIn('a@viljetech.com', 'bad')).toEqual({
      ok: false,
      field: 'password',
      message: 'That email or password is not right.',
    })
  })

  it('asks for the two-step code when the account uses it, without storing tokens yet', async () => {
    post.mockResolvedValue({ mfa_required: true, mfa_session_token: 't' })
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({ ok: false, mfa: 't' })
    expect(writeTokens).not.toHaveBeenCalled()
  })

  it('explains deactivated and locked accounts', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'ACCOUNT_DEACTIVATED', ''))
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false,
      field: 'email',
      message: 'This account is deactivated. Ask an admin to reactivate it.',
    })
    post.mockRejectedValueOnce(new ApiError(423, 'ACCOUNT_LOCKED', ''))
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false,
      field: 'email',
      message: 'Too many attempts. This account is locked for a while; try again later.',
    })
  })

  it('drops the tokens when loading the profile fails right after signing in', async () => {
    post.mockResolvedValue({ access_token: 'a1', refresh_token: 'r1', user: { id: 'u1' } })
    get.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'))
    const r = await apiSignIn('a@viljetech.com', 'pw')
    expect(r.ok).toBe(false)
    expect(clearTokens).toHaveBeenCalled()
  })

  it('explains too many attempts (rate limited)', async () => {
    post.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many requests'))
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false,
      field: 'password',
      message: 'Too many sign-in attempts. Wait a few minutes and try again.',
    })
  })

  it('does not blame the connection for a server error', async () => {
    post.mockRejectedValue(new ApiError(500, 'INTERNAL', 'boom'))
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({ ok: false, field: 'password', message: 'Sign-in failed. Try again in a moment.' })
  })

  it('says the server could not be reached when the network fails', async () => {
    post.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false,
      field: 'password',
      message: 'Could not reach the server. Check your connection and try again.',
    })
  })
})

describe('apiSignOut', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops the tokens and revokes the refresh token on the server', async () => {
    post.mockResolvedValue(undefined)
    await apiSignOut()
    expect(clearTokens).toHaveBeenCalled()
    expect(post).toHaveBeenCalledWith('/auth/logout', { refresh_token: 'r' })
  })

  it('still signs out locally when the server cannot be reached', async () => {
    post.mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(apiSignOut()).resolves.toBeUndefined()
    expect(clearTokens).toHaveBeenCalled()
  })
})

describe('apiForgotPassword', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for an email first', async () => {
    expect(await apiForgotPassword('  ')).toEqual({ ok: false, message: 'Enter your email.' })
    expect(post).not.toHaveBeenCalled()
  })

  it('sends the request and gives the same answer whether or not the account exists', async () => {
    post.mockResolvedValue({ message: 'If this email is registered, a reset link has been sent.' })
    expect(await apiForgotPassword(' Kari@X.no ')).toEqual({
      ok: true,
      message: 'If an account uses this email, we have sent it a link to set a new password.',
    })
    expect(post).toHaveBeenCalledWith('/auth/forgot-password', { email: 'Kari@X.no' })
  })

  it('explains too many requests', async () => {
    post.mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'Too many'))
    expect(await apiForgotPassword('k@x.no')).toEqual({ ok: false, message: 'Too many attempts. Wait a few minutes and try again.' })
  })
})

describe('apiResetPassword', () => {
  beforeEach(() => vi.clearAllMocks())

  it('checks the two passwords before calling the server', async () => {
    expect(await apiResetPassword('t'.repeat(43), '', '')).toEqual({ ok: false, message: 'Enter a new password.' })
    expect(await apiResetPassword('t'.repeat(43), 'Abc123!xyz', 'Abc123!xyZ')).toEqual({ ok: false, message: "The two passwords don't match." })
    expect(post).not.toHaveBeenCalled()
  })

  it('refuses a page opened without a link token', async () => {
    expect(await apiResetPassword('', 'Abc123!xyz', 'Abc123!xyz')).toEqual({ ok: false, message: 'This link is incomplete. Ask for a new one.' })
  })

  it('sets the password with the token from the link', async () => {
    post.mockResolvedValue({ message: 'Password reset successful.' })
    expect(await apiResetPassword('tok'.repeat(15), 'Abc123!xyz', 'Abc123!xyz')).toEqual({ ok: true, message: 'Your password is set. You can sign in now.' })
    expect(post).toHaveBeenCalledWith('/auth/reset-password', { token: 'tok'.repeat(15), new_password: 'Abc123!xyz' })
  })

  it("shows the backend's reason: an expired link, or the field rule that failed", async () => {
    post.mockRejectedValueOnce(new ApiError(400, 'VALIDATION_ERROR', 'Reset link is invalid or expired'))
    expect(await apiResetPassword('tok'.repeat(15), 'Abc123!xyz', 'Abc123!xyz')).toEqual({
      ok: false,
      message: 'This link is invalid or has expired. Ask for a new one.',
    })
    post.mockRejectedValueOnce(
      new ApiError(400, 'VALIDATION_ERROR', 'Validation failed', { errors: [{ field: 'new_password', message: 'Password must contain a number.' }] }),
    )
    expect(await apiResetPassword('tok'.repeat(15), 'Abcdefghij!', 'Abcdefghij!')).toEqual({ ok: false, message: 'Password must contain a number.' })
  })
})

describe('apiVerifyMfa', () => {
  it('signs in with the code and keeps the tokens', async () => {
    post.mockReset()
    get.mockReset()
    post.mockResolvedValue({ access_token: 'A', refresh_token: 'R' })
    get.mockResolvedValue(me)
    const out = await apiVerifyMfa('t', ' 123456 ', false)
    expect(post).toHaveBeenCalledWith('/auth/mfa/verify', { mfa_session_token: 't', code: '123456', is_backup_code: false })
    expect(writeTokens).toHaveBeenCalledWith({ access: 'A', refresh: 'R' })
    expect(out).toMatchObject({ ok: true })
  })

  it('says when the code is wrong, and when the step took too long', async () => {
    post.mockReset()
    post.mockRejectedValueOnce(new ApiError(400, 'INVALID_MFA_CODE', 'Invalid MFA code'))
    expect(await apiVerifyMfa('t', '000000', false)).toEqual({ ok: false, field: 'code', message: 'That code is not right. Try the newest code from your app.' })
    post.mockRejectedValueOnce(new ApiError(401, 'TOKEN_EXPIRED', 'MFA session expired, please login again'))
    expect(await apiVerifyMfa('t', '000000', false)).toEqual({ ok: false, field: 'expired', message: 'That took too long. Sign in again.' })
    expect(await apiVerifyMfa('t', '12', false)).toEqual({ ok: false, field: 'code', message: 'Enter the 6-digit code from your app.' })
  })
})
