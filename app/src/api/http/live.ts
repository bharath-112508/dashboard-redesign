import { API_URL } from './config'

/** One server-sent event. */
type Event = { event: string; data: string }

/** Complete events in `buffer`, and the incomplete tail to keep for the next chunk. */
export const parseEvents = (buffer: string): { events: Event[]; rest: string } => {
  const blocks = buffer.replace(/\r\n?/g, '\n').split('\n\n')
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
  sprints: ['workspace', 'tasks'],
  stories: ['workspace', 'tasks', 'companies'],
  timesheets: ['entries', 'weekSubmissions', 'companies', 'projectHours'],
  leaves: ['leave', 'notifications', 'leaveBook'],
  'leave-balances': ['leaveBook'],
  // Client contacts are users too, shown on the Companies pages.
  users: ['people', 'companies'],
  roles: ['access'],
  settings: ['access'],
  companies: ['companies', 'people'],
  // DevOps items also link epics to them (workspace.devopsLinks).
  devops: ['devops', 'workspace'],
  questions: ['questions'],
  'devops-requests': ['requests'],
}

export const queryKeysFor = (topics: string[]): string[] => [...new Set(topics.flatMap(t => KEYS_OF[t] ?? []))]

/** Every key a change can touch: refreshed after a reconnect, since what changed meanwhile sent no event. */
const ALL_KEYS = [...new Set(Object.values(KEYS_OF).flat())]

/** Keys whose read is heavy (companies fans out per project and company): refreshed less often. */
const HEAVY = new Set(['companies'])

interface Deps {
  fetchFn: typeof fetch
  /** The current access token, or null when signed out. */
  token: () => string | null
  /** Who is signed in; the stream is reopened when this changes (not on every token renewal). */
  who: () => string | null
  /** Renews the access token (a call through the API client does it). */
  refreshToken: () => Promise<unknown>
  wait: (ms: number) => Promise<void>
  /** Changes arriving within this window are refreshed together. */
  batchMs: number
  /** The window for heavy keys (default: batchMs). */
  heavyBatchMs?: number
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
  const batch = (ms: number) => ({ keys: new Set<string>(), timer: null as ReturnType<typeof setTimeout> | null, ms })
  const batches = [batch(deps.batchMs), batch(deps.heavyBatchMs ?? deps.batchMs)]
  const queue = (keys: string[]) => {
    for (const k of keys) {
      const b = batches[HEAVY.has(k) ? 1 : 0]
      b.keys.add(k)
      b.timer ??= setTimeout(() => {
        b.timer = null
        const out = [...b.keys]
        b.keys = new Set()
        if (out.length) onKeys(out)
      }, b.ms)
    }
  }

  const run = async () => {
    let backoff = 1000
    let connectedBefore = false
    while (!stopped) {
      const token = deps.token()
      if (!token) {
        await deps.wait(5000)
        continue
      }
      controller = new AbortController()
      // Signed out, or someone else signed in: drop this stream and reconnect.
      // (A renewed token for the same person keeps the stream: it was checked at connect.)
      const current = controller
      const person = deps.who()
      const watch = setInterval(() => {
        if (!deps.token() || deps.who() !== person) current.abort()
      }, 5000)
      try {
        const res = await deps.fetchFn(`${API_URL}/events/stream`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
          signal: controller.signal,
        })
        if (res.status === 401) {
          await deps.refreshToken().catch(() => undefined)
        } else if (res.ok && res.body) {
          const reader = res.body.getReader()
          let first = true
          const decoder = new TextDecoder()
          let buffer = ''
          for (;;) {
            const { value, done } = await reader.read()
            if (done || stopped) break
            if (first) {
              first = false
              // Data arrived, so the stream works: reset the backoff, and after a reconnect
              // refresh everything, since what changed while it was down sent no event.
              backoff = 1000
              if (connectedBefore) queue(ALL_KEYS)
              connectedBefore = true
            }
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
    for (const b of batches) if (b.timer) clearTimeout(b.timer)
  }
}
