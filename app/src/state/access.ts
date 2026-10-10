import { createContext, useCallback, useContext, useMemo } from 'react'
import { useQuestions, useRequests, useSend, useSendAsync, useTasks, useWorkspace } from '../api/queries'
import type { Command } from '../api/commands'
import { isClientRole } from '../api/session/access'
import { useSession } from '../api/session/store'
import { scopeQuestions, scopeRequests, scopeTasks, scopeWorkspace, type ClientScope } from '../domain/scope'

/**
 * The client scope of the Clients page, or null for team roles. Provided by
 * ClientsLayout; the Tickets page does not provide it, so its windows see everything.
 */
export const ScopeContext = createContext<ClientScope | null>(null)

export const useScope = () => useContext(ScopeContext)

/** Whether the signed-in user is a client (cadmin or cuser). */
export const useIsClient = () => {
  const s = useSession()
  return !!s && isClientRole(s.role)
}

/** The signed-in person's name. Their messages and changes are written under it. */
export const useActorName = () => useSession()?.name ?? 'You'

/** Writes `who` into the commands that record a person (task history and comments). */
export const withActor = (cmd: Command, who: string): Command => {
  switch (cmd.type) {
    case 'task.update':
      return cmd.log && !cmd.who ? { ...cmd, who } : cmd
    case 'task.comment':
      return cmd.who ? cmd : { ...cmd, who }
    case 'batch':
      return { ...cmd, cmds: cmd.cmds.map(c => withActor(c, who)) }
    default:
      return cmd
  }
}

/** Like useSend, but records the signed-in person as the author. */
export const useActorSend = () => {
  const send = useSend()
  const who = useActorName()
  return useCallback((cmd: Command) => send(withActor(cmd, who)), [send, who])
}

/** Like useSendAsync, but records the signed-in person as the author. */
export const useActorSendAsync = () => {
  const send = useSendAsync()
  const who = useActorName()
  return useCallback((cmd: Command) => send(withActor(cmd, who)), [send, who])
}

/** Tasks the viewer may see. Undefined until loaded. */
export const useScopedTasks = () => {
  const scope = useScope()
  const tasks = useTasks().data
  return useMemo(() => (tasks && scope ? scopeTasks(tasks, scope) : tasks), [tasks, scope])
}

/** Questions the viewer may see. */
export const useScopedQuestions = () => {
  const scope = useScope()
  const questions = useQuestions().data
  const tasks = useTasks().data
  return useMemo(() => (questions && scope ? scopeQuestions(questions, tasks ?? [], scope) : questions), [questions, tasks, scope])
}

/** DevOps requests the viewer may see. */
export const useScopedRequests = () => {
  const scope = useScope()
  const requests = useRequests().data
  return useMemo(() => (requests && scope ? scopeRequests(requests, scope) : requests), [requests, scope])
}

/** The workspace with only the viewer's epics and sprints. Undefined until loaded. */
export const useScopedWorkspace = () => {
  const scope = useScope()
  const ws = useWorkspace().data
  return useMemo(() => (ws && scope ? scopeWorkspace(ws, scope) : ws), [ws, scope])
}
