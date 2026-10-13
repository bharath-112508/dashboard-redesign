import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import { readTokens, writeTokens } from './tokens'

const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
})

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const authOf = (init: RequestInit) => (init.headers as Record<string, string>).Authorization

describe('api client', () => {
  beforeEach(() => {
    store.clear()
    writeTokens({ access: 'a1', refresh: 'r1' })
  })

  it('sends the bearer token and unwraps { data }', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => json(200, { data: { id: 'u1' } }))
    const api = createClient('http://x/api/v1', f)
    expect(await api.get('/auth/me')).toEqual({ id: 'u1' })
    expect(f.mock.calls[0][0]).toBe('http://x/api/v1/auth/me')
    expect(authOf(f.mock.calls[0][1])).toBe('Bearer a1')
  })

  it('throws an ApiError carrying the status and the backend error code', async () => {
    const f = vi.fn(async () => json(403, { error: { code: 'ACCOUNT_DEACTIVATED', message: 'no' } }))
    const api = createClient('http://x/api/v1', f)
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ status: 403, code: 'ACCOUNT_DEACTIVATED' })
  })

  it('does not try to refresh when the login itself is refused', async () => {
    const f = vi.fn(async () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'no' } }))
    const api = createClient('http://x/api/v1', f)
    await expect(api.post('/auth/login', {})).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' })
    expect(f).toHaveBeenCalledTimes(1)
  })

  it('refreshes once for parallel 401s, then retries each call with the new token', async () => {
    let refreshes = 0
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++
        return json(200, { data: { access_token: 'a2', refresh_token: 'r2' } })
      }
      return authOf(init) === 'Bearer a2' ? json(200, { data: 'ok' }) : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } })
    })
    const api = createClient('http://x/api/v1', f)
    expect(await Promise.all([api.get('/a'), api.get('/b'), api.get('/c')])).toEqual(['ok', 'ok', 'ok'])
    expect(refreshes).toBe(1)
    expect(readTokens()).toEqual({ access: 'a2', refresh: 'r2' })
  })

  it('clears the tokens and reports sign-out when the refresh is refused', async () => {
    const signedOut = vi.fn()
    const f = vi.fn(async (url: string) =>
      url.endsWith('/auth/refresh')
        ? json(401, { error: { code: 'INVALID_TOKEN', message: '' } })
        : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } }),
    )
    const api = createClient('http://x/api/v1', f, signedOut)
    await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
    expect(readTokens()).toBeNull()
    expect(signedOut).toHaveBeenCalledOnce()
  })

  it('keeps the tokens and stays signed in when the refresh fails for a reason other than refusal', async () => {
    for (const failure of [() => Promise.reject(new TypeError('Failed to fetch')), () => Promise.resolve(json(503, {})), () => Promise.resolve(json(429, {}))]) {
      writeTokens({ access: 'a1', refresh: 'r1' })
      const signedOut = vi.fn()
      const f = vi.fn((url: string) => (url.endsWith('/auth/refresh') ? failure() : Promise.resolve(json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } }))))
      const api = createClient('http://x/api/v1', f, signedOut)
      await expect(api.get('/a')).rejects.toMatchObject({ status: 401 })
      expect(readTokens()).toEqual({ access: 'a1', refresh: 'r1' })
      expect(signedOut).not.toHaveBeenCalled()
    }
  })

  it('retries without refreshing when another tab has already refreshed the tokens', async () => {
    let refreshes = 0
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++
        return json(401, { error: { code: 'INVALID_TOKEN', message: '' } })
      }
      if (authOf(init) === 'Bearer a1') {
        // Another tab refreshed while this call was in flight.
        writeTokens({ access: 'a2', refresh: 'r2' })
        return json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } })
      }
      return json(200, { data: 'ok' })
    })
    const api = createClient('http://x/api/v1', f)
    expect(await api.get('/a')).toBe('ok')
    expect(refreshes).toBe(0)
  })

  it('refreshes once across two tabs that hit a 401 at the same time', async () => {
    // Two clients share localStorage like two tabs do; navigator.locks serialises their refresh.
    let tail = Promise.resolve()
    vi.stubGlobal('navigator', {
      locks: {
        request: <T>(_name: string, cb: () => Promise<T>) => {
          const run = tail.then(cb)
          tail = run.then(() => undefined, () => undefined)
          return run
        },
      },
    })
    let refreshes = 0
    const f = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/auth/refresh')) {
        refreshes++
        // The backend treats a reused refresh token as theft and revokes everything.
        if (refreshes > 1) return json(401, { error: { code: 'INVALID_TOKEN', message: '' } })
        return json(200, { data: { access_token: 'a2', refresh_token: 'r2' } })
      }
      return authOf(init) === 'Bearer a2' ? json(200, { data: 'ok' }) : json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } })
    })
    const tabA = createClient('http://x/api/v1', f)
    const tabB = createClient('http://x/api/v1', f)
    expect(await Promise.all([tabA.get('/a'), tabB.get('/b')])).toEqual(['ok', 'ok'])
    expect(refreshes).toBe(1)
    vi.unstubAllGlobals()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
  })

  it('does not bring tokens back when the user signed out while a refresh was in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const f = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/refresh')) {
        await gate
        return json(200, { data: { access_token: 'a2', refresh_token: 'r2' } })
      }
      return json(401, { error: { code: 'TOKEN_EXPIRED', message: '' } })
    })
    const api = createClient('http://x/api/v1', f)
    const pending = api.get('/a').catch(() => 'refused')
    await new Promise(r => setTimeout(r, 0))
    store.delete('vt.tokens') // sign-out
    release()
    await pending
    expect(readTokens()).toBeNull()
  })

  it('sends DELETE with the bearer token', async () => {
    const f = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }))
    const api = createClient('http://x/api/v1', f)
    expect(await api.delete('/companies/c1/representatives/u1')).toBeUndefined()
    expect(f.mock.calls[0][1].method).toBe('DELETE')
    expect(authOf(f.mock.calls[0][1])).toBe('Bearer a1')
  })

  it('returns undefined for 204 No Content', async () => {
    const api = createClient('http://x/api/v1', vi.fn(async () => new Response(null, { status: 204 })))
    expect(await api.post('/auth/logout', { refresh_token: 'r1' })).toBeUndefined()
  })
})
