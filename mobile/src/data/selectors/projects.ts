import type { AppState } from '../store/state';
import type { Company, Epic, Project, Sprint, Ticket } from '../types';
import { isClientRole, me } from './session';

/** A project with its company resolved (v5 `projAll` adds `co`, `coId`). */
export interface ProjectView extends Project {
  /** company name, or "Viljetech" for internal projects */
  co: string;
  /** company id, or 'vt' */
  coId: string;
}

function view(s: AppState, p: Project): ProjectView {
  if (p.kind === 'internal') return { ...p, co: 'Viljetech', coId: 'vt' };
  const c = s.companies.find((x) => x.id === p.companyId);
  return { ...p, co: c?.name ?? '', coId: c?.id ?? p.companyId ?? '' };
}

/** Every project of a non-archived company, then internal projects (`projAll`). */
export function projAll(s: AppState): ProjectView[] {
  const live = new Set(s.companies.filter((c) => !c.archived).map((c) => c.id));
  const client = s.projects.filter((p) => p.kind === 'client' && live.has(p.companyId ?? ''));
  const internal = s.projects.filter((p) => p.kind === 'internal');
  return [...client, ...internal].map((p) => view(s, p));
}

/** One project by id (also archived companies' projects), or null. */
export function project(s: AppState, id: string | null | undefined): ProjectView | null {
  const p = id ? s.projects.find((x) => x.id === id) : undefined;
  return p ? view(s, p) : null;
}

export function company(s: AppState, id: string | null | undefined): Company | null {
  return (id && s.companies.find((c) => c.id === id)) || null;
}

/** "Daco · Daco platform" for client projects, the name for internal ones. */
export function projectTitle(p: Pick<ProjectView, 'kind' | 'co' | 'name'>): string {
  return p.kind === 'client' ? `${p.co} · ${p.name}` : p.name;
}

/**
 * Projects the signed-in person can see (`projVis`, SPEC §2.4): super/admin/pm all; dev
 * their `projects` list plus teams they are on; cadmin their company; cuser their
 * company's projects in their list; devops none.
 */
export function projVis(s: AppState): ProjectView[] {
  const u = me(s);
  if (!u) return [];
  const all = projAll(s);
  switch (u.role) {
    case 'super':
    case 'admin':
    case 'pm':
      return all;
    case 'dev':
      return u.projects === 'all' ? all : all.filter((p) => u.projects.includes(p.id) || p.team.includes(u.name));
    case 'cadmin':
      return all.filter((p) => p.coId === u.org);
    case 'cuser':
      return all.filter((p) => p.coId === u.org && (u.projects === 'all' || u.projects.includes(p.id)));
    default:
      return [];
  }
}

/** True when the signed-in person can see the project. */
export const canSeeProject = (s: AppState, id: string): boolean => projVis(s).some((p) => p.id === id);

/** A company's projects (client projects only). */
export function projectsOfCompany(s: AppState, companyId: string): ProjectView[] {
  return s.projects.filter((p) => p.kind === 'client' && p.companyId === companyId).map((p) => view(s, p));
}

/**
 * Epics of a project (`epics(pid)`). A project without epics gets one pseudo-epic with
 * the project's id and name; new epics replace it (SH-NEWEPIC).
 */
export function epicsOf(s: AppState, projectId: string): Epic[] {
  const L = s.epics.filter((e) => e.projectId === projectId);
  if (L.length) return L;
  const p = s.projects.find((x) => x.id === projectId);
  if (!p) return [];
  return [{ id: p.id, projectId: p.id, name: p.name, state: p.state, pct: p.pct, sprints: s.sprints.filter((x) => x.epicId === p.id).length }];
}

/** Epic name by id (pseudo-epics resolve to the project name). */
export function epicName(s: AppState, id: string | null | undefined): string {
  if (!id) return '';
  return s.epics.find((e) => e.id === id)?.name ?? s.projects.find((p) => p.id === id)?.name ?? '';
}

/** The project an epic (or pseudo-epic) belongs to. */
export function projectOfEpic(s: AppState, epicId: string): string | null {
  return s.epics.find((e) => e.id === epicId)?.projectId ?? (s.projects.some((p) => p.id === epicId) ? epicId : null);
}

export function sprint(s: AppState, id: string | null | undefined): Sprint | null {
  return (id && s.sprints.find((x) => x.id === id)) || null;
}

/** Sprints of an epic, in start order. */
export function sprintsOf(s: AppState, epicId: string): Sprint[] {
  return s.sprints.filter((x) => x.epicId === epicId).sort((a, b) => a.start.localeCompare(b.start));
}

/** The active sprint of an epic (A-12: at most one). */
export function activeSprintOf(s: AppState, epicId: string): Sprint | null {
  return s.sprints.find((x) => x.epicId === epicId && x.state === 'active') ?? null;
}

/** Tickets of a project. */
export function ticketsOf(s: AppState, projectId: string): Ticket[] {
  return s.tickets.filter((t) => t.projectId === projectId);
}

/**
 * Log-time project options (`projOpts`): non-done client projects as "Company · Project",
 * then non-done internal projects, then "Admin & meetings". Values: c:/i:/x:admin.
 */
export function projOpts(s: AppState): { value: string; label: string }[] {
  const all = projAll(s).filter((p) => p.state !== 'done');
  return [
    ...all.filter((p) => p.kind === 'client').map((p) => ({ value: `c:${p.id}`, label: `${p.co} · ${p.name}` })),
    ...all.filter((p) => p.kind === 'internal').map((p) => ({ value: `i:${p.id}`, label: p.name })),
    { value: 'x:admin', label: 'Admin & meetings' },
  ];
}

/** Label of a time-entry project value (`projLabel`). */
export function projLabel(s: AppState, v: string): string {
  if (v === 'x:admin') return 'Admin & meetings';
  const p = project(s, v.slice(2));
  return p ? projectTitle(p) : v;
}

/** The time-entry project value of a project ("c:dacop" / "i:i1"). */
export const projValue = (p: Pick<Project, 'id' | 'kind'>): string => `${p.kind === 'client' ? 'c' : 'i'}:${p.id}`;

/** Whether a client role is looking (portal variants of project screens). */
export const viewerIsClient = (s: AppState): boolean => isClientRole(me(s)?.role);
