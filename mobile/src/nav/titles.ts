import type { Role } from '@/data/types';

/** Large-header titles of the tab roots (SPEC.md §1.3). */
export function tabTitle(key: string, role: Role): string {
  const staffAll = role === 'pm' || role === 'admin' || role === 'super';
  switch (key) {
    case 'home':
      return 'Home';
    case 'tickets':
      return staffAll ? 'Tickets' : 'My tickets';
    case 'time':
      return 'Timesheet';
    case 'projects':
      return role === 'client' ? 'Your projects' : 'Projects';
    case 'devops':
      return 'DevOps';
    case 'questions':
      return 'Questions';
    case 'bugs':
      return 'Your bugs';
    case 'more':
      return 'More';
    default:
      return '';
  }
}

/** Small-header titles of pushed screens with a fixed title (SPEC.md §1.3). */
export const SCREEN_TITLES = {
  inbox: 'Notifications',
  me: 'Profile',
  leave: 'Leave & comp-off',
  team: 'Team hours',
  users: 'Users',
  dvset: 'DevOps settings',
  history: 'Time history',
  board: 'Ticket board',
  devops: 'DevOps',
  companies: 'Companies',
  question: 'Question',
  projects: 'Projects',
  tickets: 'Tickets',
} as const;
