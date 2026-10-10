import type { Company, DevopsRequest, Question, Task, Workspace } from '../api/types'

/**
 * What a client role may see: its own company's epics (and so tasks, sprints
 * and bugs), the DevOps projects linked to them, and the questions and requests
 * that belong to them. Team roles have no scope (null) and see everything.
 * Enforced in the UI only; a backend has to repeat it.
 */
export interface ClientScope {
  companyId: string | null
  epicIds: string[]
  devopsKeys: string[]
}

/** The scope of a client user: the epics of the projects their company has. */
export const buildScope = (orgId: string | undefined, companies: Company[], ws: Workspace | undefined): ClientScope => {
  const company = companies.find(c => c.id === orgId)
  const owned = new Set((company?.projects ?? []).flatMap(p => p.epics.map(e => e.id)))
  const epicIds = (ws?.epics ?? []).map(e => e.id).filter(id => owned.has(id))
  const devopsKeys = [...new Set(epicIds.map(id => ws?.devopsLinks[id]).filter((k): k is string => !!k))]
  return { companyId: company?.id ?? null, epicIds, devopsKeys }
}

export const scopeTasks = (tasks: Task[], scope: ClientScope): Task[] => tasks.filter(t => scope.epicIds.includes(t.epic))

/**
 * A question belongs to a client when it is linked to one of their tickets or
 * DevOps projects. Questions with neither link have no company, so clients do
 * not see them.
 */
export const scopeQuestions = (questions: Question[], tasks: Task[], scope: ClientScope): Question[] => {
  const epicOf = new Map(tasks.map(t => [t.id, t.epic]))
  return questions.filter(
    q =>
      (q.task != null && scope.epicIds.includes(epicOf.get(q.task) ?? '')) || (!!q.project && scope.devopsKeys.includes(q.project)),
  )
}

export const scopeRequests = (requests: DevopsRequest[], scope: ClientScope): DevopsRequest[] =>
  requests.filter(r => scope.devopsKeys.includes(r.key))

export const scopeWorkspace = (ws: Workspace, scope: ClientScope): Workspace => ({
  ...ws,
  epics: ws.epics.filter(e => scope.epicIds.includes(e.id)),
  sprints: ws.sprints.filter(s => scope.epicIds.includes(s.epic)),
})
