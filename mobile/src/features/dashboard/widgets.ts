/**
 * S5-DASH: one dashboard config per role (D-ROLE-6). Every KPI and widget is computed
 * from the store and TODAY (A-1, DECISIONS 6); only the numbers the app has no data for
 * come from `seed/dashboardDemo.ts` (hours sold per project, monthly capacity). Pure:
 * the screen maps `Target`s to navigation.
 */
import { TODAY, WEEK_MONDAY } from '@/data/clock';
import { LEAVE_KINDS, TICKET_STATUS, devopsTone } from '@/data/constants';
import { addD, diff, fmt, fmtL, fmtRange, hm, plural } from '@/data/format';
import { BUDGET_HOURS, MONTH_CAPACITY_H } from '@/data/seed/dashboardDemo';
import {
  activeSprintOf,
  devopsAll,
  devopsFor,
  dueInfo,
  entriesAll,
  entriesBetween,
  epicName,
  epicsOf,
  isClientRole,
  isFreelancer,
  isLate,
  loggedMin,
  me,
  openQuestions,
  openRequests,
  project,
  projVis,
  projectTitle,
  requestProjectName,
  sprint,
  visibleBugs,
  weekBars,
  type DayBar,
  type DevopsView,
} from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Leave, Person, Role, Sprint, Ticket } from '@/data/types';
import type { PageKey } from '@/nav/routes';
import { DASH_SCOPE } from '@/nav/titles';
import { colors, type ToneName } from '@/theme/colors';

// ── View model ─────────────────────────────────────────────────────────────

/** Where a tap leads: a page (`tab2`) or a record. */
export type Target =
  | { page: PageKey }
  | { ticket: string }
  | { project: string }
  | { question: number }
  | { bug: string }
  | { request: number }
  | { dvp: string };

export interface DashKpi {
  label: string;
  value: string;
  of?: string;
  sub: string;
  dot: string;
  color?: string;
  go: Target;
}

export interface ProgItem {
  title: string;
  used: number;
  of: number;
  caption: string;
  value?: string;
  color?: string;
  go?: Target;
}

export interface ListItem {
  badge: { label: string; tone: ToneName };
  title: string;
  sub: string;
  right?: string;
  rightColor?: string;
  go?: Target;
}

export interface StepItem {
  title: string;
  status: string;
  tone: ToneName;
  steps: ('done' | 'current' | 'future')[];
  go?: Target;
}

interface WBase {
  id: string;
  title: string;
  sub: string;
  /** link chip text (without the ›) */
  link: string;
  go: Target;
}

export type Widget =
  | (WBase & { k: 'prog'; items: ProgItem[]; empty: string })
  | (WBase & { k: 'list'; items: ListItem[]; empty: string })
  | (WBase & { k: 'bars'; days: DayBar[]; idle: boolean; foot: string })
  | (WBase & { k: 'status'; items: StepItem[]; empty: string })
  | (WBase & { k: 'tix'; keys: string[]; empty: string });

export interface Dashboard {
  role: Role;
  scope: string;
  kpis: DashKpi[];
  widgets: Widget[];
}


// ── Helpers (exported for tests) ───────────────────────────────────────────

const page = (p: PageKey): Target => ({ page: p });
const GREEN = colors.green;
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
const h = (min: number) => Math.round(min / 60);
/** "342h" / "26h 45m" */
const hours = (min: number) => hm(min);

/** ISO weekdays (Mon–Fri) from a to b inclusive. */
export function weekdays(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a; d <= b; d = addD(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) out.push(d);
  }
  return out;
}

/** "20–22 Oct", "8 Oct", "30 Sep – 2 Oct". */
export function dayRange(from: string, to: string): string {
  if (from === to) return fmt(from);
  if (from.slice(0, 7) === to.slice(0, 7)) return `${+from.slice(8, 10)}–${fmt(to)}`;
  return fmtRange(from, to);
}

/** "8 days left", "ends tomorrow", "ends today", "ended". */
export function sprintLeft(sp: Pick<Sprint, 'end'>): string {
  const d = diff(sp.end, TODAY);
  if (d < 0) return 'ended';
  if (d === 0) return 'ends today';
  if (d === 1) return 'ends tomorrow';
  return `${d} days left`;
}

const leaveLabel = (l: Leave) => LEAVE_KINDS.find((k) => k.kind === l.kind)?.label ?? l.kind;

/** Staff who log time against a target (no freelancers, no clients). */
function employees(s: AppState): Person[] {
  return s.people.filter((p) => p.org === 'vt' && p.active && !isFreelancer(p));
}

/** Idle minutes of one person over some weekdays (8h a day minus what they logged). */
function idleOf(s: AppState, who: string, days: string[]): number {
  const L = entriesBetween(s, days[0] ?? TODAY, days[days.length - 1] ?? TODAY, who);
  return days.reduce((a, d) => a + Math.max(0, 480 - L.filter((e) => e.date === d).reduce((x, e) => x + e.min, 0)), 0);
}

/** People who logged time in a period (team views). */
function loggers(s: AppState, from: string, to: string): string[] {
  return [...new Set(entriesBetween(s, from, to).map((e) => e.who))];
}

/** DevOps step bars: client onboarding · tenant setup · first deployment · CI/CD. */
export function devopsSteps(d: Pick<DevopsView, 'infra' | 'cicd'>): StepItem['steps'] {
  const base: Record<string, number> = {
    'Not started': 0,
    'Client onboarding': 0,
    'Dev project deployment': 1,
    'Internally deployment': 2,
    'Prod product deployment': 2,
    'Deployment Completed': 3,
    'Adding new services': 3,
  };
  let done = base[d.infra] ?? 1;
  if (done === 3 && d.cicd) done = 4;
  return [0, 1, 2, 3].map((i) => (i < done ? 'done' : i === done ? 'current' : 'future'));
}

function stepItem(d: DevopsView): StepItem {
  return { title: d.name, status: d.infra, tone: devopsTone(d.infra), steps: devopsSteps(d), go: { dvp: d.key } };
}

function ticketListItem(s: AppState, t: Ticket, sub: string): ListItem {
  const due = dueInfo(t);
  return {
    badge: t.prio === 'Critical' ? { label: 'Critical', tone: 'red' } : { label: t.key, tone: 'blue' },
    title: t.prio === 'Critical' ? `${t.key} · ${t.title}` : t.title,
    sub,
    right: due.text,
    rightColor: due.color,
    go: { ticket: t.key },
  };
}

function questionItems(s: AppState, staffView: boolean, L = openQuestions(s)): ListItem[] {
  return L.map((q) => {
    const p = project(s, q.projectId);
    return {
      badge: { label: `Q-${q.id}`, tone: 'amber' as ToneName },
      title: q.title,
      sub: staffView ? `${p?.co ?? ''} · asked by ${q.by}` : `Asked by ${q.by}`,
      right: q.when,
      rightColor: colors.amberInk,
      go: { question: q.id },
    };
  });
}

function budgetItems(s: AppState, ids: string[], long: boolean): ProgItem[] {
  return ids
    .map((id) => project(s, id))
    .filter((p): p is NonNullable<typeof p> => !!p && p.kind === 'client' && p.state !== 'done' && !!BUDGET_HOURS[p.id])
    .map((p) => {
      const used = h(entriesAll(s).filter((e) => e.proj === `c:${p.id}`).reduce((a, e) => a + e.min, 0));
      const of = BUDGET_HOURS[p.id];
      const rest = of - used;
      const tail = rest >= 0 ? `${rest}h left` : `${-rest}h over budget`;
      return { title: long ? projectTitle(p) : p.name, used, of, caption: long ? `${used}h of ${of}h · ${tail}` : tail, go: { project: p.id } };
    })
    .sort((a, b) => b.used - a.used)
    .slice(0, 4);
}

/** "Sprint 2 of 8" when the epic plans that many sprints, else the sprint name. */
export function sprintOfPlan(name: string, planned: number): string {
  const n = Number(/(\d+)/.exec(name)?.[1] ?? 0);
  return n && n <= planned ? `${name} of ${planned}` : name;
}

/** Epic progress: tasks done per epic, with the active sprint (epics with a running sprint first, max 4). */
function epicItems(s: AppState, projectIds: string[], client: boolean): ProgItem[] {
  return projectIds
    .flatMap((pid) => epicsOf(s, pid))
    .filter((e) => e.state !== 'done')
    .map((e) => {
      const T = s.tickets.filter((t) => t.epicId === e.id);
      const done = T.filter((t) => t.st === 'done').length;
      const sp = activeSprintOf(s, e.id);
      const p = project(s, e.projectId);
      const spText = sp ? sprintOfPlan(sp.name, e.sprints) : 'No sprint running';
      const tail = client ? (p?.due ? `expected ${fmt(p.due)}` : '') : sp ? `ends ${fmt(sp.end)}` : '';
      return { item: { title: e.name, used: done, of: T.length, caption: [spText, tail].filter(Boolean).join(' · '), color: GREEN, value: `${pct(done, T.length)}%` }, active: !!sp };
    })
    .filter((x) => x.item.of > 0)
    .sort((a, b) => Number(b.active) - Number(a.active))
    .slice(0, 4)
    .map((x) => x.item);
}

/** Active sprints of some projects (most tickets first). */
function activeSprints(s: AppState, projectIds: string[]): Sprint[] {
  const ids = new Set(projectIds);
  return s.sprints
    .filter((sp) => sp.state === 'active' && ids.has(s.epics.find((e) => e.id === sp.epicId)?.projectId ?? sp.epicId))
    .sort((a, b) => s.tickets.filter((t) => t.sprintId === b.id).length - s.tickets.filter((t) => t.sprintId === a.id).length || a.end.localeCompare(b.end));
}

function sprintItem(s: AppState, sp: Sprint, title?: string): ProgItem {
  const T = s.tickets.filter((t) => t.sprintId === sp.id);
  const done = T.filter((t) => t.st === 'done').length;
  return {
    title: title ?? `${epicName(s, sp.epicId)} · ${sp.name}`,
    used: done,
    of: T.length,
    caption: `${fmtRange(sp.start, sp.end)} · ${sprintLeft(sp)}`,
    color: GREEN,
    value: `${pct(done, T.length)}%`,
  };
}

function weekWidget(s: AppState, who: string | null, free: boolean, id: string): Widget {
  if (who === null) {
    const people = loggers(s, WEEK_MONDAY, addD(WEEK_MONDAY, 6));
    const emp = employees(s).filter((p) => people.includes(p.name)).length;
    const days = weekBars(s, WEEK_MONDAY, null, { people: emp });
    const total = days.reduce((a, d) => a + d.billMin + d.nonMin, 0);
    return { id, k: 'bars', title: 'Team hours this week', sub: `${plural(people.length, 'person', 'people')} · 8h a day each`, link: 'Employee timesheets', go: page('emp'), days, idle: true, foot: `${hours(total)} logged` };
  }
  const days = weekBars(s, WEEK_MONDAY, who, { idle: !free });
  const total = days.reduce((a, d) => a + d.billMin + d.nonMin, 0);
  return { id, k: 'bars', title: 'My week', sub: free ? 'No daily target for freelancers' : '8h required a day', link: 'Timesheet', go: page('time'), days, idle: !free, foot: `${hours(total)} this week` };
}

/** Logged / idle this week for the signed-in person. */
export function myWeek(s: AppState): { logged: number; idle: number; bill: number; free: boolean } {
  const u = me(s);
  const free = isFreelancer(u);
  const days = weekBars(s, WEEK_MONDAY, u?.name ?? '', { idle: !free });
  return {
    logged: days.reduce((a, d) => a + d.billMin + d.nonMin, 0),
    idle: days.reduce((a, d) => a + d.idleMin, 0),
    bill: days.reduce((a, d) => a + d.billMin, 0),
    free,
  };
}

function weekKpis(s: AppState, logLink: PageKey): DashKpi[] {
  const w = myWeek(s);
  if (w.free) {
    return [
      { label: 'Logged this week', value: hours(w.logged), sub: 'No weekly target', dot: colors.ink, go: page(logLink) },
      { label: 'Billable this week', value: hours(w.bill), sub: `${pct(w.bill, w.logged)}% of logged time`, dot: colors.primary, go: page(logLink) },
    ];
  }
  return [
    { label: 'Logged this week', value: hours(w.logged), of: '/ 40h', sub: `${pct(w.logged, 2400)}% of working hours`, dot: colors.ink, go: page(logLink) },
    { label: 'Idle this week', value: hours(w.idle), sub: `${pct(w.idle, 2400)}% of working hours`, dot: colors.red, go: page(logLink) },
  ];
}

const dueThisWeek = (t: Ticket) => t.st !== 'done' && !!t.due && diff(t.due, TODAY) <= 7;

// ── Role configs ───────────────────────────────────────────────────────────

function superDash(s: AppState): Omit<Dashboard, 'role' | 'scope'> {
  const all = projVis(s);
  const active = all.filter((p) => p.state === 'active');
  const cos = new Set(active.filter((p) => p.kind === 'client').map((p) => p.coId));
  const monthStart = `${TODAY.slice(0, 7)}-01`;
  const monthMin = entriesBetween(s, monthStart, TODAY).reduce((a, e) => a + e.min, 0);
  const days = weekdays(monthStart, TODAY);
  const people = employees(s).filter((p) => loggers(s, monthStart, TODAY).includes(p.name));
  const idle = people.reduce((a, p) => a + idleOf(s, p.name, days), 0);
  const need = people.length * days.length * 480;
  const crit = s.tickets.filter((t) => t.st !== 'done' && t.prio === 'Critical');
  const today = s.leaves.filter((l) => l.st === 'approved' && l.from <= TODAY && l.to >= TODAY);
  const pending = s.leaves.filter((l) => l.st === 'pending');
  return {
    kpis: [
      { label: 'Active projects', value: String(active.length), sub: plural(cos.size, 'company', 'companies'), dot: colors.primary, go: page('projects') },
      { label: 'Logged this month', value: `${h(monthMin)}h`, of: `/ ${MONTH_CAPACITY_H}h`, sub: `${pct(monthMin / 60, MONTH_CAPACITY_H)}% of working hours`, dot: colors.ink, go: page('emp') },
      { label: 'Idle time', value: `${h(idle)}h`, sub: `${pct(idle, need)}% of working hours`, dot: colors.red, go: page('emp') },
      { label: 'Critical open', value: String(crit.length), sub: `${crit.filter(isLate).length} overdue`, dot: colors.danger, color: colors.danger, go: page('mytickets') },
    ],
    widgets: [
      { id: 'budget', k: 'prog', title: 'Budget vs hours used', sub: 'Client projects, hours sold vs logged', link: 'Projects', go: page('projects'), items: budgetItems(s, all.map((p) => p.id), true), empty: 'No client projects with a budget.' },
      { id: 'epics', k: 'prog', title: 'Epic progress', sub: 'Tasks done per epic', link: 'Tickets', go: page('mytickets'), items: epicItems(s, all.map((p) => p.id), false), empty: 'No epics in progress.' },
      weekWidget(s, null, false, 'team-week'),
      { id: 'devops', k: 'status', title: 'DevOps status', sub: 'Infra steps per project', link: 'DevOps board', go: page('devops'), items: devopsAll(s).filter((d) => d.infra !== 'Deployment Completed').slice(0, 4).map(stepItem), empty: 'No DevOps projects.' },
      { id: 'questions', k: 'list', title: 'Client questions waiting', sub: 'Asked by the team, not answered yet', link: 'Clients', go: page('clients'), items: questionItems(s, true).slice(0, 4), empty: 'No questions waiting.' },
      {
        id: 'leave',
        k: 'list',
        title: 'Leave & attendance',
        sub: 'Today and pending approvals',
        link: 'Users',
        go: page('users'),
        items: [
          ...today.map((l) => ({ badge: { label: 'Off today', tone: 'grey' as ToneName }, title: l.who, sub: `${leaveLabel(l)} · back ${fmtL(addD(l.to, 1))}`, go: page('users') })),
          ...pending.slice(0, 4).map((l) => ({
            badge: { label: 'Pending', tone: 'amber' as ToneName },
            title: `${l.who} · ${plural(l.days, 'day')}`,
            sub: `${leaveLabel(l)} · ${dayRange(l.from, l.to)}`,
            right: 'Approve',
            rightColor: colors.primaryInk,
            go: page('users'),
          })),
        ],
        empty: 'Nobody is off and nothing is pending.',
      },
    ],
  };
}

function adminDash(s: AppState): Omit<Dashboard, 'role' | 'scope'> {
  const pending = s.leaves.filter((l) => l.st === 'pending');
  const leave = pending.filter((l) => l.kind === 'Annual' || l.kind === 'Sick');
  const other = pending.filter((l) => l.kind !== 'Annual' && l.kind !== 'Sick');
  const oldest = leave.map((l) => l.from).sort()[0];
  const people = employees(s).filter((p) => loggers(s, WEEK_MONDAY, addD(WEEK_MONDAY, 6)).includes(p.name));
  const days = weekdays(WEEK_MONDAY, TODAY < addD(WEEK_MONDAY, 4) ? TODAY : addD(WEEK_MONDAY, 4));
  const idle = people.reduce((a, p) => a + idleOf(s, p.name, days), 0);
  const need = people.length * days.length * 480;
  const late = s.tickets.filter(isLate).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  return {
    kpis: [
      { label: 'Pending leave', value: String(leave.length), sub: oldest ? `Oldest from ${fmt(oldest)}` : 'Nothing waiting', dot: colors.amberDot, go: page('users') },
      { label: 'Holiday & personal', value: String(other.length), sub: 'Waiting for approval', dot: colors.amberDot, go: page('users') },
      { label: 'Team idle this week', value: `${h(idle)}h`, sub: `${pct(idle, need)}% of ${h(need)}h`, dot: colors.red, go: page('emp') },
      { label: 'Overdue tickets', value: String(late.length), sub: `Across ${plural(new Set(late.map((t) => t.projectId)).size, 'project')}`, dot: colors.danger, color: colors.danger, go: page('mytickets') },
    ],
    widgets: [
      {
        id: 'approvals',
        k: 'list',
        title: 'Approvals',
        sub: 'Leave waiting for you',
        link: 'Users',
        go: page('users'),
        items: pending.map((l) => ({
          badge: { label: l.kind === 'Annual' || l.kind === 'Sick' ? 'Leave' : l.kind, tone: (l.kind === 'Annual' || l.kind === 'Sick' ? 'amber' : 'blue') as ToneName },
          title: `${l.who} · ${leaveLabel(l)}`,
          sub: `${dayRange(l.from, l.to)} · ${plural(l.days, 'day')}`,
          right: 'Review',
          rightColor: colors.primaryInk,
          go: page('users'),
        })),
        empty: 'No leave waiting for approval.',
      },
      {
        id: 'hours',
        k: 'prog',
        title: 'Hours by employee',
        sub: 'This week, logged vs 40h',
        link: 'Employee timesheets',
        go: page('emp'),
        items: people
          .map((p) => {
            const min = entriesBetween(s, WEEK_MONDAY, addD(WEEK_MONDAY, 6), p.name).reduce((a, e) => a + e.min, 0);
            const idl = idleOf(s, p.name, days);
            return { title: p.name, used: min / 60, of: 40, caption: `${hours(min)} · ${hours(idl)} idle`, value: hours(min) };
          })
          .sort((a, b) => b.used - a.used),
        empty: 'No time logged this week.',
      },
      {
        id: 'overdue',
        k: 'list',
        title: 'Overdue tickets',
        sub: 'Past due date, not done',
        link: 'Tickets',
        go: page('mytickets'),
        items: late.slice(0, 5).map((t) => ticketListItem(s, t, `${epicName(s, t.epicId)} · ${t.as.join(', ') || 'Unassigned'}`)),
        empty: 'Nothing is overdue.',
      },
      { id: 'devops', k: 'status', title: 'DevOps status', sub: 'Infra steps per project', link: 'DevOps board', go: page('devops'), items: devopsAll(s).filter((d) => d.infra !== 'Deployment Completed').slice(0, 4).map(stepItem), empty: 'No DevOps projects.' },
      weekWidget(s, null, false, 'team-week'),
    ],
  };
}

function pmDash(s: AppState): Omit<Dashboard, 'role' | 'scope'> {
  const name = me(s)?.name ?? '';
  const mine = projVis(s).filter((p) => p.team.includes(name) && p.state !== 'done');
  const ids = mine.map((p) => p.id);
  const T = s.tickets.filter((t) => ids.includes(t.projectId));
  const sps = activeSprints(s, ids);
  const main = sps[0];
  const mainT = main ? s.tickets.filter((t) => t.sprintId === main.id) : [];
  const mainDone = mainT.filter((t) => t.st === 'done').length;
  const due = T.filter(dueThisWeek).sort((a, b) => (a.due ?? '').localeCompare(b.due ?? ''));
  const qs = openQuestions(s).filter((q) => ids.includes(q.projectId));
  const team = [...new Set(mine.flatMap((p) => p.team))].filter((n) => s.people.some((p) => p.name === n && p.org === 'vt'));
  return {
    kpis: [
      main
        ? { label: 'Active sprint', value: `${Math.max(0, diff(main.end, TODAY))} days`, of: 'left', sub: `${epicName(s, main.epicId)} · ${main.name}`, dot: colors.primary, go: page('projects') }
        : { label: 'Active sprint', value: '—', sub: 'No active sprint', dot: colors.primary, go: page('projects') },
      { label: 'Sprint done', value: `${pct(mainDone, mainT.length)}%`, sub: `${mainDone} of ${plural(mainT.length, 'task')}`, dot: colors.green, go: page('projects') },
      { label: 'Due this week', value: String(due.length), sub: `${due.filter(isLate).length} overdue`, dot: colors.amberDot, go: page('mytickets') },
      { label: 'Questions waiting', value: String(qs.length), sub: qs.length ? `Oldest ${qs[0].when}` : 'None waiting', dot: colors.violetDot, go: page('clients') },
    ],
    widgets: [
      { id: 'sprints', k: 'prog', title: 'Active sprints', sub: 'Tasks done vs planned', link: 'Epics & sprints', go: page('projects'), items: sps.map((sp) => sprintItem(s, sp)), empty: 'No active sprints.' },
      {
        id: 'due',
        k: 'list',
        title: 'Tickets due this week',
        sub: 'Your projects',
        link: 'Tickets',
        go: page('mytickets'),
        items: due.slice(0, 5).map((t) => ticketListItem(s, t, `${t.as.join(', ') || 'Unassigned'} · ${hours(loggedMin(s, t.key))} / ${t.est}h`)),
        empty: 'Nothing due this week.',
      },
      { id: 'budget', k: 'prog', title: 'Budget vs hours used', sub: 'Hours sold vs logged', link: 'Projects', go: page('projects'), items: budgetItems(s, ids, false), empty: 'No client projects with a budget.' },
      { id: 'questions', k: 'list', title: 'Client questions waiting', sub: 'Asked to clients on your projects', link: 'Clients', go: page('clients'), items: questionItems(s, true, qs), empty: 'No questions waiting.' },
      {
        id: 'load',
        k: 'prog',
        title: 'Team load',
        sub: 'Open estimate vs time left in sprint',
        link: 'Tickets',
        go: page('mytickets'),
        items: team
          .map((n) => {
            const open = s.tickets.filter((t) => t.st !== 'done' && t.as.includes(n) && t.sprintId && sps.some((sp) => sp.id === t.sprintId));
            const planned = open.reduce((a, t) => a + (t.est || 0), 0);
            const end = open.map((t) => sprint(s, t.sprintId)?.end ?? TODAY).sort().pop() ?? main?.end ?? TODAY;
            const avail = weekdays(TODAY, end).length * 8;
            const caption = !avail
              ? `${planned}h planned · no working days left`
              : planned > avail
                ? `${planned}h planned · ${planned - avail}h over`
                : `${planned}h planned · ${avail}h available`;
            return { title: n, used: planned, of: avail || planned, caption, value: `${planned}h` };
          })
          .filter((x) => x.used > 0),
        empty: 'Nobody has sprint work planned.',
      },
    ],
  };
}

function devDash(s: AppState): Omit<Dashboard, 'role' | 'scope'> {
  const u = me(s);
  const name = u?.name ?? '';
  const free = isFreelancer(u);
  const A = s.tickets.filter((t) => t.as.includes(name));
  const open = A.filter((t) => t.st !== 'done');
  const due = open.filter(dueThisWeek);
  const next = open.slice().sort((a, b) => (a.due || '9').localeCompare(b.due || '9')).slice(0, 4);
  const sps = [...new Set(A.map((t) => t.sprintId).filter((x): x is string => !!x))]
    .map((id) => sprint(s, id))
    .filter((sp): sp is Sprint => !!sp && sp.state === 'active')
    .sort((a, b) => A.filter((t) => t.sprintId === b.id).length - A.filter((t) => t.sprintId === a.id).length);
  const sp = sps[0];
  const myKeys = new Set(A.map((t) => t.key));
  const qs = s.questions.filter((q) => q.task && myKeys.has(q.task) && !q.solved);
  return {
    kpis: [
      { label: 'My open tickets', value: String(open.length), sub: `${open.filter((t) => t.st === 'prog').length} in progress`, dot: colors.primary, go: page('mytickets') },
      { label: 'Due this week', value: String(due.length), sub: `${due.filter(isLate).length} overdue`, dot: colors.amberDot, go: page('mytickets') },
      ...weekKpis(s, 'time'),
    ],
    widgets: [
      { id: 'tix', k: 'tix', title: 'My tickets', sub: 'Sorted by due date', link: 'My tickets', go: page('mytickets'), keys: next.map((t) => t.key), empty: 'No open tickets.' },
      weekWidget(s, name, free, 'my-week'),
      {
        id: 'projects',
        k: 'prog',
        title: 'My active projects',
        sub: 'Projects you are assigned to',
        link: 'Projects',
        go: page('projects'),
        items: projVis(s)
          .filter((p) => p.state !== 'done')
          .slice(0, 3)
          .map((p) => ({
            title: projectTitle(p),
            used: p.pct,
            of: 100,
            caption: `${s.tickets.filter((t) => t.projectId === p.id && t.as.includes(name) && t.st !== 'done').length} of my tickets open`,
            color: GREEN,
            value: `${p.pct}% done`,
            go: { project: p.id },
          })),
        empty: 'No active projects.',
      },
      {
        id: 'sprint',
        k: 'prog',
        title: 'My sprint',
        sub: sp ? `${epicName(s, sp.epicId)} · ${sp.name}` : 'No active sprint',
        link: 'Epics & sprints',
        go: page('mytickets'),
        items: sp
          ? (() => {
              const T = s.tickets.filter((t) => t.sprintId === sp.id);
              const d = T.filter((t) => t.st === 'done').length;
              const M = T.filter((t) => t.as.includes(name));
              const md = M.filter((t) => t.st === 'done').length;
              return [
                { title: `${sp.name} · team`, used: d, of: T.length, caption: `${d} of ${T.length} tasks done · ${sprintLeft(sp)}`, color: GREEN },
                { title: 'My tasks', used: md, of: M.length, caption: `${md} of ${M.length} done`, color: GREEN },
              ];
            })()
          : [],
        empty: 'No active sprint.',
      },
      {
        id: 'questions',
        k: 'list',
        title: 'Questions on my tickets',
        sub: 'Client answers you are waiting for',
        link: 'Tickets',
        go: page('mytickets'),
        items: qs.map((q) => ({
          badge: { label: `Q-${q.id}`, tone: (q.answer ? 'blue' : 'amber') as ToneName },
          title: q.title,
          sub: `${q.task} · ${project(s, q.projectId)?.name ?? ''} · ${q.answer ? 'answered' : 'no reply yet'}`,
          right: q.when,
          rightColor: q.answer ? colors.primaryInk : colors.amberInk,
          go: { ticket: q.task! },
        })),
        empty: 'No questions on your tickets.',
      },
    ],
  };
}

function devopsDash(s: AppState): Omit<Dashboard, 'role' | 'scope'> {
  const reqs = openRequests(s);
  const D = devopsAll(s);
  const setup = D.filter((d) => !['Not started', 'Deployment Completed', 'Adding new services'].includes(d.infra));
  const waiting = D.filter((d) => d.from === 'Client' && d.infra === 'Client onboarding');
  const soon = D.filter((d) => d.reminder && d.reminder.slice(0, 10) >= TODAY && diff(d.reminder.slice(0, 10), TODAY) <= 7).sort((a, b) => (a.reminder ?? '').localeCompare(b.reminder ?? ''));
  const name = me(s)?.name ?? '';
  return {
    kpis: [
      { label: 'Open requests', value: String(reqs.length), sub: 'From project teams', dot: colors.amberDot, go: page('devops') },
      { label: 'Projects in setup', value: String(setup.length), sub: `${waiting.length} waiting for client`, dot: colors.primary, go: page('devops') },
      { label: 'Due this week', value: String(soon.length), sub: soon.length ? `Next: ${fmtL(soon[0].reminder!.slice(0, 10))}` : 'Nothing due', dot: colors.danger, go: page('devops') },
      weekKpis(s, 'time')[0],
    ],
    widgets: [
      { id: 'infra', k: 'status', title: 'Infra status', sub: 'Steps per project', link: 'DevOps board', go: page('devops'), items: (setup.length ? setup : D).slice(0, 4).map(stepItem), empty: 'No DevOps projects.' },
      {
        id: 'requests',
        k: 'list',
        title: 'DevOps requests',
        sub: 'Raised by project teams',
        link: 'DevOps board',
        go: page('devops'),
        items: reqs.slice(0, 4).map((r) => ({
          badge: { label: r.prio, tone: (r.prio === 'High' || r.prio === 'Critical' ? 'red' : r.prio === 'Medium' ? 'amber' : 'grey') as ToneName },
          title: r.text,
          sub: `${r.rkey} · ${requestProjectName(s, r)} · raised by ${r.by}`,
          go: { request: r.id },
        })),
        empty: 'No open requests.',
      },
      {
        id: 'waiting',
        k: 'list',
        title: 'Waiting for client',
        sub: 'Blocked until the client answers',
        link: 'DevOps board',
        go: page('devops'),
        items: waiting.map((d) => {
          const since = d.actDate?.slice(0, 10);
          const n = since ? diff(TODAY, since) : 0;
          return {
            badge: { label: d.act, tone: ((d.step ?? 0) >= s.devopsSettings.esc ? 'red' : 'amber') as ToneName },
            title: d.name,
            sub: `${d.company} · ${since ? `since ${fmt(since)}` : 'no date'}`,
            right: since ? plural(n, 'day') : '',
            rightColor: n >= 4 ? colors.danger : colors.ink3,
            go: { dvp: d.key },
          };
        }),
        empty: 'Nothing is waiting for a client.',
      },
      weekWidget(s, name, false, 'my-week'),
    ],
  };
}

function clientDash(s: AppState, role: 'cadmin' | 'cuser'): Omit<Dashboard, 'role' | 'scope'> {
  const name = me(s)?.name ?? '';
  const vis = projVis(s);
  const ids = vis.map((p) => p.id);
  const T = s.tickets.filter((t) => ids.includes(t.projectId));
  const done = T.filter((t) => t.st === 'done').length;
  const qs = openQuestions(s);
  const sps = activeSprints(s, ids);
  const next = sps.slice().sort((a, b) => a.end.localeCompare(b.end))[0];
  const main = sps[0];
  const mainT = main ? s.tickets.filter((t) => t.sprintId === main.id) : [];
  const mainDone = mainT.filter((t) => t.st === 'done').length;
  const bugs = visibleBugs(s);
  const myBugs = bugs.filter((b) => b.by === name);
  const qKpi: DashKpi = { label: 'Questions for you', value: String(qs.length), sub: qs.length ? `Oldest ${qs[0].when}` : 'Nothing waiting', dot: colors.danger, color: qs.length ? colors.danger : undefined, go: page('questions') };
  const nextKpi: DashKpi = next
    ? { label: 'Next delivery', value: fmt(next.end), sub: `End of ${next.name}`, dot: colors.primary, go: page('portal') }
    : { label: 'Next delivery', value: '—', sub: 'No sprint running', dot: colors.primary, go: page('portal') };
  const bugItems = (L: typeof bugs) =>
    L.slice(0, 3).map((b) => ({
      badge: { label: TICKET_STATUS[b.st].client, tone: TICKET_STATUS[b.st].tone },
      title: b.title,
      sub: `Reported by ${b.by === name ? 'you' : b.by} · ${fmt(b.when)}`,
      go: { bug: b.id } as Target,
    }));
  const golive = ids.map((id) => devopsFor(s, id)).filter((d): d is DevopsView => !!d);
  if (role === 'cadmin') {
    return {
      kpis: [
        { label: 'Projects', value: String(vis.length), sub: vis.map((p) => p.name).join(', ') || 'None yet', dot: colors.primary, go: page('portal') },
        { label: 'Overall progress', value: `${pct(done, T.length)}%`, sub: `${done} of ${plural(T.length, 'task')} done`, dot: colors.green, go: page('portal') },
        nextKpi,
        qKpi,
      ],
      widgets: [
        { id: 'epics', k: 'prog', title: 'Epic progress', sub: `What is being built for ${vis[0]?.co ?? 'you'}`, link: 'Projects', go: page('portal'), items: epicItems(s, ids, true), empty: 'No epics in progress.' },
        { id: 'questions', k: 'list', title: 'Questions waiting for you', sub: 'The team needs an answer to continue', link: 'Answer', go: page('questions'), items: questionItems(s, false), empty: 'No questions waiting. Nice.' },
        { id: 'bugs', k: 'list', title: 'Bugs reported', sub: 'By your colleagues', link: 'Bugs', go: page('bugs'), items: bugItems(bugs), empty: 'No bugs reported.' },
        { id: 'golive', k: 'status', title: 'Go-live readiness', sub: 'Setup steps on Viljetech side', link: 'Projects', go: page('portal'), items: golive.slice(0, 2).map((d) => ({ ...stepItem(d), go: undefined })), empty: 'No setup steps yet.' },
      ],
    };
  }
  const recent = T.filter((t) => t.st === 'done' && t.due && diff(TODAY, t.due) <= 14).sort((a, b) => (b.due ?? '').localeCompare(a.due ?? ''));
  return {
    kpis: [
      qKpi,
      { label: 'My open bugs', value: String(myBugs.filter((b) => b.st !== 'done').length), sub: `${myBugs.filter((b) => b.st === 'prog').length} in progress`, dot: colors.red, go: page('bugs') },
      nextKpi,
      { label: 'Sprint progress', value: `${pct(mainDone, mainT.length)}%`, sub: `${mainDone} of ${plural(mainT.length, 'task')}`, dot: colors.green, go: page('portal') },
    ],
    widgets: [
      { id: 'questions', k: 'list', title: 'Questions waiting for you', sub: 'Answer so the team can continue', link: 'Answer', go: page('questions'), items: questionItems(s, false), empty: 'No questions waiting. Nice.' },
      { id: 'bugs', k: 'list', title: 'My bugs', sub: 'Bugs you reported', link: 'Bugs', go: page('bugs'), items: bugItems(myBugs), empty: 'No bugs reported.' },
      {
        id: 'sprint',
        k: 'prog',
        title: 'Current sprint',
        sub: main ? `${epicName(s, main.epicId)} · ${main.name}` : 'No sprint running',
        link: 'Projects',
        go: page('portal'),
        items: main ? [sprintItem(s, main, main.name), ...epicItems(s, ids, true).filter((e) => e.title === epicName(s, main.epicId)).map((e) => ({ ...e, title: `${e.title} epic` }))] : [],
        empty: 'No sprint running.',
      },
      {
        id: 'delivered',
        k: 'list',
        title: 'Recently delivered',
        sub: 'Done in the last two weeks',
        link: 'Projects',
        go: page('portal'),
        items: recent.slice(0, 4).map((t) => ({ badge: { label: 'Done', tone: 'green' as ToneName }, title: t.title, sub: `${sprint(s, t.sprintId)?.name ?? 'Backlog'} · ${fmt(t.due)}`, go: { ticket: t.key } })),
        empty: 'Nothing delivered in the last two weeks.',
      },
    ],
  };
}

/** The dashboard of the signed-in person's role. */
export function buildDashboard(s: AppState): Dashboard | null {
  const u = me(s);
  if (!u) return null;
  const role = u.role;
  const body =
    role === 'super'
      ? superDash(s)
      : role === 'admin'
        ? adminDash(s)
        : role === 'pm'
          ? pmDash(s)
          : role === 'devops'
            ? devopsDash(s)
            : isClientRole(role)
              ? clientDash(s, role)
              : devDash(s);
  return { role, scope: DASH_SCOPE[role], ...body };
}
