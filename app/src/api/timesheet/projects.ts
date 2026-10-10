import { taskKey } from '../../domain/tasks'
import type { Company, InternalProject, Task, TimeEntry } from '../types'

/**
 * Projects on time entries. A value is `c:<client project id>` or `i:<internal project id>`.
 * Client projects live inside their company; the company's epics link a project to tickets.
 */

export interface ProjectOption {
  value: string
  /** "Daco · Daco platform", or "Internal · Name". */
  label: string
  /** Epic ids of the project. A ticket belongs to the project when its epic is one of these. */
  epics: string[]
  companyId: string | null
}

export const clientValue = (id: string) => 'c:' + id
export const internalValue = (id: string) => 'i:' + id

/** Projects a person can book time to. `companyId` narrows the list to one company (the Companies link). */
export const projectOptions = (
  companies: Company[],
  internal: InternalProject[],
  companyId: string | null = null,
): ProjectOption[] => {
  const client = companies
    .filter(c => !c.archived && (!companyId || c.id === companyId))
    .flatMap(c =>
      c.projects
        .filter(p => p.state !== 'done')
        .map(p => ({
          value: clientValue(p.id),
          label: `${c.name} · ${p.name}`,
          epics: p.epics.map(e => e.id),
          companyId: c.id,
        })),
    )
  const internalOpts = companyId
    ? []
    : internal
        .filter(p => p.state !== 'done')
        .map(p => ({ value: internalValue(p.id), label: `Internal · ${p.name}`, epics: [], companyId: null }))
  return [...client, ...internalOpts]
}

/** Label and epics of any project, including done and archived ones. Null when unknown. */
export const findProject = (value: string, companies: Company[], internal: InternalProject[]): ProjectOption | null => {
  if (value.startsWith('c:')) {
    const id = value.slice(2)
    for (const c of companies) {
      const p = c.projects.find(x => x.id === id)
      if (p) return { value, label: `${c.name} · ${p.name}`, epics: p.epics.map(e => e.id), companyId: c.id }
    }
    return null
  }
  if (value.startsWith('i:')) {
    const p = internal.find(x => x.id === value.slice(2))
    return p ? { value, label: `Internal · ${p.name}`, epics: [], companyId: null } : null
  }
  return null
}

/** The client project whose epics include this epic, as a project value. */
export const projectOfEpic = (epic: string | undefined, companies: Company[]): string | undefined => {
  if (!epic) return undefined
  for (const c of companies)
    for (const p of c.projects) if (p.epics.some(e => e.id === epic)) return clientValue(p.id)
  return undefined
}

/** The project a ticket's time belongs to, from its epic. */
export const projectOfTask = (taskId: number, tasks: Task[], companies: Company[]): string | undefined =>
  projectOfEpic(tasks.find(t => t.id === taskId)?.epic, companies)

/** The project of an entry: the stored one, or the one its ticket implies (for entries written before `project` existed). */
export const entryProject = (e: TimeEntry, tasks: Task[], companies: Company[]): string | undefined =>
  e.project ?? (e.task !== null ? projectOfTask(e.task, tasks, companies) : undefined)

/** Tickets a person can log time to in a project: top-level tickets whose epic belongs to the project. */
export const ticketOptions = (projectValue: string, tasks: Task[], companies: Company[], internal: InternalProject[]): Task[] => {
  const p = findProject(projectValue, companies, internal)
  if (!p || !p.epics.length) return []
  return tasks.filter(t => !t.parent && p.epics.includes(t.epic))
}

/** "PMT-10 · Login with BankID", or the text for a text entry. */
export const taskLabel = (e: TimeEntry, tasks: Task[]): string => {
  if (e.task === null) return e.area || 'Other'
  const t = tasks.find(x => x.id === e.task)
  return t ? `${taskKey(t)} · ${t.title}` : '(ticket removed)'
}

/** Ticket key for an entry, or '' for a text entry. */
export const ticketKeyOf = (e: TimeEntry, tasks: Task[]): string => {
  if (e.task === null) return ''
  const t = tasks.find(x => x.id === e.task)
  return t ? taskKey(t) : ''
}

export const TEXT_TASKS = ['Admin & meetings', 'Code review', 'Client call', 'Weekly planning', 'Sprint planning view', 'Follow-up reminders'] as const
