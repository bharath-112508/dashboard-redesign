/**
 * Home feature selectors (SPEC S-HOME): KPI tiles, lists, the week card, the projects
 * carousel and team hours, per Home variant (homeVariant(role)). Pure functions of
 * AppState; navigation targets are data (`HomeTarget`) that the screen resolves.
 */
import type { IconName } from '@/components/icons';
import { TODAY } from '@/data/clock';
import { KPI_ICON, TICKET_STATUS, TICKET_TYPE } from '@/data/constants';
import { addD, dateRange, dow, hm, sh } from '@/data/format';
import {
  activeProjectStats,
  activeSprint,
  byDue,
  companyOf,
  dueInfo,
  isOpen,
  me,
  myTickets,
  pendingApprovals,
  projectByName,
  questionStatus,
  questionsNeedingClient,
  remindersDue,
  teamWeek,
  visibleProjects,
  weekData,
  weekTotals,
} from '@/data/selectors';
import type { AppState } from '@/data/store/state';
import type { Ticket } from '@/data/types';
import type { HomeVariant, TabKey } from '@/nav/tabs';
import { homeVariant } from '@/nav/tabs';
import { colors, motion, softOf, type Anim } from '@/theme';

/** Where a Home element leads (M-44): a tab of the role, or a pushed screen. */
export type HomeTarget =
  | { kind: 'tab'; tab: TabKey }
  | { kind: 'ticket'; id: number }
  | { kind: 'question'; id: number }
  | { kind: 'project'; name: string }
  | { kind: 'leave' };

export interface HomeKpi {
  label: string;
  value: string;
  sub: string;
  icon: IconName;
  accent: string;
  accentSoft: string;
  valueColor: string;
  anim: Anim | null;
  target: HomeTarget;
}

export interface HomeRow {
  key: string;
  icon: IconName;
  iconBg: string;
  iconFg: string;
  tag: string;
  tagBg: string;
  tagFg: string;
  critical: boolean;
  title: string;
  meta: string;
  right: string;
  rightColor: string;
  target: HomeTarget;
}

export interface HomeList {
  id: string;
  title: string;
  link: string;
  linkTarget: HomeTarget;
  rows: HomeRow[];
  empty: string;
}

const tab = (t: TabKey): HomeTarget => ({ kind: 'tab', tab: t });

function kpi(label: string, value: string | number, sub: string, accent: string, hot: boolean, target: HomeTarget): HomeKpi {
  const icon = KPI_ICON[label] ?? 'circle';
  const v = String(value);
  const positive = parseFloat(v) > 0;
  const anim =
    positive && icon === 'siren'
      ? motion.twinkle()
      : positive && (icon === 'bell-ring' || icon === 'alarm-clock')
        ? motion.bell(2.8, 'infinite', 0)
        : null;
  return {
    label,
    value: v,
    sub,
    icon,
    accent,
    accentSoft: softOf[accent] ?? colors.primarySoft,
    valueColor: hot ? colors.danger : colors.ink,
    anim,
    target,
  };
}

/** A ticket as a Home list row (type icon, key, critical badge, due label). */
export function ticketRow(t: Ticket, viewerIsClient: boolean): HomeRow {
  const ty = TICKET_TYPE[t.type];
  const di = dueInfo(t);
  const st = TICKET_STATUS[t.st];
  return {
    key: t.key,
    icon: ty.icon,
    iconBg: ty.soft,
    iconFg: ty.ink,
    tag: t.key,
    tagBg: colors.primarySoft,
    tagFg: colors.primaryInk,
    critical: t.prio === 'Critical' && !viewerIsClient,
    title: t.title,
    meta: `${t.proj} · ${viewerIsClient ? st.client : st.label}`,
    right: di.label,
    rightColor: di.color,
    target: { kind: 'ticket', id: t.id },
  };
}

/** KPI tiles for the signed-in person's Home variant. */
export function homeKpis(s: AppState): HomeKpi[] {
  const person = me(s);
  if (!person?.role) return [];
  const variant = homeVariant(person.role);
  const mine = myTickets(s);
  const open = mine.filter(isOpen);
  const late = open.filter((t) => dueInfo(t).late);
  const crit = open.filter((t) => t.prio === 'Critical');

  if (variant === 'client') {
    const need = questionsNeedingClient(s);
    const bugs = s.tickets.filter((t) => t.client && isOpen(t));
    const proj = clientMainProject(s);
    const sprint = proj ? activeSprint(proj.name) : undefined;
    return [
      kpi('Questions for you', need.length, need.length ? 'Tap to answer' : 'All answered', colors.danger, need.length > 0, tab('questions')),
      kpi('Open bugs', bugs.length, 'Reported by your team', colors.orange, false, tab('bugs')),
      {
        ...kpi('Daco platform', `${proj?.pct ?? 0}%`, 'Overall progress', colors.green, false, proj ? { kind: 'project', name: proj.name } : tab('projects')),
        label: proj?.name ?? 'Progress',
      },
      kpi(
        'Next milestone',
        sprint ? sh(sprint.b) : '—',
        sprint ? `${sprint.n} demo` : 'Nothing planned',
        colors.primary,
        false,
        proj ? { kind: 'project', name: proj.name } : tab('projects'),
      ),
    ];
  }

  if (variant === 'devops') {
    const due = remindersDue(s);
    const clients = new Set(s.devops.map((d) => d.co)).size;
    return [
      kpi('Projects in setup', s.devops.length, `Across ${clients} client${clients === 1 ? '' : 's'}`, colors.primary, false, tab('devops')),
      kpi('Reminders due', due.length, due.length ? 'Send today' : 'None today', colors.danger, due.length > 0, tab('devops')),
      kpi('CI/CD live', `${s.devops.filter((d) => d.ci).length}/${s.devops.length}`, 'Pipelines running', colors.green, false, tab('devops')),
      kpi('My open tickets', open.length, late.length ? `${late.length} overdue` : 'On track', colors.amber, false, tab('tickets')),
    ];
  }

  if (variant === 'staffAll') {
    const allOpen = s.tickets.filter(isOpen);
    const allLate = allOpen.filter((t) => dueInfo(t).late);
    const stats = activeProjectStats(s);
    return [
      kpi('Active projects', stats.count, `Across ${stats.companies} compan${stats.companies === 1 ? 'y' : 'ies'}`, colors.primary, false, tab('projects')),
      kpi('Critical open', allOpen.filter((t) => t.prio === 'Critical').length, 'Fix these first', colors.danger, true, tab('tickets')),
      kpi('Overdue tickets', allLate.length, 'Across projects', colors.orange, allLate.length > 0, tab('tickets')),
      kpi('Approvals', pendingApprovals(s).length, 'Leave & comp-off', colors.violet, false, { kind: 'leave' }),
    ];
  }

  const free = person.role === 'free';
  const total = weekTotals(weekData(s, 0)).total;
  const projects = new Set(open.map((t) => t.proj)).size;
  return [
    kpi('Open tickets', open.length, `Across ${projects} project${projects === 1 ? '' : 's'}`, colors.primary, false, tab('tickets')),
    kpi('Critical', crit.length, crit.length ? 'Fix these first' : 'None', colors.danger, crit.length > 0, tab('tickets')),
    kpi('Overdue', late.length, late.length ? 'Past due date' : 'Nothing late', colors.orange, late.length > 0, tab('tickets')),
    kpi('Logged this week', hm(total), free ? 'Hours logged' : 'of 40h', colors.green, false, tab('time')),
  ];
}

/** The client's main building project (first active project of their company). */
function clientMainProject(s: AppState) {
  return visibleProjects(s).find((p) => p.status === 'active');
}

/** The list sections for the signed-in person's Home variant. */
export function homeLists(s: AppState): HomeList[] {
  const person = me(s);
  if (!person?.role) return [];
  const variant = homeVariant(person.role);
  const isClient = variant === 'client';

  if (variant === 'client') {
    const qs = questionsNeedingClient(s).map((q): HomeRow => {
      const st = questionStatus(q);
      return {
        key: `q${q.id}`,
        icon: 'message-circle-question',
        iconBg: st.soft,
        iconFg: st.ink,
        tag: st.label,
        tagBg: st.soft,
        tagFg: st.ink,
        critical: false,
        title: q.title,
        meta: `Asked by ${q.by} · ${q.tk}`,
        right: '',
        rightColor: colors.ink3,
        target: { kind: 'question', id: q.id },
      };
    });
    const bugs = s.tickets.filter((t) => t.client && isOpen(t)).sort(byDue).map((t) => ticketRow(t, true));
    return [
      { id: 'questions', title: 'Questions waiting for you', link: 'All', linkTarget: tab('questions'), rows: qs, empty: 'Nothing waiting for you.' },
      { id: 'bugs', title: 'Your bugs', link: 'All', linkTarget: tab('bugs'), rows: bugs, empty: 'No open bugs.' },
    ];
  }

  if (variant === 'devops') {
    const rows = s.devops
      .slice()
      .sort((a, b) => a.remIn - b.remIn)
      .map((d): HomeRow => {
        const late = d.remIn < 0;
        const today = d.remIn === 0;
        const soft = late ? colors.dangerSoft : today ? colors.amberSoft : colors.primarySoft;
        return {
          key: d.p,
          icon: 'bell-ring',
          iconBg: soft,
          iconFg: late ? colors.danger : today ? colors.amberInk : colors.primaryInk,
          tag: d.rem,
          tagBg: soft,
          tagFg: late ? colors.dangerInk : today ? colors.amberInk : colors.primaryInk,
          critical: false,
          title: d.p,
          meta: d.phase,
          right: late ? `${-d.remIn}d late` : today ? 'Today' : `In ${d.remIn}d`,
          rightColor: late ? colors.danger : today ? colors.amberInk : colors.ink,
          target: tab('devops'),
        };
      });
    return [{ id: 'reminders', title: 'Reminders', link: 'DevOps board', linkTarget: tab('devops'), rows, empty: 'No reminders.' }];
  }

  const attention = (list: Ticket[]) =>
    list.filter((t) => isOpen(t) && (t.prio === 'Critical' || dueInfo(t).late)).sort(byDue).map((t) => ticketRow(t, isClient));

  if (variant === 'staffAll') {
    const leave = pendingApprovals(s).map((l): HomeRow => {
      const isLeave = l.type === 'Leave';
      return {
        key: `l${l.id}`,
        icon: isLeave ? 'calendar-days' : 'calendar-clock',
        iconBg: colors.violetSoft,
        iconFg: colors.violetInk,
        tag: l.type,
        tagBg: isLeave ? colors.violetSoft : colors.amberSoft,
        tagFg: isLeave ? colors.violetInk : colors.amberInk,
        critical: false,
        title: l.who,
        meta: `${dateRange(l.from, l.to)} · ${l.reason}`,
        right: '',
        rightColor: colors.ink3,
        target: { kind: 'leave' },
      };
    });
    return [
      { id: 'attention', title: 'Needs attention', link: 'All tickets', linkTarget: tab('tickets'), rows: attention(s.tickets), empty: 'Nothing critical.' },
      { id: 'approvals', title: 'Waiting for approval', link: 'Review', linkTarget: { kind: 'leave' }, rows: leave, empty: 'All caught up.' },
    ];
  }

  return [{ id: 'now', title: 'Needs you now', link: 'My tickets', linkTarget: tab('tickets'), rows: attention(myTickets(s)), empty: 'Nothing urgent.' }];
}

export interface WeekCardDay {
  d: string;
  label: string;
  hours: string;
  bill: number;
  non: number;
  idle: number;
  isToday: boolean;
}

export interface WeekCard {
  /** "5 – 9 Oct" */
  range: string;
  days: WeekCardDay[];
  showIdle: boolean;
  /** "29h / 40h" (freelancers: "29h") */
  total: string;
}

/** The "This week" card: Mon–Fri of the current week on a 10h scale (not for clients). */
export function homeWeek(s: AppState): WeekCard {
  const free = me(s)?.role === 'free';
  const days = weekData(s, 0);
  const mon = days[0].d;
  const fri = addD(mon, 4);
  const range = mon.slice(0, 7) === fri.slice(0, 7) ? `${Number(mon.slice(8))} – ${sh(fri)}` : `${sh(mon)} – ${sh(fri)}`;
  const total = weekTotals(days).total;
  return {
    range,
    days: days.slice(0, 5).map((d) => ({
      d: d.d,
      label: dow(d.d),
      hours: d.bill + d.non ? hm(d.bill + d.non) : '–',
      bill: d.bill,
      non: d.non,
      idle: d.idle,
      isToday: d.d === TODAY,
    })),
    showIdle: !free,
    total: hm(total) + (free ? '' : ' / 40h'),
  };
}

export interface CarouselProject {
  name: string;
  company: string;
  pct: number;
  /** "5 open tickets" / "Progress" for the client */
  caption: string;
}

/**
 * Active projects carousel (not for devops). Client and staffAll: the active building
 * projects they can see; dev and free: the projects of their open tickets.
 */
export function homeProjects(s: AppState): CarouselProject[] {
  const person = me(s);
  if (!person?.role) return [];
  const variant: HomeVariant = homeVariant(person.role);
  if (variant === 'devops') return [];
  const mine = myTickets(s);
  const names =
    variant === 'ic'
      ? [...new Set(mine.filter(isOpen).map((t) => t.proj))]
      : visibleProjects(s)
          .filter((p) => p.status === 'active')
          .map((p) => p.name);
  return names.map((name) => {
    const n = mine.filter((t) => t.proj === name && isOpen(t)).length;
    return {
      name,
      company: companyOf(s, name),
      pct: projectByName(s, name)?.pct ?? 0,
      caption: variant === 'client' ? 'Progress' : `${n} open ticket${n === 1 ? '' : 's'}`,
    };
  });
}

export interface TeamCardRow {
  name: string;
  sub: string;
  hours: string;
  bill: number;
  non: number;
  idle: number;
}

/** Team hours card (staffAll), from the same source as the Team hours screen. */
export function homeTeam(s: AppState): TeamCardRow[] {
  return teamWeek(s, 0).map((r) => ({
    name: r.name,
    sub: r.isFree ? 'Freelancer' : '',
    hours: hm(r.logged),
    bill: r.billable,
    non: r.nonBillable,
    idle: r.idle ?? 0,
  }));
}
