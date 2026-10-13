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

const { apiSignIn, apiSignOut } = await import('./auth')

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

  it('refuses accounts with two-step sign-in for now, without storing tokens', async () => {
    post.mockResolvedValue({ mfa_required: true, mfa_session_token: 't' })
    expect(await apiSignIn('a@viljetech.com', 'pw')).toEqual({
      ok: false,
      field: 'password',
      message: 'This account uses two-step sign-in, which the new app does not support yet.',
    })
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
