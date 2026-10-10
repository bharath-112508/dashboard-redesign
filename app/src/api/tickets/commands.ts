import type { Db, Task } from '../types'
import type { Resource } from '../commands'

/**
 * Commands only the Tickets page sends (team side). Add new members to this
 * union and handle them in reduceTickets. Return `db` unchanged for commands
 * that are not yours.
 */
export type TicketsCommand =
  /** Adds a ticket at the top of the list (the "+" next to a board column title). */
  | { type: 'tickets.task.createTop'; task: Task }
  /** Remembers how many client messages on a question the team has seen (unread badges). */
  | { type: 'tickets.question.seen'; id: number; seen: number }

export const touchesTickets = (cmd: { type: string }): Resource[] => {
  switch (cmd.type) {
    case 'tickets.task.createTop':
      return ['tasks']
    case 'tickets.question.seen':
      return ['questions']
    default:
      return []
  }
}

export const reduceTickets = (db: Db, cmd: { type: string }): Db => {
  const c = cmd as TicketsCommand
  switch (c.type) {
    case 'tickets.task.createTop':
      return { ...db, tasks: [c.task, ...db.tasks.filter(t => t.id !== c.task.id)] }
    case 'tickets.question.seen':
      return { ...db, questions: db.questions.map(q => (q.id === c.id ? { ...q, seenT: c.seen } : q)) }
    default:
      return db
  }
}
