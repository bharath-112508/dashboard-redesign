import { useQuery } from '@tanstack/react-query'
import { qk } from '../queries'
import { server } from '../server'
import { allPages } from '../http/companies'
import { apiMode } from '../http/config'
import { personFromUser, type BackendUser } from '../http/mappers'
import { isClientRole } from '../session/access'
import { readSession } from '../session/store'
import type { Person, PersonId, Session } from '../types'

/** The directory: the mock's people in mock mode, the backend's users in API mode. */
export const fetchPeople = async (session: Session | null): Promise<Person[]> => {
  if (!apiMode) return server.get('people')
  if (!session) return []
  // Client roles may not list users, so they see just themselves for now.
  if (isClientRole(session.role)) {
    return [
      {
        id: session.personId,
        name: session.name,
        email: session.email,
        org: session.orgId ?? 'vt',
        role: session.role,
        projects: 'all',
        colour: '#4870E8',
        active: true,
        last: 'Now',
      },
    ]
  }
  return (await allPages<BackendUser>('/users')).map(personFromUser)
}

/** Every person in the directory. The one source for name, role, colour and photo. */
export const usePeople = () => useQuery({ queryKey: qk.people, queryFn: () => fetchPeople(readSession()) })

/** The person with this id, if the directory has one. */
export const findPerson = (people: readonly Person[], id: PersonId): Person | undefined => people.find(p => p.id === id)

/** Finds a person by email, ignoring case and surrounding spaces. */
export const findPersonByEmail = (people: readonly Person[], email: string): Person | undefined => {
  const e = email.trim().toLowerCase()
  return people.find(p => p.email.toLowerCase() === e)
}
