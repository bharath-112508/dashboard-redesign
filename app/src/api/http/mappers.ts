import { NEW_PERSON_COLOURS } from '../users/access'
import type { Person, Role, Session } from '../types'

/** The backend's system roles in the app's role names. */
const ROLE_MAP: Record<string, Role> = {
  admin: 'super',
  manager: 'pm',
  team_lead: 'pm',
  employee: 'dev',
  client: 'cadmin',
  representative: 'cuser',
}

/** Roles a custom "devops" role does not override: only a plain employee becomes a DevOps engineer. */
const KEEPS_ROLE = new Set(['admin', 'manager', 'team_lead', 'client', 'representative'])

/** The app's role for a backend user. A custom "devops" role wins over the staff roles. */
export const roleFromBackend = (role: string, roleKeys: readonly string[]): Role =>
  roleKeys.includes('devops') && !KEEPS_ROLE.has(role) ? 'devops' : (ROLE_MAP[role] ?? 'dev')

/** One user as `GET /users` returns it (the fields the app reads). */
export interface BackendUser {
  id: string
  full_name: string
  email: string
  role: string
  /** The user list and `/auth/me` send role keys (e.g. a custom `devops`). */
  role_keys?: string[]
  status: string
  /** The user's role assignments (system role and any custom ones). */
  role_ids?: string[]
  timezone: string
  phone?: string | null
  internal_profile?: { employment_type?: 'staff' | 'freelancer' | null; dev_type?: string | null }
  client_profile?: { company_id?: string }
  last_login_at: string | null
  /** A signed link to the person's photo, or null. */
  profile_photo_url?: string | null
}

/** A stable non-negative number from an id, for picking colours. */
export const hashOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)

/** A stable avatar colour from the person's id. */
const colourOf = (id: string) => NEW_PERSON_COLOURS[hashOf(id) % NEW_PERSON_COLOURS.length]

const empOf = (t: 'staff' | 'freelancer' | null | undefined) =>
  t === 'freelancer' ? ('freelancer' as const) : t === 'staff' ? ('employee' as const) : undefined

export const personFromUser = (u: BackendUser): Person => {
  const emp = empOf(u.internal_profile?.employment_type)
  return {
    id: u.id,
    name: u.full_name,
    email: u.email,
    org: u.client_profile?.company_id ?? 'vt',
    role: roleFromBackend(u.role, u.role_keys ?? []),
    // ponytail: everyone gets every project here; the backend scopes the real data. Fill from project members in Phase 1b.
    projects: 'all',
    colour: colourOf(u.id),
    active: u.status === 'active',
    last: u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : 'Never',
    tz: u.timezone,
    ...(emp ? { emp } : {}),
    ...(u.phone ? { phone: u.phone } : {}),
    ...(u.internal_profile?.dev_type ? { devType: u.internal_profile.dev_type } : {}),
    // A real photo, or '' for initials (never the design's sample faces).
    photo: u.profile_photo_url ?? '',
  }
}

/** The body of `GET /auth/me` (the fields the app reads). */
export interface BackendMe {
  id: string
  email: string
  full_name: string
  role: string
  role_keys: string[]
  timezone: string
  employment_type: 'staff' | 'freelancer' | null
  company_id: string | null
  company_name: string | null
  phone: string | null
}

export const sessionFromMe = (me: BackendMe): Session => {
  const emp = empOf(me.employment_type)
  return {
    personId: me.id,
    name: me.full_name,
    email: me.email,
    role: roleFromBackend(me.role, me.role_keys),
    org: me.company_id ? (me.company_name ?? 'Client') : 'Viljetech',
    ...(me.company_id ? { orgId: me.company_id } : {}),
    ...(emp ? { emp } : {}),
    ...(me.phone ? { phone: me.phone } : {}),
    tz: me.timezone,
  }
}
