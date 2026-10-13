import { API_URL } from './config'
import { clearTokens, readTokens, writeTokens, type Tokens } from './tokens'

/** A failed API call: the HTTP status and the backend's stable error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/**
 * Runs `fn` while holding a lock shared by every tab, so only one tab refreshes
 * at a time. Without Web Locks (old browsers, tests) it just runs `fn`.
 */
const acrossTabs = <T>(fn: () => Promise<T>): Promise<T> =>
  typeof navigator !== 'undefined' && navigator.locks
    ? // The DOM typing nests the promise; request() resolves with fn's settled value.
      (navigator.locks.request('vt-refresh', fn) as unknown as Promise<T>)
    : fn()

/**
 * A client for the backend's `/api/v1`. It sends the access token, unwraps the
 * `{ data }` envelope and, when a call comes back 401, refreshes the tokens
 * and retries once.
 *
 * The backend rotates the refresh token and treats a reused one as stolen,
 * revoking every session the user has. So a refresh must never be sent twice
 * with the same token: calls in this tab share one refresh, tabs take turns
 * through a lock, and a tab that finds the tokens already refreshed by another
 * just retries. Only a refused refresh (401/403) signs the user out; a network
 * error, 5xx or 429 keeps the tokens so the next call can try again.
 */
export const createClient = (base: string, fetchImpl: Fetch, signedOut: () => void = () => undefined) => {
  let refreshing: Promise<boolean> | null = null

  /** Refreshes the tokens a call was sent with. True when there are fresh tokens to retry with. */
  const refresh = (sent: Tokens): Promise<boolean> =>
    (refreshing ??= acrossTabs(async () => {
      const t = readTokens()
      if (!t) return false
      if (t.refresh !== sent.refresh) return true // another tab already refreshed
      const res = await fetchImpl(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      }).catch(() => null)
      if (res && (res.status === 401 || res.status === 403)) {
        clearTokens()
        signedOut()
        return false
      }
      if (!res?.ok) return false
      const { data } = (await res.json()) as { data: { access_token: string; refresh_token: string } }
      // Signed out while the refresh was in flight: do not bring the tokens back.
      if (readTokens()?.refresh !== t.refresh) return false
      writeTokens({ access: data.access_token, refresh: data.refresh_token })
      return true
    }).finally(() => {
      refreshing = null
    }))

  const call = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T> => {
    const t = readTokens()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (t) headers.Authorization = `Bearer ${t.access}`
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status === 401 && t && !retried && !path.startsWith('/auth/login')) {
      const now = readTokens()
      // Another tab refreshed while this call was in flight: retry with its tokens.
      if (now && now.access !== t.access) return call<T>(method, path, body, true)
      if (await refresh(t)) return call<T>(method, path, body, true)
    }
    if (res.status === 204) return undefined as T
    const payload = (await res.json().catch(() => ({}))) as { data?: T; error?: { code?: string; message?: string } }
    if (!res.ok) throw new ApiError(res.status, payload.error?.code ?? 'UNKNOWN', payload.error?.message ?? res.statusText)
    return payload.data as T
  }

  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body),
    patch: <T>(path: string, body?: unknown) => call<T>('PATCH', path, body),
    delete: <T>(path: string) => call<T>('DELETE', path),
  }
}

const signedOutListeners = new Set<() => void>()

/** Runs `cb` when the session cannot be refreshed any more (expired, or signed out elsewhere). */
export const onSignedOut = (cb: () => void) => {
  signedOutListeners.add(cb)
}

export const api = createClient(API_URL, (url, init) => fetch(url, init), () => signedOutListeners.forEach(cb => cb()))
