/**
 * Pure view-model helpers for S5-PROJECTS and S5-PROJECT (W2). Everything here is a
 * function of AppState (or plain data) so it can be unit tested without React.
 */
import { TODAY } from '@/data/clock';
import { addD, diff, fmt } from '@/data/format';
import { entriesAll, epicsOf, isLate, loggedMin, projVis, sprintsOf, ticketsOf, type ProjectView } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Project, ProjectState, Sprint, Ticket, TicketStatus, TimeEntry } from '@/data/types';
import type { ProjectTab } from '@/nav/routes';

// ── Projects list (V-40) ─────────────────────────────────────────────────────

export type KindFilter = 'all' | 'client' | 'internal';
export type StateFilter = 'all' | ProjectState;

export interface ProjectFilters {
  q: string;
  kind: KindFilter;
  st: StateFilter;
}

/** Search matches name, company and area. */
export function filterProjects(L: ProjectView[], f: ProjectFilters): ProjectView[] {
  const q = f.q.trim().toLowerCase();
  return L.filter(
    (p) =>
      (f.kind === 'all' || p.kind === f.kind) &&
      (f.st === 'all' || p.state === f.st) &&
      (!q || `${p.name} ${p.kind === 'client' ? p.co : ''} ${p.area ?? ''}`.toLowerCase().includes(q)),
  );
}

/** Status chips with counts (over the visible projects); "On hold" only when any. */
export function stateChips(L: ProjectView[]): { value: StateFilter; label: string; count: number }[] {
  const n = (k: StateFilter) => L.filter((p) => k === 'all' || p.state === k).length;
  const chips: { value: StateFilter; label: string; count: number }[] = [
    { value: 'all', label: 'All', count: n('all') },
    { value: 'active', label: 'Active', count: n('active') },
    { value: 'planned', label: 'Planned', count: n('planned') },
    { value: 'maint', label: 'Maintenance', count: n('maint') },
    { value: 'hold', label: 'On hold', count: n('hold') },
    { value: 'done', label: 'Completed', count: n('done') },
  ];
  return chips.filter((c) => c.value !== 'hold' || c.count > 0);
}

/** Row sub: company or "Internal · area", plus " · Support until 30 Aug" for maintenance. */
export function projectRowSub(p: ProjectView): string {
  const base = p.kind === 'client' ? p.co : `Internal · ${p.area || 'Viljetech'}`;
  return base + (p.state === 'maint' && p.sup ? ` · Support until ${fmt(p.sup.until)}` : '');
}

/** Deadline meta: null for maintenance or no due; late when not done and due < TODAY. */
export function deadlineMeta(p: Pick<Project, 'due' | 'state'>): { text: string; late: boolean } | null {
  if (!p.due || p.state === 'maint') return null;
  const late = p.state !== 'done' && p.due < TODAY;
  return { text: late ? `Deadline passed ${fmt(p.due)}` : `Deadline ${fmt(p.due)}`, late };
}

export const visibleProjects = projVis;

// ── Project tabs (V-43) ─────────────────────────────────────────────────────

export const TAB_LABEL: Record<ProjectTab, string> = {
  overview: 'Overview',
  support: 'Support',
  board: 'Board',
  list: 'List',
  sprints: 'Epics & sprints',
  timeline: 'Timeline',
  files: 'Files',
  time: 'Time',
  team: 'Team',
  devops: 'DevOps',
  questions: 'Questions',
  bugs: 'Bugs',
};

/** Tab set by viewer and state; maintenance inserts Support after Overview. */
export function projectTabs(p: Pick<Project, 'state'>, client: boolean): ProjectTab[] {
  const T: ProjectTab[] = client
    ? ['overview', 'board', 'timeline', 'questions', 'bugs', 'files']
    : ['overview', 'board', 'list', 'sprints', 'timeline', 'files', 'time', 'team', 'devops', 'questions'];
  if (p.state === 'maint') T.splice(1, 0, 'support');
  return T;
}

/** Default tab: Support for maintenance, otherwise Overview; an unknown `?tab=` falls back. */
export function initialTab(p: Pick<Project, 'state'>, client: boolean, requested?: string): ProjectTab {
  const T = projectTabs(p, client);
  if (requested && (T as string[]).includes(requested)) return requested as ProjectTab;
  return p.state === 'maint' ? 'support' : 'overview';
}

/** The "+" Create ticket header action shows on these tabs only. */
export const CREATE_TABS: readonly ProjectTab[] = ['overview', 'board', 'list', 'sprints'];

// ── Overview ────────────────────────────────────────────────────────────────

export interface OverviewData {
  open: number;
  done: number;
  late: Ticket[];
  critical: Ticket[];
  loggedMin: number;
  /** overdue ∪ critical, open */
  attention: Ticket[];
  over: { ticket: Ticket; min: number }[];
  missed: (Sprint & { epicName: string })[];
  byPerson: { who: string; min: number }[];
  activity: { key: string; who: string; t: string; when: string }[];
  epics: { id: string; name: string; done: number; total: number; caption: string }[];
}

/** Project time entries (c:/i: value of the project), newest first. */
export function projectEntries(s: AppState, p: Pick<Project, 'id' | 'kind'>): TimeEntry[] {
  const v = `${p.kind === 'client' ? 'c' : 'i'}:${p.id}`;
  return entriesAll(s)
    .filter((e) => e.proj === v)
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
}

/** Minutes per person, most first. */
export function minutesByPerson(L: TimeEntry[]): { who: string; min: number }[] {
  const by = new Map<string, number>();
  for (const e of L) by.set(e.who, (by.get(e.who) ?? 0) + e.min);
  return [...by.entries()].map(([who, min]) => ({ who, min })).sort((a, b) => b.min - a.min);
}

export function overview(s: AppState, p: ProjectView): OverviewData {
  const T = ticketsOf(s, p.id);
  const openT = T.filter((t) => t.st !== 'done');
  const late = openT.filter((t) => isLate(t));
  const critical = openT.filter((t) => t.prio === 'Critical');
  const attention = [...new Set([...late, ...critical])];
  const logged = T.reduce((a, t) => a + loggedMin(s, t.key), 0);
  const over = T.filter((t) => t.est > 0)
    .map((t) => ({ ticket: t, min: loggedMin(s, t.key) }))
    .filter((x) => x.min / 60 > x.ticket.est);
  const E = epicsOf(s, p.id);
  const missed = E.flatMap((e) => sprintsOf(s, e.id).map((x) => ({ ...x, epicName: e.name }))).filter((x) => x.state !== 'done' && x.end < TODAY);
  const activity = T.flatMap((t) => t.comments.map((c) => ({ key: t.key, who: c.who, t: c.t, when: c.when }))).slice(0, 5);
  const epics = E.map((e) => {
    const et = T.filter((t) => t.epicId === e.id);
    const d = et.filter((t) => t.st === 'done').length;
    const sp = sprintsOf(s, e.id).find((x) => x.state === 'active');
    return { id: e.id, name: e.name, done: d, total: et.length, caption: `${d} of ${et.length} tasks done${sp ? ` · ${sp.name} ends ${fmt(sp.end)}` : ''}` };
  });
  return {
    open: openT.length,
    done: T.length - openT.length,
    late,
    critical,
    loggedMin: logged,
    attention,
    over,
    missed,
    byPerson: minutesByPerson(projectEntries(s, p)),
    activity,
    epics,
  };
}

// ── Board (V-44) and List (V-45) ────────────────────────────────────────────

export type SprintFilter = 'active' | 'all' | 'backlog';

/**
 * Board tickets: the epic filter, then (staff) Active sprint = tickets in an active sprint
 * plus support tickets with no sprint; Backlog = no sprint. Clients see every ticket of the epic.
 */
export function boardTickets(s: AppState, projectId: string, epic: string, spr: SprintFilter, client: boolean): Ticket[] {
  const L = ticketsOf(s, projectId).filter((t) => epic === 'all' || t.epicId === epic);
  if (client || spr === 'all') return L;
  if (spr === 'backlog') return L.filter((t) => !t.sprintId);
  const active = new Set(s.sprints.filter((x) => x.state === 'active').map((x) => x.id));
  return L.filter((t) => (t.sprintId && active.has(t.sprintId)) || (!t.sprintId && !!t.support));
}

export type ListFilter = 'open' | 'late' | TicketStatus | 'all';

export function matchesList(t: Ticket, f: ListFilter): boolean {
  if (f === 'open') return t.st !== 'done';
  if (f === 'late') return isLate(t);
  if (f === 'all') return true;
  return t.st === f;
}

export function listTickets(L: Ticket[], f: ListFilter, q: string): Ticket[] {
  const s = q.trim().toLowerCase();
  return L.filter((t) => matchesList(t, f) && (!s || `${t.key} ${t.title}`.toLowerCase().includes(s)));
}

export const LIST_CHIPS: { value: ListFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'late', label: 'Overdue' },
  { value: 'todo', label: 'To do' },
  { value: 'prog', label: 'In progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' },
  { value: 'all', label: 'All' },
];

// ── Timeline (Gantt) ────────────────────────────────────────────────────────

export interface GanttRange {
  ticks: string[];
  /** % position of an ISO day in the range, clamped 0–100 */
  pos: (d: string) => number;
  now: number;
}

/**
 * The shared range of the sprint and task Gantts: every sprint and dated task (a task
 * starts at `start`, or 3 days before due), padded by 2 days; 4 ticks. null = no dates.
 */
export function ganttRange(spans: [string, string][]): GanttRange | null {
  if (!spans.length) return null;
  let a0 = spans.reduce((m, x) => (x[0] < m ? x[0] : m), spans[0][0]);
  let a1 = spans.reduce((m, x) => (x[1] > m ? x[1] : m), spans[0][1]);
  a0 = addD(a0, -2);
  a1 = addD(a1, 2);
  const span = Math.max(1, diff(a1, a0));
  const pos = (d: string) => Math.max(0, Math.min(100, (diff(d, a0) / span) * 100));
  const ticks = [0, 1, 2, 3].map((i) => fmt(addD(a0, Math.round((span * i) / 3))));
  return { ticks, pos, now: pos(TODAY) };
}

/** Task bar start: `start`, or 3 days before due. */
export const taskStart = (t: Pick<Ticket, 'start' | 'due'>): string => t.start || addD(t.due!, -3);

/** Sprint and dated-task spans of a project. */
export function projectSpans(s: AppState, projectId: string): { sprints: (Sprint & { epicName: string })[]; tasks: Ticket[]; spans: [string, string][] } {
  const sprints = epicsOf(s, projectId).flatMap((e) => sprintsOf(s, e.id).map((x) => ({ ...x, epicName: e.name })));
  const tasks = ticketsOf(s, projectId)
    .filter((t) => !!t.due)
    .sort((a, b) => (a.due! < b.due! ? -1 : 1));
  const spans: [string, string][] = [...sprints.map((x): [string, string] => [x.start, x.end]), ...tasks.map((t): [string, string] => [taskStart(t), t.due!])];
  return { sprints, tasks, spans };
}

// ── Files ───────────────────────────────────────────────────────────────────

export interface FileRow {
  n: string;
  size: string;
  when: string;
  /** ticket key, '' for a project file */
  tk: string;
}

export function projectFiles(s: AppState, projectId: string): FileRow[] {
  return [
    ...(s.files[projectId] ?? []).map((f) => ({ n: f.n, size: f.size, when: f.when, tk: '' })),
    ...ticketsOf(s, projectId).flatMap((t) => t.att.map((f) => ({ n: f.n, size: f.size, when: f.when, tk: t.key }))),
  ];
}

export const isImageName = (n: string): boolean => /\.(png|jpe?g|svg|gif)$/i.test(n);

// ── Sprints ─────────────────────────────────────────────────────────────────

/** Default start of a new sprint: the day after the last sprint's end (or TODAY). */
export function nextSprintStart(s: AppState, epicId: string): string {
  const last = s.sprints.filter((x) => x.epicId === epicId).reduce((m, x) => (x.end > m ? x.end : m), TODAY);
  return addD(last, 1);
}

/** Tickets of a sprint and how many are done. */
export function sprintTickets(s: AppState, sprintId: string): { tickets: Ticket[]; done: number } {
  const tickets = s.tickets.filter((t) => t.sprintId === sprintId);
  return { tickets, done: tickets.filter((t) => t.st === 'done').length };
}
