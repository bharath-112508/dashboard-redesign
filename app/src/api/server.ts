import { assignIds, createdId, reduce, type Command } from './commands'
import { createSeed, DB_VERSION, personIdByName } from './seed'
import { PEOPLE_SEED } from './people/seed'
import { COMPANIES_SEED } from './companies/seed'
import { INTERNAL_PROJECTS_SEED, withDriverAppSupport } from './projects/seed'
import type { Db } from './types'
import { setSaveProblem } from '../components/SaveNotice'

/**
 * A mock backend. Data lives in localStorage so it survives reloads and is
 * shared between open tabs, and every call waits a little like a network
 * request would. Swap these functions for real HTTP calls later; the React
 * Query hooks in queries.ts don't need to change.
 *
 * Storage:
 * - `vt.clients.db` (localStorage) holds the db as JSON. Attachment contents
 *   are left out of it: each one is written as `idb:<id>`.
 * - IndexedDB `vt-clients-files` holds the attachment contents, one record
 *   per id. It has far more room than localStorage's few megabytes.
 *
 * If storage is full or blocked, a save is retried without the attachments
 * that could not be kept, and a notice says which ones were not saved. The
 * in-memory copy always keeps the change, so later saves still go through.
 */

export type SendResult = { id?: number }

const KEY = 'vt.clients.db'
const LATENCY_MS = 180
const FILES_DB = 'vt-clients-files'
const FILES_STORE = 'files'
const REF = 'idb:'
/** Attachment contents nothing refers to are deleted after this long. */
const COLLECT_AFTER_MS = 10 * 60_000

const DAMAGED =
  'The data saved in this browser could not be read, so sample data is shown. Changes you make from now on are saved over it.'
const SAVE_FAILED =
  'Your last change could not be saved because browser storage is full or blocked. It is still on screen, but it will be lost if you reload.'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const clone = <T>(v: T): T => structuredClone(v)

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isData = (v: unknown): v is string => typeof v === 'string' && v.startsWith('data:')

/** Usable only with the current version and every collection the app reads. */
const isDb = (v: unknown): v is Db => {
  if (!isObj(v) || v.version !== DB_VERSION || !isObj(v.devops)) return false
  const ws = v.workspace
  if (!isObj(ws) || !isObj(ws.devopsLinks)) return false
  return (
    ['statuses', 'epics', 'sprints'].every(k => Array.isArray(ws[k])) &&
    ['tasks', 'entries', 'questions', 'requests', 'people', 'companies', 'internalProjects'].every(k => Array.isArray(v[k]))
  )
}

/**
 * Brings a version 2 db up to the current version: adds the people, companies
 * and internal projects collections, and gives each time entry its person id.
 * Everything else is kept, so nobody loses their tickets on upgrade.
 */
const migrate = (v: unknown): unknown => {
  if (isObj(v) && v.version === 2) return migrate3(upgrade2(v))
  if (isObj(v) && (v.version === 3 || v.version === DB_VERSION)) return migrate3(v)
  return v
}

/**
 * Version 3 gains the leave, notifications and client team collections, and an
 * internal project seed for stores that never had one. Per-ticket hours kept in
 * task.time stay where they are (they still count on the tickets).
 */
const migrate3 = (v: Record<string, unknown>): unknown => ({
  ...v,
  version: DB_VERSION,
  leave: Array.isArray(v.leave) ? v.leave : [],
  notifications: Array.isArray(v.notifications) ? v.notifications : [],
  clientTeam: Array.isArray(v.clientTeam) ? v.clientTeam : [],
  internalProjects: Array.isArray(v.internalProjects) && v.internalProjects.length ? v.internalProjects : clone(INTERNAL_PROJECTS_SEED),
  weekSubmissions: Array.isArray(v.weekSubmissions) ? v.weekSubmissions : [],
  companies: withDriverAppSupport(v.companies),
})

/** Version 2 gains people, companies, internal projects and per-entry person ids. */
const upgrade2 = (v: Record<string, unknown>): Record<string, unknown> => {
  const entries = Array.isArray(v.entries)
    ? v.entries.map(e => (isObj(e) && e.userId === undefined ? { ...e, userId: personIdByName(String(e.user)) } : e))
    : v.entries
  return {
    ...v,
    version: 2,
    people: clone(PEOPLE_SEED),
    companies: clone(COMPANIES_SEED),
    internalProjects: [],
    entries,
    weekSubmissions: [],
  }
}

/** Calls fn for every object with a `url` string inside v (attachments, chat files and the like). */
const eachUrlHolder = (v: unknown, fn: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(v)) v.forEach(x => eachUrlHolder(x, fn))
  else if (isObj(v)) {
    if (typeof v.url === 'string') fn(v)
    for (const k of Object.keys(v)) if (k !== 'url') eachUrlHolder(v[k], fn)
  }
}

const tryParse = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

const readRaw = (): string | null => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

const tryStore = (json: string): boolean => {
  try {
    localStorage.setItem(KEY, json)
    return true
  } catch {
    return false
  }
}

// ---------- attachment contents in IndexedDB

let filesDb: Promise<IDBDatabase> | null = null

const openFiles = (): Promise<IDBDatabase> => {
  if (!filesDb) {
    filesDb = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(FILES_DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(FILES_STORE)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    filesDb.catch(() => {
      filesDb = null
    })
  }
  return filesDb
}

/** Runs one request in a transaction and resolves with its result once the transaction commits. */
const filesTx = async <T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await openFiles()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, mode)
    const req = run(tx.objectStore(FILES_STORE))
    tx.oncomplete = () => resolve(req.result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

/** Attachment contents already in IndexedDB, both ways, so a save does not write them again. */
const idOfPayload = new Map<string, string>()
const payloadOfId = new Map<string, string>()

const newFileId = () => `f${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
const fileTime = (id: string) => parseInt(id.slice(1, id.indexOf('-')), 36)

/** The id of a payload's stored copy, writing it to IndexedDB the first time. */
const storePayload = async (payload: string): Promise<string> => {
  const known = idOfPayload.get(payload)
  if (known) return known
  const id = newFileId()
  await filesTx('readwrite', s => s.put(payload, id))
  idOfPayload.set(payload, id)
  payloadOfId.set(id, payload)
  return id
}

/** Stores the attachments a command brings in, so the db written next stays small. */
const storeCommandFiles = async (cmd: Command) => {
  const pending = new Set<string>()
  eachUrlHolder(cmd, o => {
    if (isData(o.url) && !idOfPayload.has(o.url)) pending.add(o.url)
  })
  for (const p of pending) {
    try {
      await storePayload(p)
    } catch {
      // Stays inline; commit() handles it if the db then does not fit.
    }
  }
}

/** Moves attachments still inline (from older saves, or after a failed write) into IndexedDB in the background. */
const storeInlineInBackground = (db: Db) => {
  const pending = new Set<string>()
  eachUrlHolder(db, o => {
    if (isData(o.url) && !idOfPayload.has(o.url)) pending.add(o.url)
  })
  pending.forEach(p => {
    storePayload(p).catch(() => undefined)
  })
}

/** Deletes stored attachment contents that nothing refers to, leaving recent ones alone. */
const collect = async (refs: Set<string>) => {
  const keys = (await filesTx('readonly', s => s.getAllKeys())).map(String)
  const old = keys.filter(k => !refs.has(k) && Date.now() - fileTime(k) > COLLECT_AFTER_MS)
  if (!old.length) return
  const db = await openFiles()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FILES_STORE, 'readwrite')
    const store = tx.objectStore(FILES_STORE)
    old.forEach(k => store.delete(k))
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
  old.forEach(k => {
    const p = payloadOfId.get(k)
    payloadOfId.delete(k)
    if (p !== undefined) idOfPayload.delete(p)
  })
}

// ---------- the db in memory and in localStorage

/** The working copy. It keeps every change, even when storage refused to save it. */
let memory: Db | null = null
/** The localStorage text `memory` was last read from or written as. */
let stored: string | null | undefined = undefined

/** Reads the stored text into a db. Anything missing or damaged falls back to seed data. */
const hydrate = async (raw: string | null): Promise<Db> => {
  if (raw === null) return createSeed()
  const parsed = migrate(tryParse(raw))
  if (!isDb(parsed)) {
    console.warn('[clients] Stored data is missing or damaged. Using the seed data instead.')
    setSaveProblem(DAMAGED)
    return createSeed()
  }
  // Stores written before the Clients portal have no client team yet.
  if (!Array.isArray(parsed.clientTeam)) parsed.clientTeam = []

  const ids = new Set<string>()
  eachUrlHolder(parsed, o => {
    if (typeof o.url === 'string' && o.url.startsWith(REF)) ids.add(o.url.slice(REF.length))
  })
  const found = new Map<string, string>()
  await Promise.all(
    [...ids].map(async id => {
      try {
        const v = await filesTx('readonly', s => s.get(id))
        if (typeof v === 'string') found.set(id, v)
      } catch {
        // Reported below as missing.
      }
    }),
  )

  let missing = 0
  eachUrlHolder(parsed, o => {
    if (typeof o.url !== 'string' || !o.url.startsWith(REF)) return
    const id = o.url.slice(REF.length)
    const payload = found.get(id)
    if (payload === undefined) {
      missing++
      o.url = ''
      return
    }
    o.url = payload
    idOfPayload.set(payload, id)
    payloadOfId.set(id, payload)
  })
  if (missing) {
    console.warn(`[clients] ${missing} attachment(s) could not be read from browser storage.`)
    setSaveProblem(
      `${missing === 1 ? 'An attachment' : missing + ' attachments'} could not be read from browser storage, so ${
        missing === 1 ? 'it shows' : 'they show'
      } only the name.`,
    )
  }
  return parsed
}

/** The current db. Reads localStorage again whenever another tab has changed it. */
const current = async (): Promise<Db> => {
  const raw = readRaw()
  if (memory && raw === stored) return memory
  const db = await hydrate(raw)
  memory = db
  stored = raw
  return db
}

type Serialized = { json: string; refs: Set<string>; inline: string[] }

/**
 * The db as stored. Attachment contents with a copy in IndexedDB become refs.
 * Contents without one stay inline, or are dropped when `strip` is set; their
 * names are returned in `inline` either way.
 */
const serialize = (db: Db, strip: boolean): Serialized => {
  const refs = new Set<string>()
  const inline: string[] = []
  const json = JSON.stringify(db, function (this: unknown, key: string, value: unknown) {
    if (key !== 'url' || !isData(value)) return value
    const id = idOfPayload.get(value)
    if (id) {
      refs.add(id)
      return REF + id
    }
    inline.push(String((this as { name?: unknown }).name ?? 'attachment'))
    return strip ? '' : value
  })
  return { json, refs, inline }
}

const droppedText = (names: string[]) => {
  const listed = names
    .slice(0, 3)
    .map(n => `“${n}”`)
    .join(', ')
  const more = names.length > 3 ? ` and ${names.length - 3} more` : ''
  const one = names.length === 1
  return (
    `Browser storage is full, so ${one ? 'an attachment' : names.length + ' attachments'} (${listed}${more}) ` +
    `could not be saved. Everything else was saved. After a reload ${one ? 'it' : 'they'} will show only the name.`
  )
}

/** Writes the db. Falls back to a copy without the unsaved attachments, and reports what was left out. */
const commit = (db: Db) => {
  memory = db
  const full = serialize(db, false)
  if (tryStore(full.json)) {
    stored = full.json
    setSaveProblem(null)
    void collect(full.refs).catch(() => undefined)
    storeInlineInBackground(db)
    return
  }
  const slim = serialize(db, true)
  if (slim.inline.length && tryStore(slim.json)) {
    stored = slim.json
    setSaveProblem(droppedText(slim.inline))
    void collect(slim.refs).catch(() => undefined)
    storeInlineInBackground(db)
    return
  }
  // Nothing could be stored. `memory` keeps the change, and the next save tries again.
  setSaveProblem(SAVE_FAILED)
}

// Storage operations run one at a time in this tab.
let queue: Promise<unknown> = Promise.resolve()
const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn)
  queue = run.catch(() => undefined)
  return run
}

/**
 * Runs a read-modify-write of the db one tab at a time. Reads of localStorage
 * can lag behind another tab's write, so without this two tabs can both
 * start from the same copy and the second write drops the first.
 */
const acrossTabs = <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof navigator === 'undefined' || !navigator.locks) return fn()
  // The lib typing does not allow an async callback; the lock does wait for the promise it returns.
  return navigator.locks.request(KEY, () => fn()) as unknown as Promise<T>
}

export const server = {
  async get<K extends Exclude<keyof Db, 'version'>>(resource: K): Promise<Db[K]> {
    await sleep(LATENCY_MS)
    return exclusive(async () => clone((await current())[resource]))
  },

  /** Applies a command and resolves with what it did (the id of a new task, for example). */
  async send(cmd: Command): Promise<SendResult> {
    await sleep(LATENCY_MS)
    return exclusive(() =>
      acrossTabs(async () => {
        await storeCommandFiles(cmd)
        for (;;) {
          const base = await current()
          const applied = assignIds(base, cmd)
          const next = reduce(base, applied)
          // Another tab saved while this was being prepared: apply the command to its copy instead.
          if (readRaw() !== stored) continue
          commit(next)
          return { id: createdId(applied) }
        }
      }),
    )
  },

  /** Wipe local changes and start again from the seed data. */
  reset() {
    memory = null
    stored = undefined
    try {
      localStorage.removeItem(KEY)
    } catch {
      // ignore
    }
    idOfPayload.clear()
    payloadOfId.clear()
    filesTx('readwrite', s => s.clear()).catch(() => undefined)
    setSaveProblem(null)
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
