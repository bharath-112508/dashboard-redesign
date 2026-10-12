import { TODAY } from '../clock';
import type { AppState } from '../store/state';
import type { DevopsProject, DevopsRequest } from '../types';
import { project, type ProjectView } from './projects';

/**
 * A DevOps record seen through its project (DECISIONS 3): the title is the project
 * name, the tile is the project's (company logo, or the internal tile), the company is
 * secondary text. There is no "Client · Project" label anywhere.
 */
export interface DevopsView extends DevopsProject {
  project: ProjectView | null;
  /** project name (title everywhere) */
  name: string;
  /** company name, or "Viljetech" for internal projects (secondary meta only) */
  company: string;
  /** open requests on this record */
  openRequests: number;
}

function view(s: AppState, d: DevopsProject): DevopsView {
  const p = project(s, d.projectId);
  return {
    ...d,
    project: p,
    name: p?.name ?? d.key,
    company: p?.co ?? '',
    openRequests: s.devopsRequests.filter((r) => r.key === d.key && r.status !== 'Done').length,
  };
}

/** Every DevOps record with its project view (`dvAll`). */
export function devopsAll(s: AppState): DevopsView[] {
  return s.devops.map((d) => view(s, d));
}

export function devopsByKey(s: AppState, key: string | null | undefined): DevopsView | null {
  const d = key ? s.devops.find((x) => x.key === key) : undefined;
  return d ? view(s, d) : null;
}

/** The DevOps record of a project (`dvFor`), looked up by projectId only. */
export function devopsFor(s: AppState, projectId: string): DevopsView | null {
  const d = s.devops.find((x) => x.projectId === projectId);
  return d ? view(s, d) : null;
}

/**
 * Projects the "New project" DevOps picker offers (SH-DVNEW): client and internal
 * projects that are not completed and have no DevOps record yet.
 */
export function devopsPickerProjects(s: AppState): ProjectView[] {
  const linked = new Set(s.devops.map((d) => d.projectId));
  return s.projects
    .filter((p) => p.state !== 'done' && !linked.has(p.id))
    .map((p) => project(s, p.id))
    .filter((p): p is ProjectView => !!p && (p.kind === 'internal' || !s.companies.find((c) => c.id === p.coId)?.archived));
}

/** Overdue follow-up: the stored flag, or a reminder before TODAY. */
export const isDevopsOverdue = (d: Pick<DevopsProject, 'overdue' | 'reminder'>): boolean =>
  d.overdue || (!!d.reminder && d.reminder.slice(0, 10) < TODAY);

export function requestsFor(s: AppState, key: string): DevopsRequest[] {
  return s.devopsRequests.filter((r) => r.key === key);
}

export function openRequests(s: AppState): DevopsRequest[] {
  return s.devopsRequests.filter((r) => r.status !== 'Done');
}

export function request(s: AppState, id: number | string | null | undefined): DevopsRequest | null {
  return s.devopsRequests.find((r) => String(r.id) === String(id)) ?? null;
}

/** The project name of a request (derived, never stored). */
export function requestProjectName(s: AppState, r: DevopsRequest): string {
  return devopsByKey(s, r.key)?.name ?? r.key;
}

/** Next DevOps key: OPS-(100 + count + 1). */
export function nextDevopsKey(s: AppState): string {
  const used = new Set(s.devops.map((d) => d.key));
  let n = 100 + s.devops.length + 1;
  while (used.has(`OPS-${n}`)) n++;
  return `OPS-${n}`;
}
