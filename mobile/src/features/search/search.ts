/**
 * S5-SEARCH (V-06): grouped results, each group only when the role may open it (SPEC
 * §4) and non-empty. DevOps results show the linked project's name (SPEC §2.6). Pure.
 */
import type { IconName } from '@/components/icons';
import { can, devopsAll, projVis, type DevopsView, type ProjectView } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Company, Person, Role, Ticket } from '@/data/types';
import { morePages } from '@/nav/morePages';
import type { PageKey } from '@/nav/routes';
import { tabsFor, type TabKey } from '@/nav/tabs';

export interface PageHit {
  key: PageKey;
  label: string;
  icon: IconName;
}

export interface SearchResults {
  pages: PageHit[];
  tickets: Ticket[];
  projects: ProjectView[];
  devops: DevopsView[];
  companies: Company[];
  people: Person[];
}

const TAB_PAGE: Record<TabKey, { key: PageKey; label: string }> = {
  home: { key: 'dash', label: 'Dashboard' },
  projects: { key: 'projects', label: 'Projects' },
  tickets: { key: 'mytickets', label: 'My tickets' },
  time: { key: 'time', label: 'Timesheet' },
  devops: { key: 'devops', label: 'DevOps board' },
  questions: { key: 'questions', label: 'Questions' },
  bugs: { key: 'bugs', label: 'Bugs' },
  more: { key: 'more', label: 'More' },
};

/** Search pages, tickets, projects, DevOps, companies and people for `q`. */
export function searchAll(s: AppState, role: Role | null | undefined, query: string): SearchResults {
  const q = query.trim().toLowerCase();
  const empty: SearchResults = { pages: [], tickets: [], projects: [], devops: [], companies: [], people: [] };
  if (!q || !role) return empty;
  const has = (...parts: (string | undefined)[]) => parts.join(' ').toLowerCase().includes(q);
  const pages: PageHit[] = [
    ...morePages(role).map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
    ...tabsFor(role).map((t) => ({ key: TAB_PAGE[t.key].key, label: TAB_PAGE[t.key].label, icon: t.icon })),
  ].filter((p) => has(p.label));
  return {
    pages: pages.slice(0, 5),
    tickets: can(role, 'Tickets') ? s.tickets.filter((t) => has(t.key, t.title)).slice(0, 6) : [],
    projects: can(role, 'Projects') ? projVis(s).filter((p) => has(p.name, p.co)).slice(0, 6) : [],
    devops: can(role, 'DevOps Board v6') ? devopsAll(s).filter((d) => has(d.name, d.key, d.company)).slice(0, 6) : [],
    companies: can(role, 'Companies') ? s.companies.filter((c) => has(c.name)).slice(0, 6) : [],
    people: can(role, 'Users') ? s.people.filter((p) => has(p.name, p.email)).slice(0, 6) : [],
  };
}

/** Total hits (0 → "No results for “q”"). */
export const hitCount = (r: SearchResults): number =>
  r.pages.length + r.tickets.length + r.projects.length + r.devops.length + r.companies.length + r.people.length;
