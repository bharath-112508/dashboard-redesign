/**
 * The pages of the app, by the names the uploaded prototype uses. Each one has
 * a route path. The Clients, Tickets and DevOps pages keep their existing
 * trees; see app/README.md for the full mapping.
 */
export const PAGE_NAMES = [
  'Login',
  'Dashboard',
  'Companies',
  'Projects',
  'DevOps Board v6',
  'Tickets',
  'My Tickets',
  'Clients',
  'Timesheet',
  'Employee Timesheets',
  'Users',
] as const

export type PageName = (typeof PAGE_NAMES)[number]

export const PAGE_PATH: Record<PageName, string> = {
  Login: '/login',
  Dashboard: '/dashboard',
  Companies: '/companies',
  Projects: '/projects',
  'DevOps Board v6': '/devops/board',
  Tickets: '/tickets/board',
  'My Tickets': '/my-tickets',
  Clients: '/clients/board',
  Timesheet: '/timesheet',
  'Employee Timesheets': '/employee-timesheets',
  Users: '/users',
}

/** The page a path belongs to, by its first segment. Null for the root and unknown paths. */
const BY_SEGMENT: Record<string, PageName> = {
  login: 'Login',
  dashboard: 'Dashboard',
  companies: 'Companies',
  projects: 'Projects',
  devops: 'DevOps Board v6',
  tickets: 'Tickets',
  'my-tickets': 'My Tickets',
  clients: 'Clients',
  timesheet: 'Timesheet',
  'employee-timesheets': 'Employee Timesheets',
  users: 'Users',
}

export const pageOfPath = (pathname: string): PageName | null => BY_SEGMENT[pathname.split('/')[1] ?? ''] ?? null

/** The page named in a prototype hash such as "#Dashboard" (the name, not the path). */
export const isPageName = (name: string): name is PageName => (PAGE_NAMES as readonly string[]).includes(name)
