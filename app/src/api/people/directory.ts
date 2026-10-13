import { useQuery } from '@tanstack/react-query'
import { qk } from '../queries'
import { server } from '../server'
import { readSession } from '../session/store'
import type { Person, PersonId, Session } from '../types'

/** The directory: the mock's people in mock mode, the backend's in API mode (server.get decides). */
export const fetchPeople = async (_session: Session | null): Promise<Person[]> => server.get('people')

/** Every person in the directory. The one source for name, role, colour and photo. */
export const usePeople = () => useQuery({ queryKey: qk.people, queryFn: () => fetchPeople(readSession()) })

/** The person with this id, if the directory has one. */
export const findPerson = (people: readonly Person[], id: PersonId): Person | undefined => people.find(p => p.id === id)

/** Finds a person by email, ignoring case and surrounding spaces. */
export const findPersonByEmail = (people: readonly Person[], email: string): Person | undefined => {
  const e = email.trim().toLowerCase()
  return people.find(p => p.email.toLowerCase() === e)
}
