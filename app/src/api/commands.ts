import { ME } from '../lib/theme'
import type { ChatMessage, Db, DevopsRequest, Epic, Question, RequestComment, Sprint, Task, TimeEntry } from './types'
import { reduceTickets, touchesTickets, type TicketsCommand } from './tickets/commands'
import { reduceDevops, touchesDevops, type DevopsCommand } from './devops/commands'

/**
 * Every write the page makes is one of these commands. The same reducer runs
 * on the React Query cache (optimistic update) and in the mock server, so the
 * UI and the "server" can never disagree about what a write does.
 */
export type Command =
  /** `top`: put the task first in the list (the header "+" on the Bugs column). */
  | { type: 'task.create'; task: Task; top?: boolean }
  | { type: 'task.update'; id: number; patch: Partial<Task>; log?: string; who?: string }
  | { type: 'task.delete'; id: number }
  | { type: 'task.comment'; id: number; text: string }
  | { type: 'bug.message'; id: number; message: ChatMessage }
  | { type: 'question.message'; id: number; message: ChatMessage }
  | { type: 'request.comment'; id: number; comment: RequestComment }
  // Shared by the Tickets page and the DevOps board.
  | { type: 'question.create'; question: Question }
  | { type: 'question.update'; id: number; patch: Partial<Question> }
  | { type: 'request.create'; request: DevopsRequest }
  /** Updates a request; `log` adds a line to its history. */
  | { type: 'request.update'; id: number; patch: Partial<DevopsRequest>; log?: { by: string; text: string } }
  | { type: 'entry.create'; entry: TimeEntry }
  | { type: 'entry.delete'; id: number }
  | { type: 'sprint.create'; sprint: Sprint }
  | { type: 'sprint.update'; id: string; patch: Partial<Sprint> }
  | { type: 'sprint.addMembers'; id: string; names: string[] }
  | { type: 'epic.create'; epic: Epic }
  | { type: 'epic.update'; id: string; patch: Partial<Epic> }
  | { type: 'batch'; cmds: Command[] }
  | TicketsCommand
  | DevopsCommand

export type Resource = 'workspace' | 'tasks' | 'entries' | 'questions' | 'requests' | 'devops'

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
    case 'entry.create':
    case 'entry.delete':
      return ['entries']
    case 'request.comment':
      return ['requests']
    case 'sprint.create':
    case 'sprint.update':
    case 'sprint.addMembers':
    case 'epic.create':
    case 'epic.update':
      return ['workspace']
    case 'batch':
      return [...new Set(cmd.cmds.flatMap(touches))]
    default:
      return [...touchesTickets(cmd), ...touchesDevops(cmd)]
  }
}

const mapTask = (db: Db, id: number, f: (t: Task) => Task): Db => ({
  ...db,
  tasks: db.tasks.map(t => (t.id === id ? f(t) : t)),
})

export const reduce = (db: Db, cmd: Command): Db => {
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
        acts: cmd.log ? [{ kind: 'history', who: cmd.who ?? ME, what: cmd.log, when: 'just now' }, ...t.acts] : t.acts,
      }))
    case 'task.delete':
      return { ...db, tasks: db.tasks.filter(t => t.id !== cmd.id) }
    case 'task.comment':
      return mapTask(db, cmd.id, t => ({ ...t, acts: [{ kind: 'comment', who: ME, text: cmd.text, when: 'just now' }, ...t.acts] }))
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
                // The client's first message is also stored as their answer.
                ...(cmd.message.side === 'client' && !q.answer
                  ? { answer: cmd.message.text || 'Sent files', answeredWhen: cmd.message.when }
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
    case 'entry.create':
      return { ...db, entries: [...db.entries, cmd.entry] }
    case 'entry.delete':
      return { ...db, entries: db.entries.filter(e => e.id !== cmd.id) }
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
    case 'batch':
      return cmd.cmds.reduce(reduce, db)
    default:
      return reduceDevops(reduceTickets(db, cmd), cmd)
  }
}
