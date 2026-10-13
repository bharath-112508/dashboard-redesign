import { hashOf } from './mappers'
import type { ClientProject, Company, CompanyContact, CompanyRole, EpicSummary, InternalProject, PersonId, ProjectState } from '../types'

/** One company as `GET /companies` returns it (the fields the app reads). Profile fields are absent on older documents. */
export interface BackendCompany {
  id: string
  name: string
  status: string
  industry?: string
  country?: string
  website?: string
  notes?: string
  logo?: string
  archived_at?: string | null
  responsibles?: { user_id: string; role: string }[]
}

/** One project as `GET /projects` returns it, with its task rollup. */
export interface BackendProject {
  id: string
  name: string
  description?: string
  status: string
  is_archived: boolean
  start_date: string
  end_date: string | null
  member_ids: string[]
  company_id: string | null
  area?: string
  support_plan?: { until: string; quota_hours: number } | null
  task_count?: number
  done_task_count?: number
}

/** One story (the app's epic) as `GET /projects/:id/stories` returns it. */
export interface BackendStory {
  id: string
  title: string
  derived_status: string
  progress_percent: number
  sprint_ids: string[]
}

/** One person as `GET /companies/:id/representatives` returns them. */
export interface BackendRepresentative {
  id: string
  full_name: string
  email: string
  role: string
  status: string
  title?: string
  projects: { id: string; name: string; code: string }[]
}

const STATE_OF: Record<string, ProjectState> = {
  active: 'active',
  completed: 'done',
  on_hold: 'hold',
  planned: 'planned',
  maintenance: 'maint',
}
const STATUS_OF: Record<ProjectState, string> = { active: 'active', done: 'completed', hold: 'on_hold', planned: 'planned', maint: 'maintenance' }

export const stateFromStatus = (status: string): ProjectState => STATE_OF[status] ?? 'active'
export const statusFromState = (state: ProjectState): string => STATUS_OF[state]

const ROLE_LABEL: Record<string, CompanyRole> = { super_admin: 'Super admin', admin: 'Admin', developer: 'Developer', viewer: 'Viewer' }
const ROLE_KEY: Record<CompanyRole, string> = { 'Super admin': 'super_admin', Admin: 'admin', Developer: 'developer', Viewer: 'viewer' }

export const companyRoleFrom = (role: string): CompanyRole => ROLE_LABEL[role] ?? 'Viewer'
export const companyRoleTo = (role: CompanyRole): string => ROLE_KEY[role]

/** A story's progress as an app epic state. */
const EPIC_STATE: Record<string, ProjectState> = { done: 'done', empty: 'planned', to_do: 'planned', blocked: 'hold' }

export const epicFromStory = (s: BackendStory): EpicSummary => ({
  id: s.id,
  name: s.title,
  state: EPIC_STATE[s.derived_status] ?? 'active',
  pct: s.progress_percent,
  sprints: s.sprint_ids.length,
})

const pctOf = (p: BackendProject) => (p.task_count ? Math.round((100 * (p.done_task_count ?? 0)) / p.task_count) : 0)

/** The fields client and internal projects share. */
const projectBase = (p: BackendProject) => ({
  id: p.id,
  name: p.name,
  desc: p.description ?? '',
  state: stateFromStatus(p.status),
  pct: pctOf(p),
  start: p.start_date,
  due: p.end_date ?? '',
  team: p.member_ids,
})

export const clientProjectFrom = (p: BackendProject, epics: EpicSummary[]): ClientProject => ({
  ...projectBase(p),
  epics,
  // ponytail: `used` is 0 until the timesheets slice sums this month's hours on the project.
  ...(p.support_plan ? { sup: { until: p.support_plan.until, quota: p.support_plan.quota_hours, used: 0 } } : {}),
})

export const internalProjectFrom = (p: BackendProject): InternalProject => {
  const { id, name, desc, state, pct, start, due, team } = projectBase(p)
  return { id, name, desc, area: p.area ?? '', state, pct, start, due, team }
}

export const contactFrom = (r: BackendRepresentative): CompanyContact => ({
  personId: r.id,
  name: r.full_name,
  role: r.title ?? '',
  email: r.email,
  projects: r.projects.map(p => p.id),
  admin: r.role === 'client',
})

export const companyFrom = (c: BackendCompany, projects: ClientProject[], contacts: CompanyContact[]): Company => ({
  id: c.id,
  name: c.name,
  industry: c.industry ?? '',
  country: c.country ?? '',
  web: c.website ?? '',
  ...(c.logo ? { logo: c.logo } : {}),
  // The palette index is derived from the id, so it never needs storing.
  p: hashOf(c.id),
  notes: c.notes ?? '',
  contacts,
  projects,
  ourRoles: Object.fromEntries((c.responsibles ?? []).map(r => [r.user_id, companyRoleFrom(r.role)])) as Record<PersonId, CompanyRole>,
  archived: c.status === 'archived',
  archivedAt: c.archived_at ? c.archived_at.slice(0, 10) : null,
})

// ─── App → backend request bodies ────────────────────────────────────────

/** The company fields a person edits (see CompanyFields in companies/commands.ts), plus the name. */
type CompanyInput = Partial<{ name: string; industry: string; country: string; web: string; notes: string; logo: string }>

/** A `POST`/`PATCH /companies` body with only the fields that were given; `web` is the backend's `website`. */
export const companyBody = (f: CompanyInput): Record<string, unknown> => {
  const { web, ...rest } = f
  return Object.fromEntries(Object.entries({ ...rest, ...(web !== undefined ? { website: web } : {}) }).filter(([, v]) => v !== undefined))
}

export const responsiblesBody = (ourRoles: Record<PersonId, CompanyRole>) =>
  Object.entries(ourRoles).map(([user_id, role]) => ({ user_id, role: companyRoleTo(role) }))

/** A `POST /projects` body for a client project (with its company) or an internal one (`companyId` null). */
export const projectBody = (p: ClientProject | InternalProject, companyId: string | null, today: string): Record<string, unknown> => ({
  name: p.name,
  description: p.desc,
  start_date: p.start || today,
  end_date: p.due || null,
  status: statusFromState(p.state),
  member_ids: p.team,
  company_id: companyId,
  ...('area' in p ? { area: p.area } : {}),
  ...('sup' in p && p.sup ? { support_plan: { until: p.sup.until, quota_hours: p.sup.quota } } : {}),
})
