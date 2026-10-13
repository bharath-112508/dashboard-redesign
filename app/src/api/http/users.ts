import { api } from './client'
import { allPages, liveProjects } from './companies'
import { personFromUser, type BackendUser } from './mappers'
import { DEFAULT_DEV_TYPES, DEFAULT_PERMS } from '../users/access'
import type { AccessConfig, Person, Role, Session } from '../types'

/** The person a session describes, for client users who may not list anyone. */
const selfOf = (s: Session): Person => ({
  id: s.personId,
  name: s.name,
  email: s.email,
  org: s.orgId ?? 'vt',
  role: s.role,
  projects: 'all',
  colour: '#4870E8',
  active: true,
  last: 'Now',
  photo: '',
})

/** Backend roles that see every project. */
const SEES_ALL = new Set(['admin', 'manager'])

/**
 * The people directory. Staff list the backend's users (an admin also the
 * deactivated ones), with each person's projects from project membership.
 * A client admin sees their company's contacts; a client user only themselves.
 */
export const fetchPeopleApi = async (session: Session | null): Promise<Person[]> => {
  if (!session) return []
  if (session.role === 'cuser') return [selfOf(session)]
  if (session.role === 'cadmin') {
    if (!session.orgId) return [selfOf(session)]
    const contacts = await allPages<BackendUser>(`/companies/${session.orgId}/representatives`)
    const people = contacts.map(u => ({ ...personFromUser(u), org: session.orgId as string }))
    return people.some(p => p.id === session.personId) ? people : [selfOf(session), ...people]
  }
  const [users, projects] = await Promise.all([
    allPages<BackendUser>(session.role === 'super' ? '/users?show_deleted=true' : '/users'),
    liveProjects(),
  ])
  return users.map(u => {
    const p = personFromUser(u)
    return SEES_ALL.has(u.role) ? p : { ...p, projects: projects.filter(x => x.member_ids?.includes(u.id)).map(x => x.id) }
  })
}

/** The Roles & permissions grid and developer types: what was saved, else the design's defaults. */
export const fetchAccessApi = async (): Promise<AccessConfig> => {
  const stored = await api.get<{ perms: Partial<Record<Role, string[]>> | null; dev_types: string[] | null }>('/app-access')
  return {
    perms: { ...DEFAULT_PERMS, ...(stored.perms ?? {}) },
    devTypes: stored.dev_types ?? DEFAULT_DEV_TYPES,
  }
}
