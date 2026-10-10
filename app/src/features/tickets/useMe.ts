import { useMemo } from 'react'
import { usePeople } from '../../api/people/directory'
import { useSession } from '../../api/session/store'
import type { Person } from '../../api/types'
import { person as greyPerson, type Person as Avatar } from '../../lib/theme'

/** The signed-in person: directory id and display name. */
export interface Me {
  id: number
  name: string
}

/**
 * The person who is signed in. Ids come from the session; the name comes from
 * the directory, so a renamed person's tickets still match. Tickets code uses
 * this instead of a fixed name.
 */
export const useMe = (): Me => {
  const session = useSession()
  const people = usePeople().data ?? []
  const id = session?.personId ?? 0
  return { id, name: people.find(p => p.id === id)?.name ?? session?.name ?? '' }
}

/** Active Viljetech staff, in directory order. These are the names offered for assignees, members and time entries. */
export const useTeamPeople = (): Person[] => {
  const people = usePeople().data ?? []
  return useMemo(() => people.filter(p => p.org === 'vt' && p.active), [people])
}

/** Two-letter initials from the first and last word: "Bharath Reddy Panyala" -> "BP". */
export const initialsOf = (name: string) => {
  const w = name.trim().split(/\s+/).filter(Boolean)
  if (!w.length) return '?'
  return (w[0][0] + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase()
}

/**
 * Avatar for a name, coloured from the directory. A name that is not in the
 * directory gets the grey fallback.
 */
export const avatarFor = (people: readonly Person[], name: string): Avatar => {
  const p = people.find(x => x.name === name)
  return p ? { name, i: initialsOf(name), bg: p.colour } : greyPerson(name)
}

/** Directory id for a name, or 0 when there is no such person. */
export const idOfName = (people: readonly Person[], name: string) => people.find(p => p.name === name)?.id ?? 0
