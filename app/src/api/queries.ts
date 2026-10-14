import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { reduce, touches, type Command, type Resource } from './commands'
import { RefusedError, server } from './server'
import { apiMode } from './http/config'
import { isCompanyApiCommand } from './http/companies'
import { isBoardApiCommand } from './http/board'
import { isTimeApiCommand } from './http/timesheet'
import { isUserApiCommand } from './http/users'
import { isLeaveApiCommand } from './http/leave'
import { startLiveUpdates } from './http/live'
import { api } from './http/client'
import { readTokens } from './http/tokens'
import { fetchTicketDetails, isBackendId } from './http/ticketDetails'
import { ApiError } from './http/client'
import { refusal } from './session/permissions'
import { readSession } from './session/store'
import type { Db } from './types'
import { DEFAULT_DEV_TYPES, DEFAULT_PERMS } from './users/access'

export const qk = {
  workspace: ['workspace'] as const,
  tasks: ['tasks'] as const,
  entries: ['entries'] as const,
  weekSubmissions: ['weekSubmissions'] as const,
  questions: ['questions'] as const,
  requests: ['requests'] as const,
  devops: ['devops'] as const,
  people: ['people'] as const,
  companies: ['companies'] as const,
  internalProjects: ['internalProjects'] as const,
  access: ['access'] as const,
  leave: ['leave'] as const,
  notifications: ['notifications'] as const,
  clientTeam: ['clientTeam'] as const,
  invoiceMatch: ['invoiceMatch'] as const,
}

const RESOURCES: Resource[] = ['workspace', 'tasks', 'entries', 'weekSubmissions', 'questions', 'requests', 'devops', 'people', 'companies', 'internalProjects', 'access', 'leave', 'notifications', 'clientTeam', 'invoiceMatch']

export const useWorkspace = () => useQuery({ queryKey: qk.workspace, queryFn: () => server.get('workspace') })
export const useTasks = () => useQuery({ queryKey: qk.tasks, queryFn: () => server.get('tasks') })

/** API mode: the open ticket's comments, history and attachments (the mock keeps them on the ticket). */
export const ticketDetailsQuery = (id: string) => ({
  queryKey: ['ticketDetails', id],
  queryFn: () => fetchTicketDetails(id),
  // A draft or a ticket still being created keeps its own fields until it has a backend id.
  enabled: apiMode && isBackendId(id),
  // A refusal will not change on retry; a server or network failure may.
  retry: (n: number, err: unknown) => n < 3 && !(err instanceof ApiError && err.status < 500),
})
export const useTicketDetails = (id: string) => useQuery(ticketDetailsQuery(id))
export const useEntries = () => useQuery({ queryKey: qk.entries, queryFn: () => server.get('entries') })
export const useQuestions = () => useQuery({ queryKey: qk.questions, queryFn: () => server.get('questions') })
export const useRequests = () => useQuery({ queryKey: qk.requests, queryFn: () => server.get('requests') })
export const useDevops = () => useQuery({ queryKey: qk.devops, queryFn: () => server.get('devops') })
export const useCompanies = () => useQuery({ queryKey: qk.companies, queryFn: () => server.get('companies') })
export const useInternalProjects = () => useQuery({ queryKey: qk.internalProjects, queryFn: () => server.get('internalProjects') })
export const useClientTeam = () => useQuery({ queryKey: qk.clientTeam, queryFn: () => server.get('clientTeam') })

/**
 * Builds a Db from the cache so the shared reducer can run on it. Only the
 * resources the command touches must be cached; a page that never loaded,
 * say, the DevOps data can still update its own data instantly.
 */
const cachedDb = (qc: QueryClient, needed: Resource[]): Db | null => {
  const db: Partial<Db> = { version: 0 }
  for (const r of RESOURCES) {
    const v = qc.getQueryData([r])
    if (v === undefined && needed.includes(r)) return null
    ;(db as Record<string, unknown>)[r] = v
  }
  return db as Db
}

/**
 * Sends a command to the server. The cache is updated straight away with the
 * same reducer the server uses, then refetched once the server confirms.
 */
/**
 * API mode: refuses a command the signed-in role may not run before it reaches
 * the backend, with the same reason the mock gives (session/permissions.ts).
 * The backend enforces the rules too; this keeps the message and timing the same as mock mode.
 */
export const refuseBeforeSending = (qc: QueryClient, cmd: Command) => {
  // Company, project and board commands are judged by the backend: the mock's rules differ there.
  if (!apiMode || isCompanyApiCommand(cmd) || isBoardApiCommand(cmd) || isTimeApiCommand(cmd) || isUserApiCommand(cmd) || isLeaveApiCommand(cmd)) return
  const db = cachedDb(qc, touches(cmd))
  const why = db && refusal(db, cmd, readSession())
  if (why) throw new RefusedError(why)
}

const useCommandMutation = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (cmd: Command) => {
      refuseBeforeSending(qc, cmd)
      return server.send(cmd)
    },
    onMutate: async cmd => {
      const keys = touches(cmd)
      await Promise.all(keys.map(k => qc.cancelQueries({ queryKey: [k] })))
      const prev = Object.fromEntries(keys.map(k => [k, qc.getQueryData([k])]))
      const db = cachedDb(qc, keys)
      // A command the role may not run is not shown even for a moment; the server refuses it.
      if (db && !refusal(db, cmd, readSession())) {
        const next = reduce(db, cmd)
        keys.forEach(k => qc.setQueryData([k], next[k]))
      }
      return { prev }
    },
    onError: (_err, _cmd, ctx) => {
      if (ctx) Object.entries(ctx.prev).forEach(([k, v]) => qc.setQueryData([k], v))
    },
    onSettled: () => {
      // Refetching while later writes are still in flight would briefly undo
      // them, so only the last write to finish refetches (everything it and
      // the earlier skipped writes touched).
      if (qc.isMutating() > 1) return
      return Promise.all([...RESOURCES, 'ticketDetails', 'leaveBook'].map(k => qc.invalidateQueries({ queryKey: [k] })))
    },
  })
}

/** Fire and forget: the write is applied optimistically and errors roll back. */
export const useSend = () => useCommandMutation().mutate

/**
 * Like useSend, but resolves once the server has applied the command and the
 * cache has been refetched, with what the server did (e.g. the id it gave a
 * new task). Rejects if the write fails.
 */
export const useSendAsync = () => useCommandMutation().mutateAsync

/**
 * Refetches everything when another tab changes the data, and in API mode
 * refetches what other people changed (the backend's live change stream).
 */
export const useLiveSync = () => {
  const qc = useQueryClient()
  useEffect(() => server.subscribe(() => qc.invalidateQueries()), [qc])
  useEffect(() => {
    if (!apiMode) return
    return startLiveUpdates(keys => keys.forEach(k => qc.invalidateQueries({ queryKey: [k] })), {
      fetchFn: (url, init) => fetch(url, init),
      token: () => readTokens()?.access ?? null,
      // A call through the API client renews an expired access token.
      refreshToken: () => api.get('/auth/me'),
      wait: ms => new Promise(r => setTimeout(r, ms)),
      batchMs: 300,
    })
  }, [qc])
}

export const useWeekSubmissions = () =>
  useQuery({ queryKey: qk.weekSubmissions, queryFn: () => server.get('weekSubmissions') })
// ---- WP-07: users, access, leave. A db saved before WP-07 has none of these, so the reads fall back to the seed defaults.

export const useAccess = () =>
  useQuery({
    queryKey: qk.access,
    queryFn: async () => (await server.get('access')) ?? { perms: DEFAULT_PERMS, devTypes: DEFAULT_DEV_TYPES },
  })
export const useLeave = () => useQuery({ queryKey: qk.leave, queryFn: async () => (await server.get('leave')) ?? [] })
export const useNotifications = () =>
  useQuery({ queryKey: qk.notifications, queryFn: async () => (await server.get('notifications')) ?? [] })
