/**
 * Feature selectors for S-PROJECTS and S-PROJECT (list, board, files, overview).
 * Timeline and epics tree live in timeline.ts and epicsTree.ts.
 */
import { CLIENT_COMPANY } from '@/data/seed/projects';
import { TICKET_STATUS, TICKET_STATUS_ORDER } from '@/data/constants';
import { hm, plural, sh, shY } from '@/data/format';
import { activeSprint, byDue, epicsOf, groupByCompany, isActiveOrPlanned, maintenanceOf, myRole, projectByName, sprintsOf, visibleProjects } from '@/data/selectors';
import type { AppState, ProjectFilter, ProjectView } from '@/data/store';
import type { Project, Ticket, TicketStatus } from '@/data/types';

/** Epics that hold internal work only; their tickets and sprints are hidden from clients. */
export const INTERNAL_EPICS: readonly string[] = ['Infra'];

/** Can the signed-in person open this project? Clients only see their company's projects (DECISIONS 9). */
export function canSeeProject(s: AppState, project: string): boolean {
  const p = projectByName(s, project);
  if (!p) return false;
  if (myRole(s) === 'client') return p.company === CLIENT_COMPANY;
  return true;
}

/**
 * Tickets of a project in the project views. Clients see only tickets of their company's
 * projects and never internal-only work (DECISIONS 9).
 */
export function projectTickets(s: AppState, project: string): Ticket[] {
  if (!canSeeProject(s, project)) return [];
  const client = myRole(s) === 'client';
  return s.tickets.filter((t) => t.proj === project && !(client && INTERNAL_EPICS.includes(t.epic)));
}

/** Epic names shown for a project (clients: no internal epics). */
export function projectEpics(s: AppState, project: string): string[] {
  const client = myRole(s) === 'client';
  return epicsOf(project).filter((e) => !(client && INTERNAL_EPICS.includes(e)));
}

export function projectSprints(s: AppState, project: string) {
  const client = myRole(s) === 'client';
  return sprintsOf(project).filter((x) => !(client && INTERNAL_EPICS.includes(x.e)));
}

// ── Projects tab ────────────────────────────────────────────────────────────

const inFilter = (p: Project, f: ProjectFilter) => (f === 'active' ? isActiveOrPlanned(p) : p.status === f);

export interface ProjectCardVM {
  name: string;
  status: Project['status'];
  meta: string;
  pct: number;
  showBar: boolean;
  support: { until: string; hours: string; pct: number; hasHours: boolean } | null;
}

function cardOf(s: AppState, p: Project): ProjectCardVM {
  const eps = projectEpics(s, p.name).length;
  const act = activeSprint(p.name);
  const meta =
    p.status === 'done'
      ? `Completed ${shY(p.deliv ?? '')}`.trim()
      : p.status === 'maint'
        ? `Live since ${shY(p.plan?.start ?? p.deliv ?? '')}`.trim()
        : eps
          ? `${plural(eps, 'epic')}${act ? ` · ${act.e} ${act.n} ends ${sh(act.b)}` : ''}`
          : 'Starting soon';
  let support: ProjectCardVM['support'] = null;
  if (p.status === 'maint') {
    const until = p.sup?.until ?? p.plan?.renew;
    const hist = maintenanceOf(s, p.name).hist;
    const used = p.sup?.used ?? (hist.length ? hist[hist.length - 1][1] : 0);
    const quota = p.sup?.quota ?? p.plan?.hours ?? 0;
    if (until) {
      support = {
        until: `Support until ${shY(until)}`,
        hours: quota ? `${hm(used)} of ${quota}h support used this month` : 'No support hours agreed',
        pct: quota ? Math.min(100, (used / quota) * 100) : 0,
        hasHours: quota > 0,
      };
    }
  }
  return { name: p.name, status: p.status, meta, pct: p.pct, showBar: p.status === 'active' || p.status === 'planned', support };
}

export interface ProjectsTabVM {
  filter: ProjectFilter;
  counts: Record<ProjectFilter, number>;
  groups: { company: string; projects: ProjectCardVM[] }[];
}

export function projectsTab(s: AppState): ProjectsTabVM {
  const vis = visibleProjects(s);
  const filter = s.ui.projectFilter;
  const counts = {
    active: vis.filter((p) => inFilter(p, 'active')).length,
    maint: vis.filter((p) => inFilter(p, 'maint')).length,
    done: vis.filter((p) => inFilter(p, 'done')).length,
  };
  const groups = groupByCompany(s, vis.filter((p) => inFilter(p, filter))).map((g) => ({
    company: g.company,
    projects: g.projects.map((p) => cardOf(s, p)),
  }));
  return { filter, counts, groups };
}

// ── Project detail ──────────────────────────────────────────────────────────

export const BUILD_VIEWS: readonly ProjectView[] = ['list', 'board', 'tree', 'tl', 'files'];
export const MAINT_VIEWS: readonly ProjectView[] = ['sup', 'rep', 'list', 'board', 'files'];

/** The view to show: the one remembered for this project when it fits, else the default. */
export function currentView(s: AppState, project: string, isMaint: boolean): ProjectView {
  const v = s.ui.projectView[project];
  const allowed = isMaint ? MAINT_VIEWS : BUILD_VIEWS;
  if (v && allowed.includes(v)) return v;
  return isMaint ? 'sup' : 'list';
}

export interface StatusGroup {
  status: TicketStatus;
  label: string;
  dot: string;
  tickets: Ticket[];
}

/** Tickets grouped by status, sorted by due date (client labels for clients). */
export function statusGroups(s: AppState, project: string): StatusGroup[] {
  const client = myRole(s) === 'client';
  const ts = projectTickets(s, project);
  return TICKET_STATUS_ORDER.map((st) => ({
    status: st,
    label: client ? TICKET_STATUS[st].client : TICKET_STATUS[st].label,
    dot: TICKET_STATUS[st].dot,
    tickets: ts.filter((t) => t.st === st).sort(byDue),
  }));
}

export interface FileVM {
  name: string;
  icon: 'file-text' | 'image';
  sub: string;
  ticketId: number;
}

export function projectFiles(s: AppState, project: string): FileVM[] {
  return projectTickets(s, project).flatMap((t) =>
    (t.att ?? []).map((n) => ({ name: n, icon: /\.pdf$/i.test(n) ? ('file-text' as const) : ('image' as const), sub: `${t.key} · ${t.title}`, ticketId: t.id })),
  );
}

/** "2 epics · 5 sprints · 7 tickets" or "No epics yet". */
export function overviewMeta(s: AppState, project: string): string {
  const eps = projectEpics(s, project).length;
  if (!eps) return 'No epics yet';
  return `${plural(eps, 'epic')} · ${plural(projectSprints(s, project).length, 'sprint')} · ${plural(projectTickets(s, project).length, 'ticket')}`;
}
