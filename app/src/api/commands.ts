import { nextTaskId } from '../domain/tasks'
import type { ChatMessage, Db, DevopsRequest, Epic, NotifPrefs, Person, Question, RequestComment, Sprint, Task } from './types'
import { reduceTickets, touchesTickets, type TicketsCommand } from './tickets/commands'
import { reduceDevops, touchesDevops, type DevopsCommand } from './devops/commands'
import { reduceCompanies, touchesCompanies, type CompaniesCommand } from './companies/commands'
import { reduceProjects, touchesProjects, type ProjectsCommand } from './projects/commands'
import { assignTimeIds, reduceTime, touchesTime, type TimeCommand } from './timesheet/commands'
import { reduceUsers, touchesUsers, type UsersCommand } from './users/commands'
import { reduceClients, touchesClients, type ClientsCommand } from './clients/commands'
import { reduceInvoiceMatch, touchesInvoiceMatch, type InvoiceMatchCommand } from '../features/invoice-match/commands'

/**
 * Every write the page makes is one of these commands. The same reducer runs
 * on the React Query cache (optimistic update) and in the mock server, so the
 * UI and the "server" can never disagree about what a write does.
 */
/** The fields a person can change on their own profile. */
export type ProfilePatch = Partial<Pick<Person, 'name' | 'phone' | 'tz' | 'pwHash'>> & { notif?: NotifPrefs }

export type Command =
  /** `top`: put the task first in the list (the header "+" on the Bugs column). */
  | { type: 'task.create'; task: Task; top?: boolean }
  /** `who` is the signed-in person; it names the author of the activity line. */
  | { type: 'task.update'; id: number; patch: Partial<Task>; log?: string; who?: string }
  | { type: 'task.delete'; id: number }
  | { type: 'task.comment'; id: number; text: string; who?: string }
  | { type: 'bug.message'; id: number; message: ChatMessage }
  | { type: 'question.message'; id: number; message: ChatMessage }
  | { type: 'request.comment'; id: number; comment: RequestComment }
  // Shared by the Tickets page and the DevOps board.
  | { type: 'question.create'; question: Question }
  | { type: 'question.update'; id: number; patch: Partial<Question> }
  | { type: 'request.create'; request: DevopsRequest }
  /** Updates a request; `log` adds a line to its history. */
  | { type: 'request.update'; id: number; patch: Partial<DevopsRequest>; log?: { by: string; text: string } }
  | { type: 'sprint.create'; sprint: Sprint }
  | { type: 'sprint.update'; id: string; patch: Partial<Sprint> }
  | { type: 'sprint.addMembers'; id: string; names: string[] }
  | { type: 'epic.create'; epic: Epic }
  | { type: 'epic.update'; id: string; patch: Partial<Epic> }
  /** Saves the signed-in user's own details in the directory. The session is written by the caller. */
  | { type: 'profile.update'; id: number; patch: ProfilePatch }
  | { type: 'batch'; cmds: Command[] }
  | TicketsCommand
  | DevopsCommand
  | CompaniesCommand
  | ProjectsCommand
  | TimeCommand
  | UsersCommand
  | ClientsCommand
  | InvoiceMatchCommand

export type Resource = 'workspace' | 'tasks' | 'entries' | 'weekSubmissions' | 'questions' | 'requests' | 'devops' | 'people' | 'companies' | 'internalProjects' | 'access' | 'leave' | 'notifications' | 'clientTeam' | 'invoiceMatch'

export const touches = (cmd: Command): Resource[] => {
  switch (cmd.type) {
    case 'task.create':
    case 'task.update':
    case 'task.delete':
    case 'task.comment':
    case 'bug.message':
      return ['tasks']
    case 'question.message':
    case 'question.create':
    case 'question.update':
      return ['questions']
    case 'request.create':
    case 'request.update':
      return ['requests']
    case 'request.comment':
      return ['requests']
    case 'sprint.create':
    case 'sprint.update':
    case 'sprint.addMembers':
    case 'epic.create':
    case 'epic.update':
      return ['workspace']
    case 'profile.update':
      return ['people']
    case 'batch':
      return [...new Set(cmd.cmds.flatMap(touches))]
    default:
      return [...touchesTickets(cmd), ...touchesDevops(cmd), ...touchesCompanies(cmd), ...touchesProjects(cmd), ...touchesTime(cmd), ...touchesUsers(cmd), ...touchesClients(cmd), ...touchesInvoiceMatch(cmd)]
  }
}

const mapTask = (db: Db, id: number, f: (t: Task) => Task): Db => ({
  ...db,
  tasks: db.tasks.map(t => (t.id === id ? f(t) : t)),
})

/**
 * Gives a new top-level task an id that is free in `db`. The client picks its
 * id from its own copy of the tasks, which can be stale (another tab, or a
 * create that is still in flight), so the copy the command is applied to has
 * the final say. Subtask records keep the ids they were given.
 */
export const assignIds = (db: Db, cmd: Command): Command => {
  switch (cmd.type) {
    case 'task.create':
    case 'tickets.task.createTop': {
      const { task } = cmd
      if (task.parent || !db.tasks.some(t => t.id === task.id)) return cmd
      return { ...cmd, task: { ...task, id: nextTaskId(db.tasks) } }
    }
    case 'batch': {
      // Commands in a batch run one after another, so each sees the ones before it.
      let acc = db
      const cmds = cmd.cmds.map(c => {
        const fixed = assignIds(acc, c)
        acc = reduce(acc, fixed)
        return fixed
      })
      return { ...cmd, cmds }
    }
    default:
      return assignTimeIds(db, cmd)
  }
}

/** The id of the top-level task a command creates, if it creates one. */
export const createdId = (cmd: Command): number | undefined =>
  cmd.type === 'task.create' || cmd.type === 'tickets.task.createTop' ? cmd.task.id : undefined

export const reduce = (db: Db, input: Command): Db => {
  const cmd = assignIds(db, input)
  switch (cmd.type) {
    case 'task.create':
      return {
        ...db,
        tasks: cmd.top
          ? [cmd.task, ...db.tasks.filter(t => t.id !== cmd.task.id)]
          : [...db.tasks.filter(t => t.id !== cmd.task.id), cmd.task],
      }
    case 'task.update':
      return mapTask(db, cmd.id, t => ({
        ...t,
        ...cmd.patch,
        acts: cmd.log ? [{ kind: 'history', who: cmd.who ?? 'Team', what: cmd.log, when: 'just now' }, ...t.acts] : t.acts,
      }))
    case 'task.delete':
      return { ...db, tasks: db.tasks.filter(t => t.id !== cmd.id) }
    case 'task.comment':
      return mapTask(db, cmd.id, t => ({ ...t, acts: [{ kind: 'comment', who: cmd.who ?? 'Team', text: cmd.text, when: 'just now' }, ...t.acts] }))
    case 'bug.message':
      return mapTask(db, cmd.id, t =>
        t.clientBug ? { ...t, clientBug: { ...t.clientBug, chat: [...t.clientBug.chat, cmd.message] } } : t,
      )
    case 'question.message':
      return {
        ...db,
        questions: db.questions.map(q =>
          q.id !== cmd.id
            ? q
            : {
                ...q,
                comments: [...(q.comments || []), cmd.message],
                // The client's first message is also stored as their answer, linked to the message (answerIdx).
                ...(cmd.message.side === 'client' && !q.answer
                  ? {
                      answer: cmd.message.text || 'Sent files',
                      answeredWhen: cmd.message.when,
                      answerBy: cmd.message.who,
                      answerIdx: (q.comments || []).length,
                    }
                  : {}),
              },
        ),
      }
    case 'question.create':
      return { ...db, questions: [...db.questions.filter(q => q.id !== cmd.question.id), cmd.question] }
    case 'question.update':
      return { ...db, questions: db.questions.map(q => (q.id === cmd.id ? { ...q, ...cmd.patch } : q)) }
    case 'request.create':
      return { ...db, requests: [cmd.request, ...db.requests.filter(r => r.id !== cmd.request.id)] }
    case 'request.update':
      return {
        ...db,
        requests: db.requests.map(r =>
          r.id !== cmd.id
            ? r
            : {
                ...r,
                ...cmd.patch,
                history: cmd.log ? [{ ...cmd.log, when: 'just now' }, ...(r.history || [])] : r.history,
              },
        ),
      }
    case 'request.comment':
      return {
        ...db,
        requests: db.requests.map(r => (r.id === cmd.id ? { ...r, comments: [...(r.comments || []), cmd.comment] } : r)),
      }
    case 'sprint.create':
      return { ...db, workspace: { ...db.workspace, sprints: [...db.workspace.sprints, cmd.sprint] } }
    case 'sprint.update':
      return {
        ...db,
        workspace: {
          ...db.workspace,
          sprints: db.workspace.sprints.map(s => (s.id === cmd.id ? { ...s, ...cmd.patch } : s)),
        },
      }
    case 'sprint.addMembers':
      return {
        ...db,
        workspace: {
          ...db.workspace,
          sprints: db.workspace.sprints.map(s =>
            s.id === cmd.id ? { ...s, members: [...new Set([...(s.members || []), ...cmd.names.filter(Boolean)])] } : s,
          ),
        },
      }
    case 'epic.create':
      return { ...db, workspace: { ...db.workspace, epics: [...db.workspace.epics, cmd.epic] } }
    case 'epic.update':
      return {
        ...db,
        workspace: {
          ...db.workspace,
          epics: db.workspace.epics.map(e => (e.id === cmd.id ? { ...e, ...cmd.patch } : e)),
        },
      }
    case 'profile.update':
      return {
        ...db,
        people: db.people.map(p => (p.id === cmd.id ? { ...p, ...cmd.patch } : p)),
      }
    case 'batch':
      return cmd.cmds.reduce(reduce, db)
    default:
      return reduceInvoiceMatch(reduceUsers(reduceProjects(reduceCompanies(reduceDevops(reduceTickets(reduceTime(reduceClients(db, cmd), cmd), cmd), cmd), cmd), cmd), cmd), cmd)
  }
}
