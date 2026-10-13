import type { Role } from '../types'

/**
 * One row of the login page's account list in API mode: a real Demo DB
 * account for an app role, or the reason the backend has none yet.
 * Emails only; the password is never stored in the app.
 */
export interface DemoDbAccount {
  role: Role
  /** Shown after the name, like the mock's "· Freelancer". */
  variant?: string
  account?: { name: string; email: string; org: string; backendRole: string }
  missing?: string
}

/**
 * Demo DB (`vilje-platform-demo`) accounts, one per app role, each checked to
 * sign in through the API on 13 Oct 2026. Update this list if the Demo DB
 * changes; a row without an account says why.
 */
export const DEMO_DB_ACCOUNTS: readonly DemoDbAccount[] = [
  { role: 'super', account: { name: 'Vilje Admin', email: 'admin@viljetech.com', org: 'Viljetech', backendRole: 'admin' } },
  { role: 'admin', missing: 'The backend has no separate admin role; its admins sign in as Super admin.' },
  { role: 'pm', account: { name: 'Arjun Mehta', email: 'arjun@viljetech.com', org: 'Viljetech', backendRole: 'manager' } },
  { role: 'pm', variant: 'Team lead', account: { name: 'ganesh', email: 'ganesh@viljetech.com', org: 'Viljetech', backendRole: 'team_lead' } },
  { role: 'dev', account: { name: 'Rahul', email: 'rahul@viljetech.com', org: 'Viljetech', backendRole: 'employee' } },
  { role: 'dev', variant: 'Freelancer', account: { name: 'Munna', email: 'munna@yopmail.com', org: 'Viljetech', backendRole: 'employee' } },
  { role: 'devops', missing: 'The backend has no DevOps role yet.' },
  { role: 'cadmin', account: { name: 'Emma Lindqvist', email: 'emma@viljetech.com', org: 'Aurora Foods AB', backendRole: 'client' } },
  {
    role: 'cuser',
    account: { name: 'Lars Bergström', email: 'lars.bergstrom@aurorafoods.example', org: 'Aurora Foods AB', backendRole: 'representative' },
  },
]
