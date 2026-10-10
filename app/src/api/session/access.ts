import type { PageName } from './pages'
import type { Role } from '../types'

export const ROLE_LABEL: Record<Role, string> = {
  super: 'Super admin',
  admin: 'Admin',
  pm: 'Project manager',
  dev: 'Developer',
  devops: 'DevOps engineer',
  cadmin: 'Client admin',
  cuser: 'Client user',
}

/**
 * Which pages each role can open, as the prototype's session.js (`ACC`) defines
 * them. `'*'` means every page. This is enforced in the client only; a backend
 * has to repeat it.
 */
const ACCESS: Record<Role, readonly PageName[] | '*'> = {
  super: '*',
  admin: '*',
  pm: ['Dashboard', 'Companies', 'Projects', 'Tickets', 'Clients', 'Timesheet', 'Employee Timesheets'],
  dev: ['Dashboard', 'Companies', 'Projects', 'Tickets', 'Timesheet'],
  devops: ['Dashboard', 'DevOps Board v6', 'Timesheet'],
  cadmin: ['Dashboard', 'Clients', 'Users'],
  cuser: ['Dashboard', 'Clients'],
}

/** Whether a role may open a page. My Tickets uses the Tickets rule; Login is always open. */
export const canAccess = (role: Role, page: PageName): boolean => {
  if (page === 'Login') return true
  const rule = ACCESS[role]
  if (rule === '*') return true
  const target = page === 'My Tickets' ? 'Tickets' : page
  return rule.includes(target)
}

export const isClientRole = (role: Role) => role === 'cadmin' || role === 'cuser'
