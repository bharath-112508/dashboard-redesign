import { assignIds, createdId, reduce, type Command } from './commands'
import { createSeed, DB_VERSION, personIdByName } from './seed'
import { PEOPLE_SEED } from './people/seed'
import { COMPANIES_SEED } from './companies/seed'
import { INTERNAL_PROJECTS_SEED, withDriverAppSupport } from './projects/seed'
import { linkDevopsProjects, upgradeDevopsNames } from './devops/seed'
import { withInvoiceMatch } from '../features/invoice-match/commands'
import { linkChatAnswers } from './clients/commands'
import type { Db, TaskId } from './types'
import { setSaveProblem } from '../components/SaveNotice'
import { refusal } from './session/permissions'
import { readSession } from './session/store'
import { apiMode } from './http/config'
import { fetchCompanies, fetchInternalProjects, isCompanyApiCommand, sendCompanyCommand } from './http/companies'
import { ApiError } from './http/client'
import { fetchTasks, fetchWorkspace, isBoardApiCommand, sendBoardCommand } from './http/board'
import { fetchEntries, fetchWeekSubmissions, isTimeApiCommand, sendTimeCommand } from './http/timesheet'
import { fetchAccessApi, fetchPeopleApi, isUserApiCommand, sendUserCommand } from './http/users'

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

/** What a write did: the mock's numeric id for a new item, or (API mode) the backend's id. */
export type SendResult = { id?: TaskId; apiId?: string }

/** Thrown by `server.send` when the signed-in person's role may not run the command (see session/permissions.ts). */
export class RefusedError extends Error {}

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
  if (isObj(v) && v.version === 2) return stringEntryIds(stringTaskIds(stringPersonIds(migrate3(upgrade2(v)))))
  if (isObj(v) && typeof v.version === 'number' && v.version >= 3 && v.version <= DB_VERSION) return stringEntryIds(stringTaskIds(stringPersonIds(migrate3(v))))
  return v
}

/**
 * Version 5: person ids are strings, as the backend's are. Converts every
 * stored person reference; ids that are already strings are left alone, so it
 * is safe to run on every load.
 */
export const stringPersonIds = (v: unknown): unknown => {
  if (!isObj(v)) return v
  const s = (x: unknown) => (typeof x === 'number' ? String(x) : x)
  const each = (list: unknown, fn: (o: Record<string, unknown>) => Record<string, unknown>) =>
    Array.isArray(list) ? list.map(o => (isObj(o) ? fn(o) : o)) : list
  const withUser = (o: Record<string, unknown>) => ({ ...o, userId: s(o.userId) })
  const withTeam = (o: Record<string, unknown>) => (Array.isArray(o.team) ? { ...o, team: o.team.map(s) } : o)
  return {
    ...v,
    version: DB_VERSION,
    people: each(v.people, p => ({ ...p, id: s(p.id) })),
    entries: each(v.entries, withUser),
    weekSubmissions: each(v.weekSubmissions, withUser),
    leave: each(v.leave, withUser),
    notifications: each(v.notifications, withUser),
    internalProjects: each(v.internalProjects, withTeam),
    companies: each(v.companies, c => ({
      ...c,
      contacts: each(c.contacts, k => ({ ...k, personId: s(k.personId) })),
      projects: each(c.projects, withTeam),
    })),
  }
}

/** Version 7: time entry ids are strings, as the backend's are. Safe to run on every load. */
export const stringEntryIds = (v: unknown): unknown => {
  if (!isObj(v)) return v
  return {
    ...v,
    version: DB_VERSION,
    entries: Array.isArray(v.entries) ? v.entries.map(e => (isObj(e) && typeof e.id === 'number' ? { ...e, id: String(e.id) } : e)) : v.entries,
  }
}

/**
 * Version 6: ticket ids are strings, as the backend's are. Converts every
 * stored ticket reference; safe to run on every load.
 */
export const stringTaskIds = (v: unknown): unknown => {
  if (!isObj(v)) return v
  const s = (x: unknown) => (typeof x === 'number' ? String(x) : x)
  const each = (list: unknown, fn: (o: Record<string, unknown>) => Record<string, unknown>) =>
    Array.isArray(list) ? list.map(o => (isObj(o) ? fn(o) : o)) : list
  const withTask = (o: Record<string, unknown>) => ('task' in o ? { ...o, task: s(o.task) } : o)
  return {
    ...v,
    version: DB_VERSION,
    tasks: each(v.tasks, t => ({
      ...t,
      id: s(t.id),
      ...(Array.isArray(t.deps) ? { deps: t.deps.map(s) } : {}),
      ...('parent' in t ? { parent: s(t.parent) } : {}),
      ...(Array.isArray(t.subs) ? { subs: each(t.subs, k => ('sid' in k ? { ...k, sid: s(k.sid) } : k)) } : {}),
    })),
    entries: each(v.entries, withTask),
    questions: each(v.questions, withTask),
  }
}

/**
 * Version 3 gains the leave, notifications and client team collections, and an
 * internal project seed for stores that never had one. Per-ticket hours kept in
 * task.time stay where they are (they still count on the tickets).
 */
const migrate3 = (v: Record<string, unknown>): unknown => devopsProjects(migrate3base(v))

// v5: the InvoiceMatch project (workspace, tasks and Daco's company) and its live app's invoices, for stores saved before them.
const migrate3base = (input: Record<string, unknown>): Record<string, unknown> => fields3(withInvoiceMatch(input))

const fields3 = (v: Record<string, unknown>): Record<string, unknown> => ({
  ...v,
  ...devopsNames(v),
  workspace: webEpicLink(v.workspace),
  questions: linkChatAnswers(v.questions),
  version: DB_VERSION,
  leave: Array.isArray(v.leave) ? v.leave : [],
  notifications: Array.isArray(v.notifications) ? v.notifications : [],
  clientTeam: Array.isArray(v.clientTeam) ? v.clientTeam : [],
  internalProjects: Array.isArray(v.internalProjects) && v.internalProjects.length ? v.internalProjects : clone(INTERNAL_PROJECTS_SEED),
  weekSubmissions: Array.isArray(v.weekSubmissions) ? v.weekSubmissions : [],
  companies: withDriverAppSupport(v.companies),
})

/**
 * The Daco "Web app" epic was linked to ARC's DevOps item (OPS-106). DevOps is
 * project specific, so it links to Daco's own item, OPS-101. Only a link still
 * on the old value moves.
 */
const webEpicLink = (ws: unknown): unknown =>
  isObj(ws) && isObj(ws.devopsLinks) && ws.devopsLinks.web === 'OPS-106'
    ? { ...ws, devopsLinks: { ...ws.devopsLinks, web: 'OPS-101' } }
    : ws

/** DevOps sample projects saved under their pre-v4 names get the client / project split. */
const devopsNames = (v: Record<string, unknown>) =>
  isObj(v.devops) && Array.isArray(v.devops.projects) && Array.isArray(v.requests)
    ? upgradeDevopsNames(v.devops as unknown as Db['devops'], v.requests as Db['requests'])
    : {}

/** v5: DevOps items saved before they were projects get their project link (see linkDevopsProjects). */
const devopsProjects = (v: Record<string, unknown>): Record<string, unknown> =>
  isObj(v.devops) && Array.isArray(v.devops.projects) && Array.isArray(v.companies) && Array.isArray(v.internalProjects)
    ? { ...v, ...linkDevopsProjects(v.devops as unknown as Db['devops'], v.companies as Db['companies'], v.internalProjects as Db['internalProjects']) }
    : v

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

/** Today in the browser's time zone, as YYYY-MM-DD: the backend stores real dates. */
const localToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * API mode: sends the command to the backend. A 403 becomes the RefusedError
 * the pages already show. A new ticket's backend id is also its `id`, so the
 * ticket window moves from the temporary id to the real one.
 */
const sendToApi = async (send: (today: string) => Promise<{ id?: string }>, ticket = false): Promise<SendResult> => {
  try {
    const { id } = await send(localToday())
    return id ? { apiId: id, ...(ticket ? { id } : {}) } : {}
  } catch (err) {
    // A refusal, or a value the backend does not accept: the page shows the backend's reason.
    if (err instanceof ApiError && err.status === 403) throw new RefusedError(err.message)
    if (err instanceof ApiError && err.status === 422) throw new RefusedError(err.fieldMessage ?? err.message)
    // A submitted week: the person can reopen it.
    if (err instanceof ApiError && err.code === 'TIMESHEET_WEEK_SUBMITTED') throw new RefusedError(err.message)
    throw err
  }
}

export const server = {
  async get<K extends Exclude<keyof Db, 'version'>>(resource: K): Promise<Db[K]> {
    // API mode: these resources come from the backend; everything else is still the mock.
    if (apiMode && resource === 'companies') return (await fetchCompanies(readSession())) as Db[K]
    if (apiMode && resource === 'internalProjects') return (await fetchInternalProjects(readSession())) as Db[K]
    if (apiMode && resource === 'workspace') return (await fetchWorkspace(readSession())) as Db[K]
    if (apiMode && resource === 'tasks') return (await fetchTasks(readSession())) as Db[K]
    if (apiMode && resource === 'entries') return (await fetchEntries(readSession())) as Db[K]
    if (apiMode && resource === 'people') return (await fetchPeopleApi(readSession())) as Db[K]
    if (apiMode && resource === 'access') return (await fetchAccessApi()) as Db[K]
    if (apiMode && resource === 'weekSubmissions') return (await fetchWeekSubmissions(readSession())) as Db[K]
    await sleep(LATENCY_MS)
    return exclusive(async () => clone((await current())[resource]))
  },

  /** Applies a command and resolves with what it did (the id of a new task, for example). */
  async send(cmd: Command): Promise<SendResult> {
    if (apiMode && isCompanyApiCommand(cmd)) return sendToApi(today => sendCompanyCommand(cmd, today))
    if (apiMode && isBoardApiCommand(cmd))
      return sendToApi(today => sendBoardCommand(cmd, today), cmd.type === 'task.create' || cmd.type === 'tickets.task.createTop')
    if (apiMode && isTimeApiCommand(cmd)) return sendToApi(() => sendTimeCommand(cmd, readSession()))
    if (apiMode && isUserApiCommand(cmd)) return sendToApi(() => sendUserCommand(cmd))
    await sleep(LATENCY_MS)
    return exclusive(() =>
      acrossTabs(async () => {
        await storeCommandFiles(cmd)
        for (;;) {
          const base = await current()
          // The mock backend's authorization: the actor is the signed-in session, never what the command claims.
          const why = refusal(base, cmd, readSession())
          if (why) throw new RefusedError(why)
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
