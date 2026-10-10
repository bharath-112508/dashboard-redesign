import type { PageName } from '../../api/session/pages'

export interface NavItem {
  page: PageName
  label: string
  /** The label shown to client users, where it differs. */
  clientLabel?: string
  /** SVG path data, 24×24 grid. */
  icon: string
}

/** The nine sidebar items, in the prototype's order. Tickets has no item; it is reached from links and search. */
export const NAV: NavItem[] = [
  { page: 'Dashboard', label: 'Dashboard', icon: 'M4 13h6V4H4zM14 20h6v-9h-6zM14 4v4h6V4zM4 20h6v-3H4z' },
  { page: 'Companies', label: 'Companies', icon: 'M4 21V7l8-4 8 4v14M9 21v-5h6v5M9 10h.01M15 10h.01' },
  { page: 'Projects', label: 'Projects', icon: 'M3 7h7l2 2h9v10H3z' },
  { page: 'DevOps Board v6', label: 'DevOps board', icon: 'M5 12h14M12 5v14M5 5h4v4H5zM15 15h4v4h-4z' },
  { page: 'My Tickets', label: 'My tickets', icon: 'M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z' },
  {
    page: 'Clients',
    label: 'Clients',
    clientLabel: 'Project portal',
    icon: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M22 20a6 6 0 0 0-5-6',
  },
  { page: 'Timesheet', label: 'Timesheet', icon: 'M12 7v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z' },
  { page: 'Employee Timesheets', label: 'Employee timesheets', icon: 'M4 5h16v14H4zM4 9h16M9 13h6M9 16h4' },
  { page: 'Users', label: 'Users', icon: 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0' },
]

/** Pages whose own header carries the back link, so the shell's Back button is hidden. */
export const OWN_BACK: readonly PageName[] = ['Tickets', 'Clients']
