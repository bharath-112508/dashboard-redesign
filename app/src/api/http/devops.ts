import { api } from './client'
import { boardIndex, fetchWorkspace } from './board'
import { ago } from './ticketDetails'
import { fetchPeopleApi } from './users'
import { createDevopsSeed } from '../devops/seed'
import { reduceDevops, type DevopsCommand } from '../devops/commands'
import type { Command } from '../commands'
import type { DevopsDb, DvProject, DvSettings } from '../devops/types'
import type { ChatFile, ChatMessage, Db, DevopsRequest, Priority, Question, Session, Workspace } from '../types'

/**
 * The DevOps board, questions to clients and DevOps requests from the backend
 * (`/devops`, `/questions`, `/devops-requests`), in the shapes the pages use.
 */

type BackendItem = { key: string; project_id: string; data: Record<string, unknown>; updated_at: string }
type BackendQuestion = {
  number: number
  title: string
  text: string
  by: string
  created_at: string
  task_id: string | null
  devops_key: string | null
  sprint: string | null
  photos: ChatFile[]
  qtype: string
  qprio: string
  from_devops: boolean
  solved: boolean
  seen_t: number
  messages: { who: string; side: 'client' | 'team'; text: string; files: ChatFile[]; when: string }[]
}
type BackendRequest = {
  number: number
  devops_key: string
  pname: string
  rkey: string
  type: string
  prio: string
  to: string
  text: string
  desc: string
  due: string
  start: string
  est: string
  by: string
  raised: string
  status: DevopsRequest['status']
  comments: { by: string; text: string; when: string; side: 'tickets' | 'devops' }[]
  history: { by: string; text: string; when: string }[]
  logs: Record<string, unknown>[]
  seen_t: number
  status_seen: string
  created_at: string
}

// ─── Times ──────────────────────────────────────────────────────────────

/** A stored time, optionally after a word ("Edited 2026-10-14T12:00:00.000Z"). Release times without seconds are dates the page formats. */
const STORED = /^(.*?)(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)$/

const walk = (v: unknown, at: (o: Record<string, unknown>) => Record<string, unknown>): unknown => {
  if (Array.isArray(v)) return v.map(x => walk(x, at))
  if (!v || typeof v !== 'object') return v
  const o: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) o[k] = walk(x, at)
  return typeof o.when === 'string' ? at(o) : o
}

/** Shows every stored `when` as "5m ago", keeping the stored value (`at`) and what was shown (`shown`) to send back unchanged. */
export const datesOut = <T>(v: T, now = new Date()): T =>
  walk(v, o => {
    const m = STORED.exec(o.when as string)
    if (!m) return o
    const when = m[1] + ago(m[2], now)
    return { ...o, when, at: o.when, shown: when }
  }) as T

/**
 * The reverse: a `when` still as it was shown goes back as stored (even a stored
 * time shown as "just now"); a new or changed "just now" becomes the time.
 */
export const datesIn = <T>(v: T, now = new Date()): T =>
  walk(v, ({ at, shown, ...o }) => {
    if (typeof at === 'string' && o.when === shown) return { ...o, when: at }
    const m = /^(.*?)just now$/i.exec(o.when as string)
    if (m) return { ...o, when: m[1] + now.toISOString() }
    return typeof at === 'string' ? { ...o, when: at } : o
  }) as T

// ─── DevOps board ───────────────────────────────────────────────────────

const itemFrom = (i: BackendItem, now: Date): DvProject => ({ ...datesOut(i.data, now), key: i.key }) as unknown as DvProject

/** The design's settings, with the DevOps people of the directory, until someone saves Settings. */
const defaultSettings = async (session: Session): Promise<DvSettings> => {
  const people = await fetchPeopleApi(session).catch(() => [])
  return { ...createDevopsSeed().settings, people: people.filter(p => p.active && p.role === 'devops').map(p => p.name) }
}

export const fetchDevops = async (session: Session | null, now = new Date()): Promise<DevopsDb> => {
  if (!session) return { projects: [], settings: createDevopsSeed().settings }
  const [items, saved] = await Promise.all([api.get<BackendItem[]>('/devops/items'), api.get<DvSettings | null>('/devops/settings')])
  return { projects: items.map(i => itemFrom(i, now)), settings: saved ?? (await defaultSettings(session)) }
}

/** Epic id → the key of the DevOps item on the epic's project. */
export const linkEpics = (epicIds: string[], projectOfEpic: Map<string, string>, items: Pick<DvProject, 'key' | 'project'>[]) =>
  Object.fromEntries(
    epicIds.flatMap(e => {
      const item = items.find(i => i.project?.id === projectOfEpic.get(e))
      return item ? [[e, item.key]] : []
    }),
  )

/** The board's workspace with each epic linked to its project's DevOps item (a failed read leaves the links out). */
export const fetchLinkedWorkspace = async (session: Session | null): Promise<Workspace> => {
  const [ws, items] = await Promise.all([fetchWorkspace(session), session ? api.get<BackendItem[]>('/devops/items').catch(() => []) : []])
  const refs = items.map(i => ({ key: i.key, project: i.data.project as DvProject['project'] }))
  return { ...ws, devopsLinks: linkEpics(ws.epics.map(e => e.id), boardIndex.projectOfEpic, refs) }
}

// ─── Questions ──────────────────────────────────────────────────────────

const questionFrom = (q: BackendQuestion, now: Date): Question => {
  const comments: ChatMessage[] = q.messages.map(m => ({ who: m.who, side: m.side, text: m.text, when: ago(m.when, now), files: m.files ?? [] }))
  // The client's first message is their answer, as the mock records it.
  const i = comments.findIndex(m => m.side === 'client')
  const answer = i < 0 ? {} : { answeredWhen: comments[i].when, answerBy: comments[i].who, answerIdx: i }
  return {
    id: q.number,
    by: q.by,
    title: q.title,
    text: q.text,
    when: ago(q.created_at, now),
    task: q.task_id,
    answer: i < 0 ? '' : comments[i].text || 'Sent files',
    ...answer,
    comments,
    // Marked, so adding a photo sends only the new ones.
    photos: (q.photos ?? []).map(p => ({ ...p, saved: true })),
    solved: q.solved,
    qtype: q.qtype,
    qprio: q.qprio,
    fromDevops: q.from_devops,
    ...(q.devops_key ? { project: q.devops_key } : {}),
    sprint: q.sprint,
    seenT: q.seen_t,
  }
}

export const fetchQuestions = async (session: Session | null, now = new Date()): Promise<Question[]> =>
  session ? (await api.get<BackendQuestion[]>('/questions')).map(q => questionFrom(q, now)) : []

// ─── DevOps requests ────────────────────────────────────────────────────

const requestFrom = (r: BackendRequest, now: Date): DevopsRequest => ({
  id: r.number,
  key: r.devops_key,
  pname: r.pname,
  rkey: r.rkey,
  type: r.type,
  prio: r.prio as Priority,
  to: r.to,
  text: r.text,
  by: r.by,
  when: ago(r.created_at, now),
  raised: r.raised,
  status: r.status,
  comments: r.comments.map(c => ({ ...c, when: ago(c.when, now) })),
  history: r.history.map(h => ({ ...h, when: ago(h.when, now) })),
  desc: r.desc,
  due: r.due,
  start: r.start,
  est: r.est,
  logs: datesOut(r.logs, now) as DevopsRequest['logs'],
  seenT: r.seen_t,
  statusSeen: r.status_seen,
})

export const fetchRequests = async (session: Session | null, now = new Date()): Promise<DevopsRequest[]> =>
  session ? (await api.get<BackendRequest[]>('/devops-requests')).map(r => requestFrom(r, now)) : []

// ─── Writes ─────────────────────────────────────────────────────────────

type DevopsApiCommand = Extract<
  Command,
  {
    type:
      | DevopsCommand['type']
      | 'question.create'
      | 'question.update'
      | 'question.message'
      | 'question.editMessage'
      | 'tickets.question.seen'
      | 'request.create'
      | 'request.update'
      | 'request.comment'
      | 'batch'
  }
>

const SINGLE = new Set([
  'devops.project.create',
  'devops.project.update',
  'devops.option.add',
  'devops.settings.save',
  'question.create',
  'question.update',
  'question.message',
  'question.editMessage',
  'tickets.question.seen',
  'request.create',
  'request.update',
  'request.comment',
])

export const isDevopsApiCommand = (cmd: { type: string; cmds?: { type: string }[] }): cmd is DevopsApiCommand =>
  cmd.type === 'batch' ? !!cmd.cmds?.length && cmd.cmds.every(isDevopsApiCommand) : SINGLE.has(cmd.type)

/** Keeps the fields the backend takes, renamed (app name → backend name). */
const pick = (patch: object, names: Record<string, string>) =>
  Object.fromEntries(Object.entries(patch).flatMap(([k, v]) => (k in names && v !== undefined ? [[names[k], v]] : [])))

const QUESTION_FIELDS = { title: 'title', text: 'text', qtype: 'qtype', qprio: 'qprio', sprint: 'sprint', solved: 'solved', seenT: 'seen_t' }
const REQUEST_FIELDS = {
  type: 'type',
  prio: 'prio',
  to: 'to',
  text: 'text',
  desc: 'desc',
  due: 'due',
  start: 'start',
  est: 'est',
  status: 'status',
  logs: 'logs',
  seenT: 'seen_t',
  statusSeen: 'status_seen',
}

/**
 * Settings changes reuse the board's own reducer (the one place that knows how
 * a rename moves items): the result's settings are saved, then each item it changed.
 * ponytail: not atomic; an item write that fails after the settings save leaves that item on the old name until it is edited.
 */
const saveSettingsChange = async (cmd: DevopsCommand, session: Session | null, now: Date) => {
  const before = await fetchDevops(session, now)
  const after = reduceDevops({ devops: before } as Db, cmd).devops
  await api.put('/devops/settings', { settings: after.settings })
  for (const p of after.projects) {
    const old = before.projects.find(x => x.key === p.key)
    if (!old) continue
    const changed = Object.fromEntries(
      Object.entries(p).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify((old as unknown as Record<string, unknown>)[k])),
    )
    if (Object.keys(changed).length) await api.patch(`/devops/items/${p.key}`, { patch: datesIn(changed, now) })
  }
}

export const sendDevopsCommand = async (cmd: DevopsApiCommand, session: Session | null, now = new Date()): Promise<{ id?: string }> => {
  switch (cmd.type) {
    case 'batch':
      for (const c of cmd.cmds) await sendDevopsCommand(c as DevopsApiCommand, session, now)
      return {}
    case 'devops.project.create': {
      const { key, ...data } = cmd.project
      await api.post('/devops/items', { key, project_id: cmd.project.project?.id, data: datesIn(data, now) })
      return {}
    }
    case 'devops.project.update':
      await api.patch(`/devops/items/${cmd.key}`, { patch: datesIn(cmd.patch, now), ...(cmd.log ? { log: cmd.log } : {}) })
      return {}
    case 'devops.option.add':
    case 'devops.settings.save':
      await saveSettingsChange(cmd, session, now)
      return {}
    case 'question.create': {
      const q = cmd.question
      await api.post('/questions', {
        number: q.id,
        title: q.title,
        text: q.text,
        photos: q.photos ?? [],
        qtype: q.qtype ?? '',
        qprio: q.qprio ?? '',
        sprint: q.sprint ?? null,
        task_id: q.task,
        devops_key: q.project ?? null,
        from_devops: !!q.fromDevops,
      })
      return {}
    }
    case 'question.update': {
      const { photos, ...rest } = cmd.patch
      const added = (photos ?? []).filter(p => !(p as { saved?: boolean }).saved)
      if (added.length) await api.post(`/questions/${cmd.id}/photos`, { files: added })
      const body = pick(rest, QUESTION_FIELDS)
      if (Object.keys(body).length) await api.patch(`/questions/${cmd.id}`, body)
      return {}
    }
    case 'tickets.question.seen':
      await api.patch(`/questions/${cmd.id}`, { seen_t: cmd.seen })
      return {}
    case 'question.message':
      await api.post(`/questions/${cmd.id}/messages`, { text: cmd.message.text, files: cmd.message.files ?? [] })
      return {}
    case 'question.editMessage':
      // -1 is an answer stored apart from the chat, which only older browser stores have.
      if (cmd.index >= 0) await api.patch(`/questions/${cmd.id}/messages/${cmd.index}`, { text: cmd.text })
      return {}
    case 'request.create': {
      const r = cmd.request
      await api.post('/devops-requests', {
        number: r.id,
        devops_key: r.key,
        ...pick({ pname: r.pname, rkey: r.rkey, type: r.type, prio: r.prio, to: r.to, text: r.text, raised: r.raised, desc: r.desc, due: r.due, start: r.start, est: r.est }, {
          pname: 'pname',
          rkey: 'rkey',
          raised: 'raised',
          ...REQUEST_FIELDS,
        }),
      })
      return {}
    }
    case 'request.update': {
      // Hours: a new entry (`addLog`) is added to what the server has, so two people
      // logging at once both land. A list without one is a removal (the app removes one
      // entry at a time); the server refuses it if the list has changed since.
      const { logs, ...rest } = cmd.patch
      const added = cmd.addLog ? [cmd.addLog] : []
      const patch = datesIn(pick(added.length || !logs ? rest : cmd.patch, REQUEST_FIELDS), now)
      await api.patch(`/devops-requests/${cmd.id}`, {
        patch,
        ...(cmd.log ? { log: { text: cmd.log.text } } : {}),
        ...(added.length ? { add_logs: datesIn(added, now) } : logs ? { logs_if_count: logs.length + 1 } : {}),
      })
      return {}
    }
    case 'request.comment':
      await api.post(`/devops-requests/${cmd.id}/comments`, { text: cmd.comment.text, side: cmd.comment.side })
      return {}
  }
}
