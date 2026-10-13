import type { Company, Db, InternalProject, LeaveRequest, LeaveStatus, Notification, Person, PersonId, Role } from '../types'
import type { Resource } from '../commands'
import { range } from '../../lib/dates'
import { DEFAULT_PERMS, DEFAULT_DEV_TYPES } from './access'

/** Writes to people, the permission matrix, developer types and leave. The reducer runs on the cache and on the mock server. */
export type UsersCommand =
  | { type: 'user.create'; person: Person }
  | { type: 'user.update'; id: PersonId; patch: Partial<Person> }
  | { type: 'user.remove'; id: PersonId }
  | { type: 'access.setPerm'; role: Role; perm: string; on: boolean }
  | { type: 'access.addDevType'; name: string }
  | { type: 'leave.create'; request: LeaveRequest }
  | { type: 'leave.decide'; id: number; status: Exclude<LeaveStatus, 'Pending'>; by: string; when: string }

const PREFIX = /^(user|access|leave)\./

export const isUsersCommand = (c: { type: string }) => PREFIX.test(c.type)

export const touchesUsers = (cmd: { type: string }): Resource[] => {
  switch (cmd.type) {
    case 'user.create':
    case 'user.update':
      return ['people']
    case 'user.remove':
      // Removing a person also clears them from companies and internal projects.
      return ['people', 'companies', 'internalProjects']
    case 'access.setPerm':
    case 'access.addDevType':
      return ['access']
    case 'leave.create':
      return ['leave']
    case 'leave.decide':
      return ['leave', 'notifications']
    default:
      return []
  }
}

/** The access config, or the seed defaults for a db saved before WP-07. */
export const accessOf = (db: Db): Db['access'] => db.access ?? { perms: DEFAULT_PERMS, devTypes: DEFAULT_DEV_TYPES }

const nextId = (ids: number[]) => Math.max(0, ...ids) + 1
/** A free person id for the mock: one past the largest numeric id. */
const nextPersonId = (ids: PersonId[]): PersonId => String(nextId(ids.map(Number).filter(Number.isFinite)))

const withoutKey = (rec: Record<PersonId, unknown>, id: PersonId) => {
  const copy = { ...rec }
  delete copy[id]
  return copy
}

const clearPerson = (companies: Company[], internal: InternalProject[], id: PersonId) => ({
  companies: companies.map(c => ({
    ...c,
    ourRoles: withoutKey(c.ourRoles, id) as Company['ourRoles'],
    contacts: c.contacts.map(ct => (ct.personId === id ? { ...ct, personId: null } : ct)),
    projects: c.projects.map(p => ({ ...p, team: p.team.filter(x => x !== id) })),
  })),
  internalProjects: internal.map(p => ({ ...p, team: p.team.filter(x => x !== id) })),
})

export const reduceUsers = (db: Db, c: { type: string }): Db => {
  const cmd = c as UsersCommand
  switch (cmd.type) {
    case 'user.create': {
      const emailTaken = db.people.some(p => p.email.toLowerCase() === cmd.person.email.toLowerCase())
      if (emailTaken) return db
      const id = db.people.some(p => p.id === cmd.person.id) ? nextPersonId(db.people.map(p => p.id)) : cmd.person.id
      return { ...db, people: [...db.people, { ...cmd.person, id }] }
    }
    case 'user.update':
      return { ...db, people: db.people.map(p => (p.id === cmd.id ? { ...p, ...cmd.patch } : p)) }
    case 'user.remove': {
      const cleared = clearPerson(db.companies, db.internalProjects ?? [], cmd.id)
      return {
        ...db,
        people: db.people.filter(p => p.id !== cmd.id),
        companies: cleared.companies,
        internalProjects: cleared.internalProjects,
      }
    }
    case 'access.setPerm': {
      // The super admin column is locked in the matrix; the reducer refuses it too.
      if (cmd.role === 'super') return db
      const acc = accessOf(db)
      const cur = acc.perms[cmd.role] ?? []
      const next = cmd.on ? [...new Set([...cur, cmd.perm])] : cur.filter(x => x !== cmd.perm)
      return { ...db, access: { ...acc, perms: { ...acc.perms, [cmd.role]: next } } }
    }
    case 'access.addDevType': {
      const acc = accessOf(db)
      const name = cmd.name.trim()
      if (!name || acc.devTypes.some(d => d.toLowerCase() === name.toLowerCase())) return db
      return { ...db, access: { ...acc, devTypes: [...acc.devTypes, name] } }
    }
    case 'leave.create': {
      const leave = db.leave ?? []
      const id = leave.some(r => r.id === cmd.request.id) ? nextId(leave.map(r => r.id)) : cmd.request.id
      // New requests always start Pending; only a decision changes that.
      return { ...db, leave: [...leave, { ...cmd.request, id, status: 'Pending' }] }
    }
    case 'leave.decide': {
      const leave = db.leave ?? []
      const req = leave.find(r => r.id === cmd.id)
      if (!req || req.status !== 'Pending') return db
      const notes: Notification[] = db.notifications ?? []
      const verb = cmd.status === 'Approved' ? 'approved' : 'rejected'
      const note: Notification = {
        id: nextId(notes.map(n => n.id)),
        userId: req.userId,
        kind: 'leave',
        text: `Your ${req.type} leave, ${range(req.from, req.to)}, was ${verb}.`,
        when: 'just now',
      }
      return {
        ...db,
        leave: leave.map(r => (r.id === cmd.id ? { ...r, status: cmd.status, decidedBy: cmd.by, decidedWhen: cmd.when } : r)),
        notifications: [note, ...notes],
      }
    }
    default:
      return db
  }
}

