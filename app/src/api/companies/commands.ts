import type { ClientProject, Company, CompanyContact, CompanyRole, Db, PersonId, ProjectState } from '../types'
import type { Resource } from '../commands'

/**
 * Commands for companies, client contacts, responsibilities (people from
 * Viljetech on a company) and client projects. Owned by the Companies and
 * Projects pages. Add a command to this union and handle it in reduceCompanies.
 */

/** The company fields a person can edit after creation. */
export interface CompanyFields {
  name: string
  industry: string
  country: string
  web: string
  notes: string
  /** A data URL, or '' to remove the logo. */
  logo: string
}

export type CompaniesCommand =
  | { type: 'company.create'; company: Company }
  /** `main` sets the first contact (the main contact): its name and email, or adds it when there is none. */
  | {
      type: 'company.update'
      id: string
      patch: Partial<CompanyFields>
      main?: { name: string; email: string }
      /** The main contact as it was when the form opened, so only real changes are sent (API mode). */
      mainBefore?: { name: string; email: string }
      /** The current main contact's person id, so the backend updates that contact (API mode). */
      mainPersonId?: PersonId | null
    }
  | { type: 'company.archive'; id: string; archived: boolean; at: string | null }
  /** `index` null adds a contact; otherwise replaces the one at that index. */
  | { type: 'company.contact.save'; companyId: string; index: number | null; contact: CompanyContact }
  /** `personId` identifies the contact for the backend (API mode); the mock uses `index`. */
  | { type: 'company.contact.remove'; companyId: string; index: number; personId: PersonId | null }
  /** Sets a responsible person's role and the company projects they are on. */
  | { type: 'company.responsible.save'; companyId: string; personId: PersonId; role: CompanyRole; projects: string[] }
  /** Removes the responsibility, the role and the membership in every project of the company. */
  | { type: 'company.responsible.remove'; companyId: string; personId: PersonId }
  | { type: 'company.project.create'; companyId: string; project: ClientProject }
  /** Moves a client project between Planned, Active, On hold, Maintenance and Completed. Internal projects use project.internal.setState. */
  | { type: 'project.client.setState'; companyId: string; id: string; state: ProjectState }

export const touchesCompanies = (cmd: { type: string }): Resource[] => {
  const c = cmd as CompaniesCommand
  switch (c.type) {
    case 'company.create':
    case 'company.update':
    case 'company.archive':
    case 'company.contact.save':
    case 'company.contact.remove':
    case 'company.responsible.save':
    case 'company.responsible.remove':
    case 'company.project.create':
      return ['companies']
    case 'project.client.setState':
      return ['companies']
    default:
      return []
  }
}

const mapCompany = (db: Db, id: string, f: (c: Company) => Company): Db => ({
  ...db,
  companies: db.companies.map(c => (c.id === id ? f(c) : c)),
})

/** Puts the main contact's name and email on the first contact, or adds it. */
const withMain = (contacts: CompanyContact[], main: { name: string; email: string } | undefined): CompanyContact[] => {
  const name = main?.name.trim()
  if (!main || !name) return contacts
  const email = main.email.trim()
  if (contacts.length === 0) return [{ personId: null, name, role: 'Main contact', email, projects: [] }]
  const [first, ...rest] = contacts
  return [{ ...first, name, email }, ...rest]
}

export const reduceCompanies = (db: Db, cmd: { type: string }): Db => {
  const c = cmd as CompaniesCommand
  switch (c.type) {
    case 'company.create':
      return { ...db, companies: [...db.companies.filter(x => x.id !== c.company.id), c.company] }

    case 'company.update':
      return mapCompany(db, c.id, co => ({
        ...co,
        ...c.patch,
        contacts: withMain(co.contacts, c.main),
      }))

    case 'company.archive':
      return mapCompany(db, c.id, co => ({ ...co, archived: c.archived, archivedAt: c.archived ? c.at : null }))

    case 'company.contact.save':
      return mapCompany(db, c.companyId, co => ({
        ...co,
        contacts:
          c.index === null || c.index >= co.contacts.length
            ? [...co.contacts, c.contact]
            : co.contacts.map((x, i) => (i === c.index ? c.contact : x)),
      }))

    case 'company.contact.remove':
      return mapCompany(db, c.companyId, co => ({ ...co, contacts: co.contacts.filter((_, i) => i !== c.index) }))

    case 'company.responsible.save':
      return mapCompany(db, c.companyId, co => ({
        ...co,
        ourRoles: { ...co.ourRoles, [c.personId]: c.role },
        projects: co.projects.map(p => {
          const wanted = c.projects.includes(p.id)
          const on = p.team.includes(c.personId)
          if (wanted === on) return p
          return { ...p, team: wanted ? [...p.team, c.personId] : p.team.filter(id => id !== c.personId) }
        }),
      }))

    case 'company.responsible.remove':
      return mapCompany(db, c.companyId, co => {
        const { [c.personId]: _gone, ...ourRoles } = co.ourRoles
        return {
          ...co,
          ourRoles,
          projects: co.projects.map(p => ({ ...p, team: p.team.filter(id => id !== c.personId) })),
        }
      })

    case 'company.project.create':
      return mapCompany(db, c.companyId, co => ({
        ...co,
        projects: [c.project, ...co.projects.filter(p => p.id !== c.project.id)],
      }))

    case 'project.client.setState':
      return mapCompany(db, c.companyId, co => ({
        ...co,
        projects: co.projects.map(p => (p.id === c.id ? { ...p, state: c.state } : p)),
      }))

    default:
      return db
  }
}
