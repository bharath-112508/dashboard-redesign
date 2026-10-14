import { API_URL } from './config'

/** One server-sent event. */
type Event = { event: string; data: string }

/** Complete events in `buffer`, and the incomplete tail to keep for the next chunk. */
export const parseEvents = (buffer: string): { events: Event[]; rest: string } => {
  const blocks = buffer.split('\n\n')
  const rest = blocks.pop() ?? ''
  const events: Event[] = []
  for (const block of blocks) {
    let event = 'message'
    const data: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue // comment / heartbeat
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
    }
    if (data.length) events.push({ event, data: data.join('\n') })
  }
  return { events, rest }
}

/** Backend change topics → the app's query keys that show that data. */
const KEYS_OF: Record<string, string[]> = {
  tasks: ['tasks', 'ticketDetails', 'entries'],
  'task-comments': ['ticketDetails'],
  projects: ['workspace', 'tasks', 'companies', 'internalProjects', 'people'],
  sprints: ['workspace', 'tasks', 'companies'],
  stories: ['workspace', 'tasks', 'companies'],
  timesheets: ['entries', 'weekSubmissions', 'companies'],
  leaves: ['leave', 'notifications', 'leaveBook'],
  'leave-balances': ['leaveBook'],
  users: ['people'],
  roles: ['access'],
  settings: ['access'],
  companies: ['companies', 'people'],
}

export const queryKeysFor = (topics: string[]): string[] => [...new Set(topics.flatMap(t => KEYS_OF[t] ?? []))]

interface Deps {
  fetchFn: typeof fetch
  /** The current access token, or null when signed out. */
  token: () => string | null
  /** Renews the access token (a call through the API client does it). */
  refreshToken: () => Promise<unknown>
  wait: (ms: number) => Promise<void>
  /** Changes arriving within this window are refreshed together. */
  batchMs: number
}

/**
 * Keeps the backend's change stream open for the signed-in person and calls
 * `onKeys` with the query keys to refresh when someone changes data. The
 * events carry topic names only, so what is shown is always refetched with
 * the person's own rights. Reconnects with backoff; returns a stop function.
 */
export const startLiveUpdates = (onKeys: (keys: string[]) => void, deps: Deps): (() => void) => {
  let stopped = false
  let controller: AbortController | null = null
  let pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    const keys = [...pending]
    pending = new Set()
    if (keys.length) onKeys(keys)
  }
  const queue = (keys: string[]) => {
    keys.forEach(k => pending.add(k))
    if (!timer) timer = setTimeout(flush, deps.batchMs)
  }

  const run = async () => {
    let backoff = 1000
    while (!stopped) {
      const token = deps.token()
      if (!token) {
        await deps.wait(5000)
        continue
      }
      controller = new AbortController()
      // Signed out, or someone else signed in: drop this stream and reconnect with the new token.
      const current = controller
      const watch = setInterval(() => {
        if (deps.token() !== token) current.abort()
      }, 5000)
      try {
        const res = await deps.fetchFn(`${API_URL}/events/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (res.status === 401) {
          await deps.refreshToken().catch(() => undefined)
        } else if (res.ok && res.body) {
          backoff = 1000
          const reader = res.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stopped) break
            const parsed = parseEvents(buffer + decoder.decode(value, { stream: true }))
            buffer = parsed.rest
            for (const e of parsed.events) {
              if (e.event !== 'change') continue
              try {
                queue(queryKeysFor((JSON.parse(e.data) as { topics?: string[] }).topics ?? []))
              } catch {
                // A malformed event is skipped.
              }
            }
          }
        }
      } catch {
        // Network error or aborted: reconnect below.
      } finally {
        clearInterval(watch)
      }
      if (stopped) break
      await deps.wait(backoff)
      backoff = Math.min(backoff * 2, 30_000)
    }
  }
  void run()

  return () => {
    stopped = true
    controller?.abort()
    if (timer) clearTimeout(timer)
  }
}
