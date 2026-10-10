import type { Db } from '../types'
import type { Resource } from '../commands'

/**
 * Commands only the Tickets page sends (team side). Add new members to this
 * union and handle them in reduceTickets. Return `db` unchanged for commands
 * that are not yours.
 */
export type TicketsCommand = { type: 'tickets.noop' }

export const touchesTickets = (cmd: { type: string }): Resource[] => {
  void cmd
  return []
}

export const reduceTickets = (db: Db, cmd: { type: string }): Db => {
  void cmd
  return db
}
