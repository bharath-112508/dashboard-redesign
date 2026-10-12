/**
 * Header titles (SPEC §1.4 `LABEL` and the screen headers in §4). Placeholders use these;
 * feature screens may set their own (e.g. the project name).
 */
export const SCREEN_TITLES = {
  home: 'Dashboard',
  projects: 'Projects',
  portal: 'Projects',
  tickets: 'My tickets',
  time: 'My timesheet',
  devops: 'DevOps board',
  questions: 'Questions',
  bugs: 'Bugs',
  more: 'More',
  search: 'Search',
  me: 'Profile settings',
  leave: 'My leave',
  emp: 'Employee timesheets',
  cots: 'Timesheets',
  companies: 'Companies',
  company: 'Company',
  clients: 'Clients',
  portal_staff: 'Project portal',
  users: 'Users',
  user: 'User',
  ticket: 'Ticket',
  subtask: 'Subtask',
  project: 'Project',
  question: 'Question',
  bug: 'Bug',
  dvp: 'DevOps project',
  request: 'DevOps request',
  dvset: 'Settings',
} as const;

/** Dashboard scope line per role (S5-DASH header sub). */
export const DASH_SCOPE = {
  super: 'Everything across Viljetech and all client companies',
  admin: 'Viljetech team, projects and approvals',
  pm: 'Daco and Nordlys projects you manage',
  dev: 'Your tickets and time',
  devops: 'Infra, environments and DevOps requests',
  cadmin: 'Daco · all projects and colleagues',
  cuser: 'Daco platform',
} as const;
