import type { Db } from '../types'
import type { Resource } from '../commands'

/**
 * Commands only the DevOps board sends. Add new members to this union and
 * handle them in reduceDevops. Return `db` unchanged for commands that are not yours.
 */
export type DevopsCommand = { type: 'devops.noop' }

export const touchesDevops = (cmd: { type: string }): Resource[] => {
  void cmd
  return []
}

export const reduceDevops = (db: Db, cmd: { type: string }): Db => {
  void cmd
  return db
}
