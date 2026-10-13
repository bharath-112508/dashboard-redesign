import { api } from './client'
import {
  clientProjectFrom,
  companyFrom,
  contactFrom,
  epicFromStory,
  internalProjectFrom,
  type BackendCompany,
  type BackendProject,
  type BackendRepresentative,
  type BackendStory,
} from './companyMappers'
import { isClientRole } from '../session/access'
import type { Company, InternalProject, Session } from '../types'

const PAGE = 100

/** Every item of a paginated list endpoint, page by page (the backend's page size is at most 100). */
export const allPages = async <T>(path: string): Promise<T[]> => {
  const items: T[] = []
  for (let page = 1; ; page++) {
    const batch = await api.get<T[]>(`${path}?limit=${PAGE}&page=${page}`)
    items.push(...batch)
    if (batch.length < PAGE) return items
  }
}

/** The projects the signed-in person may see, without archived ones (the app has no archived projects). */
const liveProjects = async () => (await allPages<BackendProject>('/projects')).filter(p => !p.is_archived)

/**
 * The companies the signed-in person may see, each with its client projects
 * (and their epics) and its contacts. The backend scopes every list to the
 * caller; client users may not read companies at all, so theirs is built
 * from the session.
 */
export const fetchCompanies = async (session: Session | null): Promise<Company[]> => {
  if (!session) return []
  const projects = (await liveProjects()).filter(p => p.company_id)
  const clientUser = session.role === 'cuser'
  const companies: BackendCompany[] = clientUser
    ? session.orgId
      ? [{ id: session.orgId, name: session.org, status: 'active' }]
      : []
    : await allPages<BackendCompany>('/companies')

  return Promise.all(
    companies.map(async c => {
      const own = projects.filter(p => p.company_id === c.id)
      const withEpics = await Promise.all(
        own.map(async p => clientProjectFrom(p, (await allPages<BackendStory>(`/projects/${p.id}/stories`)).map(epicFromStory))),
      )
      // Contacts: staff see every company's; a client admin only their own; a client user may not list them.
      const mayList = !clientUser && (!isClientRole(session.role) || c.id === session.orgId)
      const contacts = mayList ? (await allPages<BackendRepresentative>(`/companies/${c.id}/representatives`)).map(contactFrom) : []
      return companyFrom(c, withEpics, contacts)
    }),
  )
}

/** Viljetech's own projects (no company). Client users have none. */
export const fetchInternalProjects = async (session: Session | null): Promise<InternalProject[]> => {
  if (!session || isClientRole(session.role)) return []
  return (await liveProjects()).filter(p => !p.company_id).map(internalProjectFrom)
}
