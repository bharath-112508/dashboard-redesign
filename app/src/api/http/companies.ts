import { ApiError, api } from './client'
import { readSession } from '../session/store'
import {
  clientProjectFrom,
  companyBody,
  companyFrom,
  companyRoleTo,
  contactFrom,
  epicFromStory,
  internalProjectFrom,
  projectBody,
  statusFromState,
  type BackendCompany,
  type BackendProject,
  type BackendRepresentative,
  type BackendStory,
} from './companyMappers'
import { isClientRole } from '../session/access'
import type { CompaniesCommand } from '../companies/commands'
import type { ProjectsCommand } from '../projects/commands'
import type { Company, CompanyContact, InternalProject, PersonId, Session } from '../types'

const PAGE = 100

/** Every item of a paginated list endpoint, page by page (the backend's page size is at most 100). */
export const allPages = async <T>(path: string): Promise<T[]> => {
  const items: T[] = []
  for (let page = 1; ; page++) {
    const batch = await api.get<T[]>(`${path}${path.includes('?') ? '&' : '?'}limit=${PAGE}&page=${page}`)
    items.push(...batch)
    if (batch.length < PAGE) return items
  }
}

const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Billable hours logged on a project this month (a support plan's "used"); 0 when the summary cannot be read. */
const hoursUsedThisMonth = async (projectId: string): Promise<number> => {
  const now = new Date()
  const from = day(new Date(now.getFullYear(), now.getMonth(), 1))
  try {
    const rows = await api.get<{ billable_total_minutes: number }[]>(
      `/timesheets/summary?project_id=${projectId}&from_date=${from}&to_date=${day(now)}&group_by=project`,
    )
    return Math.round((rows.reduce((m, r) => m + r.billable_total_minutes, 0) / 60) * 10) / 10
  } catch {
    return 0
  }
}

/** The projects the signed-in person may see, without archived ones (the app has no archived projects). */
export const liveProjects = async () => (await allPages<BackendProject>('/projects')).filter(p => !p.is_archived)

/**
 * The companies the signed-in person may see, each with its client projects
 * (and their epics) and its contacts. The backend scopes every list to the
 * caller; client users may not read companies at all, so theirs is built
 * from the session.
 */
// ponytail: one request per project (epics) and per company (contacts), and every write refetches all of it
// (queries.ts onSettled). Fine at Demo DB size; at production size add one backend endpoint that returns
// companies with their projects, epic summaries and contacts, and refetch only what a command touched.
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
        own.map(async p => {
          const [stories, used] = await Promise.all([allPages<BackendStory>(`/projects/${p.id}/stories`), p.support_plan ? hoursUsedThisMonth(p.id) : 0])
          return clientProjectFrom(p, stories.map(epicFromStory), used)
        }),
      )
      // Contacts: staff see every company's; a client admin only their own; a client user may not list them.
      const mayList = !clientUser && (!isClientRole(session.role) || c.id === session.orgId)
      // Removing a contact deactivates them, so deactivated people are not contacts.
      const people = mayList ? await allPages<BackendRepresentative>(`/companies/${c.id}/representatives`) : []
      const contacts = people.filter(p => p.status !== 'deactivated').map(contactFrom)
      return companyFrom(c, withEpics, contacts)
    }),
  )
}

/** Viljetech's own projects (no company). Client users have none. */
export const fetchInternalProjects = async (session: Session | null): Promise<InternalProject[]> => {
  if (!session || isClientRole(session.role)) return []
  return (await liveProjects()).filter(p => !p.company_id).map(internalProjectFrom)
}

// ─── Writes ──────────────────────────────────────────────────────────────

/** The commands this adapter sends to the backend in API mode. */
export type CompanyApiCommand = CompaniesCommand | ProjectsCommand

const COMMAND_TYPES = new Set<string>([
  'company.create',
  'company.update',
  'company.archive',
  'company.contact.save',
  'company.contact.remove',
  'company.responsible.save',
  'company.responsible.remove',
  'company.project.create',
  'project.client.setState',
  'project.internal.create',
  'project.internal.setState',
])

export const isCompanyApiCommand = (cmd: { type: string }): cmd is CompanyApiCommand => COMMAND_TYPES.has(cmd.type)

const LOWER = 'abcdefghijkmnpqrstuvwxyz'
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ'
const DIGIT = '23456789'
const SYMBOL = '!@#$%^&*-_=+'
const ALL = LOWER + UPPER + DIGIT + SYMBOL

/**
 * A starting password for a new client contact that nobody sees: the person
 * sets their own with "Forgot password". It has one of each character class,
 * so it passes the backend's character rules whatever they require.
 */
/** A uniform random index below `n`: values from the uneven top of the 32-bit range are drawn again. */
export const randomIndex = (n: number): number => {
  const limit = 2 ** 32 - (2 ** 32 % n)
  for (;;) {
    const v = crypto.getRandomValues(new Uint32Array(1))[0]
    if (v < limit) return v % n
  }
}

export const randomPassword = (length: number): string => {
  const pick = (set: string) => set[randomIndex(set.length)]
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL), ...Array.from({ length: Math.max(0, length - 4) }, () => pick(ALL))]
  // Shuffle so the classes are not always in the first four places.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1)
    ;[chars[i], chars[j]] = [chars[j], chars[i]]
  }
  return chars.join('')
}

/** Adds or removes one person on a project roster (`members` or `representatives`). */
const roster = (projectId: string, list: 'members' | 'representatives', change: 'add' | 'remove', person: PersonId) =>
  api.post(`/projects/${projectId}/${list}`, { [change]: [person] })

/** A password length inside the backend's policy (public settings), aiming for 16. */
export const passwordLength = async (): Promise<number> => {
  const { password_policy: p } = await api.get<{ password_policy?: { min_length: number; max_length: number } }>('/settings/public')
  return p ? Math.min(Math.max(16, p.min_length), p.max_length) : 16
}

/** A refusal shaped like the backend's, raised before any write so nothing is left half-done. */
const refuse = (message: string) => new ApiError(403, 'FORBIDDEN', message)

/** Only admins may change a user's role (backend `user.role_change`). */
const mayChangeRoles = () => readSession()?.role === 'super'

/** Creates a client contact: the user, their admin role, and their projects. Returns their id. */
export const createContact = async (companyId: string, c: CompanyContact): Promise<PersonId> => {
  if (c.admin && !mayChangeRoles()) throw refuse('Only an admin can make a contact a client admin.')
  const { id } = await api.post<{ id: string }>(`/companies/${companyId}/representatives`, {
    email: c.email,
    full_name: c.name,
    ...(c.role ? { title: c.role } : {}),
    initial_password: randomPassword(await passwordLength()),
    // They choose their own password from an emailed link; nobody sees the random one.
    send_invite: true,
  })
  if (c.admin) await api.post(`/users/${id}/change-role`, { new_role: 'client' })
  for (const p of c.projects) await roster(p, 'representatives', 'add', id)
  return id
}

const updateContact = async (companyId: string, c: CompanyContact & { personId: PersonId }) => {
  const before = await api.get<BackendRepresentative>(`/companies/${companyId}/representatives/${c.personId}`)
  const wasAdmin = before.role === 'client'
  // Checked before any write. The backend cannot turn a client admin back into a regular contact yet.
  if (wasAdmin && !c.admin) throw refuse('A client admin cannot be made a regular contact yet.')
  if (!wasAdmin && c.admin && !mayChangeRoles()) throw refuse('Only an admin can make a contact a client admin.')
  await api.patch(`/users/${c.personId}`, { full_name: c.name, client_profile: { title: c.role } })
  if (c.admin && !wasAdmin) await api.post(`/users/${c.personId}/change-role`, { new_role: 'client' })
  const had = new Set(before.projects.map(p => p.id))
  const wants = new Set(c.projects)
  for (const p of had) if (!wants.has(p)) await roster(p, 'representatives', 'remove', c.personId)
  for (const p of wants) if (!had.has(p)) await roster(p, 'representatives', 'add', c.personId)
}

/**
 * Sets (or, with `role` null, removes) one staff member on a company, and their membership of its projects.
 * The backend changes that one entry atomically, so two people editing at once can't erase each other.
 */
const setResponsible = async (companyId: string, person: PersonId, role: string | null, projects: string[]) => {
  if (role) await api.post(`/companies/${companyId}/responsibles`, { user_id: person, role })
  else await api.delete(`/companies/${companyId}/responsibles/${person}`)
  const own = await allPages<BackendProject>(`/projects?company_id=${companyId}`)
  for (const p of own) {
    const has = p.member_ids.includes(person)
    const wants = projects.includes(p.id)
    if (has && !wants) await roster(p.id, 'members', 'remove', person)
    if (!has && wants) await roster(p.id, 'members', 'add', person)
  }
}

/**
 * Sends a company or project command to the backend. Resolves with the
 * backend's id for a create, so the page can open what it just made.
 * A refusal from the backend rejects with its ApiError.
 */
export const sendCompanyCommand = async (cmd: CompanyApiCommand, today: string): Promise<{ id?: string }> => {
  switch (cmd.type) {
    case 'company.create': {
      const c = cmd.company
      const roles = Object.keys(c.ourRoles).length
        ? { responsibles: Object.entries(c.ourRoles).map(([user_id, r]) => ({ user_id, role: companyRoleTo(r) })) }
        : {}
      const { id } = await api.post<{ id: string }>('/companies', {
        ...companyBody({ name: c.name, industry: c.industry, country: c.country, web: c.web, notes: c.notes, logo: c.logo }),
        ...roles,
      })
      // A backend contact is a login account, so it needs an email. A contact that fails
      // must not hide the company that was created: the page opens it and the contact can be added there.
      for (const k of c.contacts) if (k.email) await createContact(id, k).catch(() => undefined)
      return { id }
    }
    case 'company.update': {
      const body = companyBody(cmd.patch)
      if (Object.keys(body).length) await api.patch(`/companies/${cmd.id}`, body)
      if (cmd.main?.email) {
        // The existing main contact is updated by id (name and email); without one, it is added.
        if (cmd.mainPersonId) {
          // Only what changed: editing a user is an admin action, so an unchanged contact must not be sent.
          const before = cmd.mainBefore
          const changes = {
            ...(cmd.main.name !== before?.name ? { full_name: cmd.main.name } : {}),
            ...(cmd.main.email !== before?.email ? { email: cmd.main.email } : {}),
          }
          if (Object.keys(changes).length) await api.patch(`/users/${cmd.mainPersonId}`, changes)
        } else await createContact(cmd.id, { personId: null, name: cmd.main.name, role: 'Main contact', email: cmd.main.email, projects: [] })
      }
      return {}
    }
    case 'company.archive':
      if (cmd.archived) await api.post(`/companies/${cmd.id}/archive`)
      else await api.patch(`/companies/${cmd.id}`, { status: 'active' })
      return {}
    case 'company.contact.save': {
      const c = cmd.contact
      if (c.personId) {
        await updateContact(cmd.companyId, { ...c, personId: c.personId })
        return {}
      }
      return { id: await createContact(cmd.companyId, c) }
    }
    case 'company.contact.remove':
      // By person, never by position: removing deactivates a real account.
      if (!cmd.personId) throw refuse('This contact cannot be removed here.')
      await api.delete(`/companies/${cmd.companyId}/representatives/${cmd.personId}`)
      return {}
    case 'company.responsible.save':
      await setResponsible(cmd.companyId, cmd.personId, companyRoleTo(cmd.role), cmd.projects)
      return {}
    case 'company.responsible.remove':
      await setResponsible(cmd.companyId, cmd.personId, null, [])
      return {}
    case 'company.project.create': {
      const { id } = await api.post<{ id: string }>('/projects', projectBody(cmd.project, cmd.companyId, today))
      return { id }
    }
    case 'project.internal.create': {
      const { id } = await api.post<{ id: string }>('/projects', projectBody(cmd.project, null, today))
      return { id }
    }
    case 'project.client.setState':
    case 'project.internal.setState':
      await api.patch(`/projects/${cmd.id}`, { status: statusFromState(cmd.state) })
      return {}
  }
}
