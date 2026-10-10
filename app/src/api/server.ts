import { reduce, type Command } from './commands'
import { createSeed, DB_VERSION } from './seed'
import type { Db } from './types'

/**
 * A mock backend. Data lives in localStorage so it survives reloads and is
 * shared between open tabs, and every call waits a little like a network
 * request would. Swap these functions for real HTTP calls later; the React
 * Query hooks in queries.ts don't need to change.
 */

const KEY = 'vt.clients.db'
const LATENCY_MS = 180

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let memory: Db | null = null

const load = (): Db => {
  if (memory) return memory
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const db = JSON.parse(raw) as Db
      if (db.version === DB_VERSION) return (memory = db)
    }
  } catch {
    // Storage blocked or corrupt: fall back to fresh seed data.
  }
  return (memory = createSeed())
}

// Another tab saved: drop the in-memory copy so the next read picks it up.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key === KEY) memory = null
  })
}

const save = (db: Db) => {
  memory = db
  try {
    localStorage.setItem(KEY, JSON.stringify(db))
  } catch {
    // Quota exceeded (large attachments) or storage blocked: keep it in memory.
  }
}

const clone = <T>(v: T): T => structuredClone(v)

export const server = {
  async get<K extends Exclude<keyof Db, 'version'>>(resource: K): Promise<Db[K]> {
    await sleep(LATENCY_MS)
    return clone(load()[resource])
  },

  async send(cmd: Command): Promise<void> {
    await sleep(LATENCY_MS)
    save(reduce(load(), cmd))
  },

  /** Wipe local changes and start again from the seed data. */
  reset() {
    memory = null
    try {
      localStorage.removeItem(KEY)
    } catch {
      // ignore
    }
  },

  /** Calls back when another tab changes the data. */
  subscribe(onChange: () => void) {
    const h = (e: StorageEvent) => {
      if (e.key === KEY) onChange()
    }
    window.addEventListener('storage', h)
    return () => window.removeEventListener('storage', h)
  },
}
