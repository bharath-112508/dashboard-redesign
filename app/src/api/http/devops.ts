import { api } from './client'
import { boardIndex, fetchWorkspace } from './board'
import { ago } from './ticketDetails'
import { fetchPeopleApi } from './users'
import { createDevopsSeed } from '../devops/seed'
import type { DevopsDb, DvProject, DvSettings } from '../devops/types'
import type { ChatFile, ChatMessage, DevopsRequest, Priority, Question, Session, Workspace } from '../types'

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

/** Shows every stored `when` as "5m ago" and keeps the stored value in `at`, to send back unchanged. */
export const datesOut = <T>(v: T, now = new Date()): T =>
  walk(v, o => {
    const m = STORED.exec(o.when as string)
    return m ? { ...o, when: m[1] + ago(m[2], now), at: o.when } : o
  }) as T

/** The reverse: "just now" (after a word or not) becomes the time; a `when` shown from `at` goes back as stored. */
export const datesIn = <T>(v: T, now = new Date()): T =>
  walk(v, ({ at, ...o }) => {
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
    photos: q.photos ?? [],
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
