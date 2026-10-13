import type { Command } from '../commands'
import type { Db, PersonId, Session, Task } from '../types'
import { buildScope, scopeQuestions } from '../../domain/scope'
import { isClientRole } from './access'

/**
 * What client roles (cadmin, cuser) may write. The product rule: a client only
 * raises bugs and answers the questions sent to them. So a client may
 * - report a bug (a new top-level task with `clientBug`, in one of their epics),
 * - work on their own bugs: chat, priority, description and attachments,
 * - answer their questions: reply, edit their own message, mark solved or reopen,
 * - use the live InvoiceMatch app, change their own profile,
 * - and a client admin may manage their own team (portal team and colleagues).
 * Everything else (creating or editing team tasks, subtasks, time, moves,
 * comments on team tasks, DevOps requests, new questions, epics and sprints)
 * is refused. Team roles are not limited here.
 *
 * The mock server checks every command against the signed-in session, so a
 * command forged in the browser is refused too; the UI hides the same controls.
 * A real backend has to repeat this check.
 */
export type Actor = Pick<Session, 'personId' | 'name' | 'role' | 'orgId'>

/** Task fields a client may change on their own bug. */
const BUG_FIELDS = new Set<keyof Task>(['prio', 'desc', 'atts'])
/** Question fields a client may change (mark solved / reopen). */
const QUESTION_FIELDS = new Set(['solved'])

const onlyKeys = (patch: object, allowed: Set<string>) => Object.keys(patch).every(k => allowed.has(k))

/** Why a client may not run this command, or null when they may (always null for team roles and no session). */
export const refusal = (db: Db, cmd: Command, actor: Actor | null): string | null => {
  if (!actor || !isClientRole(actor.role)) return null
  return clientRefusal(db, cmd, actor)
}

const clientRefusal = (db: Db, cmd: Command, actor: Actor): string | null => {
  const scope = buildScope(actor.orgId, db.companies ?? [], db.workspace)
  const tasks = db.tasks ?? []
  const ownBug = (id: number) => {
    const t = tasks.find(x => x.id === id)
    return !!t && !!t.clientBug && !t.parent && scope.epicIds.includes(t.epic)
  }
  const ownQuestion = (id: number) => scopeQuestions(db.questions ?? [], tasks, scope).some(q => q.id === id)
  const admin = actor.role === 'cadmin'
  const ownPerson = (id: PersonId) => (db.people ?? []).find(p => p.id === id)?.org === actor.orgId
  const no = (what: string) => `Clients cannot ${what}.`

  switch (cmd.type) {
    case 'batch': {
      for (const c of cmd.cmds) {
        const why = clientRefusal(db, c, actor)
        if (why) return why
      }
      return null
    }
    case 'task.create':
      return cmd.task.clientBug && !cmd.task.parent && scope.epicIds.includes(cmd.task.epic) ? null : no('create tasks; they report bugs')
    case 'task.update':
      if (!ownBug(cmd.id)) return no('edit team tasks')
      return onlyKeys(cmd.patch, BUG_FIELDS) ? null : no('change that on a bug')
    case 'bug.message':
      return ownBug(cmd.id) && cmd.message.side === 'client' ? null : no('post on that bug')
    case 'question.message':
      return ownQuestion(cmd.id) && cmd.message.side === 'client' ? null : no('post on that question')
    case 'question.update':
      return ownQuestion(cmd.id) && onlyKeys(cmd.patch, QUESTION_FIELDS) ? null : no('change that question')
    case 'question.editMessage':
      return ownQuestion(cmd.id) && cmd.who === actor.name ? null : no('edit that message')
    case 'question.create':
      return no('start questions')
    case 'request.create':
    case 'request.update':
    case 'request.comment':
      return no('raise or change DevOps requests')
    case 'task.comment':
      return no('comment on team tasks')
    case 'time.log':
    case 'time.remove':
      return no('log time')
    case 'invoiceMatch.decide':
      return null
    case 'profile.update':
      return cmd.id === actor.personId ? null : no("change someone else's profile")
    case 'clientTeam.add':
      return admin && cmd.member.companyId === actor.orgId ? null : no('change that team')
    case 'clientTeam.remove': {
      const m = (db.clientTeam ?? []).find(x => x.id === cmd.id)
      return admin && (!m || m.companyId === actor.orgId) ? null : no('change that team')
    }
    case 'user.create':
      return admin && cmd.person.org === actor.orgId && isClientRole(cmd.person.role) ? null : no('add that user')
    case 'user.update':
      return admin &&
        ownPerson(cmd.id) &&
        (cmd.patch.org === undefined || cmd.patch.org === actor.orgId) &&
        (cmd.patch.role === undefined || isClientRole(cmd.patch.role))
        ? null
        : no('change that user')
    case 'user.remove':
      return admin && ownPerson(cmd.id) ? null : no('remove that user')
    default:
      return no('do that')
  }
}
