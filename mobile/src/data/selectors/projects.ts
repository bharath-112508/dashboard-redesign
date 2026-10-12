import { CLIENT_COMPANY, SPRINTS } from '../seed/projects';
import { EMPTY_MAINTENANCE } from '../seed/maintenance';
import type { AppState } from '../store/state';
import type { Company, MaintData, Project, Sprint } from '../types';
import { me } from './session';
import { myTickets } from './tickets';

export function projectByName(s: AppState, name: string): Project | undefined {
  return s.projects.find((p) => p.name === name);
}

/** Company name of a project ('' when unknown). */
export function companyOf(s: AppState, project: string): string {
  return projectByName(s, project)?.company ?? '';
}

export function companyByName(s: AppState, name: string): Company | undefined {
  return s.companies.find((c) => c.name === name);
}

export function projectsOfCompany(s: AppState, company: string): Project[] {
  return s.projects.filter((p) => p.company === company);
}

/** Maintenance data of a project (empty data for a project moved to maintenance in-app). */
export function maintenanceOf(s: AppState, project: string): MaintData {
  return s.maintenance[project] ?? EMPTY_MAINTENANCE;
}

/**
 * Projects the signed-in person can see (SPEC §2.1 "Projects list"):
 * client → their company; dev/free → projects with my tickets plus maintenance projects
 * where I own a request or upkeep task; everyone else → all.
 */
export function visibleProjects(s: AppState): Project[] {
  const person = me(s);
  const role = person?.role;
  if (!person || !role) return [];
  if (role === 'client') return s.projects.filter((p) => p.company === CLIENT_COMPANY);
  if (role === 'dev' || role === 'free') {
    const mine = myTickets(s);
    return s.projects.filter((p) => {
      if (mine.some((t) => t.proj === p.name)) return true;
      const m = s.maintenance[p.name];
      return !!m && (m.req.some((r) => r.as === person.name) || m.tasks.some((t) => t.who === person.name));
    });
  }
  return s.projects;
}

/** "Active" in the Projects filter means active or planned. */
export const isActiveOrPlanned = (p: Project) => p.status === 'active' || p.status === 'planned';

/** Visible projects grouped by company, in company order. */
export function groupByCompany(s: AppState, projects: Project[]): { company: string; projects: Project[] }[] {
  return s.companies
    .map((c) => ({ company: c.name, projects: projects.filter((p) => p.company === c.name) }))
    .filter((g) => g.projects.length);
}

/** Active project count and the companies they span (Home KPI, More tile). */
export function activeProjectStats(s: AppState): { count: number; companies: number } {
  const act = visibleProjects(s).filter(isActiveOrPlanned);
  return { count: act.length, companies: new Set(act.map((p) => p.company)).size };
}

export function sprintsOf(project: string): Sprint[] {
  return SPRINTS.filter((x) => x.p === project);
}

/** Distinct epic names of a project, in sprint order. */
export function epicsOf(project: string): string[] {
  return [...new Set(sprintsOf(project).map((x) => x.e))];
}

/** The active (non-Ops) sprint of a project, if any. */
export function activeSprint(project: string): Sprint | undefined {
  return SPRINTS.find((x) => x.p === project && x.st === 'active' && x.n !== 'Ops');
}
