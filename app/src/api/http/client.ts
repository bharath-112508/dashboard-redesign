import { API_URL } from './config'
import { clearTokens, readTokens, writeTokens } from './tokens'

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
 * A client for the backend's `/api/v1`. It sends the access token, unwraps the
 * `{ data }` envelope and, when a call comes back 401, refreshes the tokens
 * once (parallel calls share that one refresh) and retries. If the refresh is
 * refused the tokens are dropped and `signedOut` runs.
 */
export const createClient = (base: string, fetchImpl: Fetch, signedOut: () => void = () => undefined) => {
  let refreshing: Promise<boolean> | null = null

  const refresh = (): Promise<boolean> =>
    (refreshing ??= (async () => {
      const t = readTokens()
      if (!t) return false
      const res = await fetchImpl(`${base}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: t.refresh }),
      }).catch(() => null)
      if (!res?.ok) {
        clearTokens()
        signedOut()
        return false
      }
      const { data } = (await res.json()) as { data: { access_token: string; refresh_token: string } }
      writeTokens({ access: data.access_token, refresh: data.refresh_token })
      return true
    })().finally(() => {
      refreshing = null
    }))

  const call = async <T>(method: string, path: string, body?: unknown, retried = false): Promise<T> => {
    const t = readTokens()
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (t) headers.Authorization = `Bearer ${t.access}`
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (res.status === 401 && t && !retried && !path.startsWith('/auth/login') && (await refresh())) {
      return call<T>(method, path, body, true)
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
  }
}

const signedOutListeners = new Set<() => void>()

/** Runs `cb` when the session cannot be refreshed any more (expired, or signed out elsewhere). */
export const onSignedOut = (cb: () => void) => {
  signedOutListeners.add(cb)
}

export const api = createClient(API_URL, (url, init) => fetch(url, init), () => signedOutListeners.forEach(cb => cb()))
