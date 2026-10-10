import { createContext, useContext } from 'react'
import { person, type Person } from '../lib/theme'

/**
 * Which side of the product a page is: the client-facing Clients page or the
 * team's Tickets page. Shared windows (ticket drawer, question chat …) read it
 * to decide whose messages sit on the right, which actions show, and how
 * avatars look (grey initials for clients, personal colours for the team).
 * The default is the Clients page.
 */
export interface PageInfo {
  side: 'client' | 'team'
  /** Base path of the page, e.g. "/clients" or "/tickets". */
  base: string
  person: (name: string) => Person
}

export const PageContext = createContext<PageInfo>({ side: 'client', base: '/clients', person })

export const usePage = () => useContext(PageContext)
export const usePerson = () => useContext(PageContext).person
