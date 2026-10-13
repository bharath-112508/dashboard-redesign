import type { IconName } from '@/components/icons';
import { can, isClientRole } from '@/data/selectors';
import type { Page, Role } from '@/data/types';

import type { PageKey } from './routes';
import { tabsFor } from './tabs';

export interface MorePage {
  key: PageKey;
  label: string;
  icon: IconName;
  sub: string;
}

/** Candidate pages in order (SPEC §2.5): access page, key, icon, sub. */
const CANDIDATES: { page: Page; key: PageKey; tab?: string; label: string; icon: IconName; sub: string }[] = [
  { page: 'Companies', key: 'companies', label: 'Companies', icon: 'building-2', sub: 'Clients, contacts and archive' },
  { page: 'Projects', key: 'projects', tab: 'projects', label: 'Projects', icon: 'folder-kanban', sub: 'Client and internal projects' },
  { page: 'DevOps Board v6', key: 'devops', tab: 'devops', label: 'DevOps board', icon: 'server', sub: 'Infra status, follow-ups and deployments' },
  { page: 'Tickets', key: 'mytickets', tab: 'tickets', label: 'My tickets', icon: 'ticket', sub: 'Your tickets across projects' },
  { page: 'Clients', key: 'clients', label: 'Clients', icon: 'users', sub: 'Client portals, questions and bugs' },
  { page: 'Timesheet', key: 'time', tab: 'time', label: 'Timesheet', icon: 'clock-3', sub: 'Log hours, week and history' },
  { page: 'Employee Timesheets', key: 'emp', label: 'Employee timesheets', icon: 'sheet', sub: 'All projects and employees' },
  { page: 'Users', key: 'users', label: 'Users', icon: 'user-cog', sub: 'People, leave and permissions' },
];

/**
 * The More page's "Pages" list (`morePages`, SPEC §2.5): pages `can()` allows that are
 * not already a tab. Clients never get Clients; Users reads "Your team" for clients.
 * Staff also get "Leave" → My leave (A-2).
 */
export function morePages(role: Role | null | undefined): MorePage[] {
  if (!role) return [];
  const tabs = new Set<string>(tabsFor(role).map((t) => t.key));
  const client = isClientRole(role);
  const L: MorePage[] = CANDIDATES.filter((c) => can(role, c.page) && !(c.tab && tabs.has(c.tab)) && !(client && c.key === 'clients')).map((c) =>
    client && c.key === 'users'
      ? { key: c.key, label: 'Your team', icon: 'users', sub: 'Your colleagues in the portal' }
      : { key: c.key, label: c.label, icon: c.icon, sub: c.sub },
  );
  if (!client) L.push({ key: 'leave', label: 'Leave', icon: 'calendar-plus', sub: 'Your balance and requests' });
  return L;
}
