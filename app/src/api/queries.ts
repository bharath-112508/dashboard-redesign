import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { reduce, touches, type Command, type Resource } from './commands'
import { server } from './server'
import type { Db } from './types'

export const qk = {
  workspace: ['workspace'] as const,
  tasks: ['tasks'] as const,
  entries: ['entries'] as const,
  questions: ['questions'] as const,
  requests: ['requests'] as const,
  devops: ['devops'] as const,
}

const RESOURCES: Resource[] = ['workspace', 'tasks', 'entries', 'questions', 'requests', 'devops']

export const useWorkspace = () => useQuery({ queryKey: qk.workspace, queryFn: () => server.get('workspace') })
export const useTasks = () => useQuery({ queryKey: qk.tasks, queryFn: () => server.get('tasks') })
export const useEntries = () => useQuery({ queryKey: qk.entries, queryFn: () => server.get('entries') })
export const useQuestions = () => useQuery({ queryKey: qk.questions, queryFn: () => server.get('questions') })
export const useRequests = () => useQuery({ queryKey: qk.requests, queryFn: () => server.get('requests') })
export const useDevops = () => useQuery({ queryKey: qk.devops, queryFn: () => server.get('devops') })

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
const useCommandMutation = () => {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (cmd: Command) => server.send(cmd),
    onMutate: async cmd => {
      const keys = touches(cmd)
      await Promise.all(keys.map(k => qc.cancelQueries({ queryKey: [k] })))
      const prev = Object.fromEntries(keys.map(k => [k, qc.getQueryData([k])]))
      const db = cachedDb(qc, keys)
      if (db) {
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
      return Promise.all(RESOURCES.map(k => qc.invalidateQueries({ queryKey: [k] })))
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

/** Refetches everything when another tab changes the data. */
export const useLiveSync = () => {
  const qc = useQueryClient()
  useEffect(() => server.subscribe(() => qc.invalidateQueries()), [qc])
}
