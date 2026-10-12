/**
 * Maintenance view model: port of the prototype's mnt() (SPEC S-PROJECT, Support and
 * Report). Pure functions of the store state, so screens only render.
 */
import { TODAY } from '@/data/clock';
import { PLAN_TYPE_LABEL, SUPPORT_PRIO, SUPPORT_STATUS } from '@/data/constants';
import { diff, hm, shY } from '@/data/format';
import { capabilities, maintenanceOf, me, projectByName } from '@/data/selectors';
import { REPORTS } from '@/data/seed/maintenance';
import type { AppState } from '@/data/store';
import type { Environment, MonthlyReport, SupportPlan, SupportRequest, UpkeepTask } from '@/data/types';
import { colors } from '@/theme';

export type MaintMode = 'client' | 'staff' | 'ic';

export interface RequestVM extends SupportRequest {
  statusLabel: string;
  statusTone: { soft: string; ink: string };
  prioTone: { soft: string; ink: string };
  open: boolean;
  /** assignee or "Unassigned" */
  who: string;
  whoColor: string;
  slaColor: string;
  billLabel: string;
  billTone: { soft: string; ink: string };
  canAssign: boolean;
}

export interface TaskVM extends UpkeepTask {
  dueLabel: string;
  dueColor: string;
  mine: boolean;
}

export interface ReportVM {
  month: string;
  months: string[];
  title: string;
  sent: string;
  kpis: { label: string; value: string }[];
  split: { label: string; hours: string; pct: number }[];
  done: string[];
  current: boolean;
}

export interface MaintVM {
  mode: MaintMode;
  plan: SupportPlan | null;
  hasHours: boolean;
  hasSla: boolean;
  planLabel: string;
  health: { uptime: string; incident: string; window: string; version: string; deployed: string };
  hours: {
    used: string;
    quota: string;
    left: string;
    leftColor: string;
    pct: number;
    rollLabel: string;
    overLabel: string;
    bars: { month: string; hours: string; pct: number; over: boolean }[];
    planLinePct: number;
    toQuote: number;
  };
  sla: { cover: string; resp: string; fix: string; onTime: string; renew: string };
  /** client: all requests; staff: open requests */
  requests: RequestVM[];
  myRequests: RequestVM[];
  openCount: number;
  /** staff: all tasks; IC: my tasks; client: none */
  tasks: TaskVM[];
  environments: Environment[];
  releases: { v: string; date: string; text: string }[];
  report: ReportVM;
  /** "Support until" for the hero */
  until: string;
  /** "Live since" for the hero */
  liveSince: string;
}

const MONTH_LONG: Record<string, string> = { Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October' };
const NEXT_MONTH: Record<string, string> = { Jul: 'Aug', Aug: 'Sep', Sep: 'Oct', Oct: 'Nov' };
/** The month that is still open (TODAY's month); its report is computed live. */
export const CURRENT_MONTH = 'Oct';

/** Upkeep task due label: "in 5d", "Today", "2d late", "Done"; red within 2 days. */
export function taskDue(t: UpkeepTask): { label: string; color: string } {
  const d = diff(t.due, TODAY);
  const label = t.done ? 'Done' : d === 0 ? 'Today' : d < 0 ? `${-d}d late` : `in ${d}d`;
  return { label, color: !t.done && d <= 2 ? colors.danger : colors.ink3 };
}

/** Months of the report chips (oldest first, current month last) and the default. */
export function reportMonths(project: string): { months: string[]; fallback: string } {
  const closed = Object.keys(REPORTS[project] ?? {}).reverse();
  const months = [...closed, CURRENT_MONTH].filter((x, i, a) => a.indexOf(x) === i);
  return { months, fallback: months.length > 1 ? months[months.length - 2] : CURRENT_MONTH };
}

export function maintenanceVM(s: AppState, project: string): MaintVM {
  const person = me(s);
  const role = person?.role ?? 'dev';
  const caps = capabilities(role);
  const mode: MaintMode = caps.maintMode;
  const p = projectByName(s, project);
  const plan = p?.plan ?? null;
  const m = maintenanceOf(s, project);
  const c: Pick<SupportPlan, 'type' | 'hours' | 'resp' | 'fix' | 'cover' | 'renew' | 'start' | 'roll' | 'over' | 'url' | 'win' | 'auto'> =
    plan ?? { type: 'sla', hours: 0, resp: '—', fix: '—', cover: 'Business hours', renew: TODAY, start: TODAY, roll: 'expire', over: 'ask', url: '', win: '', auto: false };
  const hasHours = c.type !== 'sla' && c.hours > 0;
  const hasSla = c.type !== 'hours';

  const used = m.hist.length ? m.hist[m.hist.length - 1][1] : 0;
  const over = hasHours && used > c.hours;
  const left = Math.max(0, c.hours - used);
  const mx = Math.max(c.hours || 1, ...m.hist.map((h) => h[1]), 1);

  const requests: RequestVM[] = m.req.map((r) => {
    const st = SUPPORT_STATUS[r.st];
    return {
      ...r,
      statusLabel: st.label,
      statusTone: { soft: st.soft, ink: st.ink },
      prioTone: SUPPORT_PRIO[r.prio],
      open: r.st !== 'done',
      who: r.as || 'Unassigned',
      whoColor: r.as ? colors.ink : colors.danger,
      slaColor: r.risk ? colors.danger : colors.ink3,
      billLabel: r.outside ? 'Outside plan · billable' : 'Included in plan',
      billTone: r.outside ? { soft: colors.amberSoft, ink: colors.amberInk } : { soft: colors.greenSoft, ink: colors.greenInk },
      canAssign: !r.as,
    };
  });
  const openReqs = requests.filter((r) => r.open);
  const tasks: TaskVM[] = m.tasks.map((t) => {
    const d = taskDue(t);
    return { ...t, dueLabel: d.label, dueColor: d.color, mine: t.who === person?.name };
  });

  // Report
  const { months, fallback } = reportMonths(project);
  const chosen = s.ui.reportMonth[project];
  const month = chosen && months.includes(chosen) ? chosen : fallback;
  const current = month === CURRENT_MONTH;
  const doneReqs = requests.filter((r) => r.st === 'done');
  const r0: MonthlyReport = current
    ? {
        opened: requests.length,
        closed: doneReqs.length,
        sla: requests.some((r) => r.risk && r.open) ? '1 at risk' : '100%',
        up: m.uptime,
        done: [...doneReqs.map((r) => `Fixed ${r.id} · ${r.t}`), ...tasks.filter((t) => t.done).map((t) => t.title)],
        split: [
          ['Bugs', requests.filter((r) => r.type === 'Bug').reduce((a, r) => a + r.hrs, 0)],
          ['Changes', requests.filter((r) => r.type === 'Change').reduce((a, r) => a + r.hrs, 0)],
          ['Upkeep', 1],
        ],
      }
    : REPORTS[project][month];
  const total = r0.split.reduce((a, x) => a + x[1], 0);
  const smx = Math.max(1, ...r0.split.map((x) => x[1]));
  const report: ReportVM = {
    month,
    months,
    current,
    title: `${MONTH_LONG[month] ?? month} 2026${current ? ' · so far' : ''}`,
    sent: current ? 'Sent automatically on 1 Nov' : c.auto ? `Sent to client on 1 ${NEXT_MONTH[month]}` : 'Not sent yet',
    kpis: [
      hasHours ? { label: 'Support hours', value: `${hm(total)} of ${c.hours}h` } : { label: 'Hours worked', value: hm(total) },
      { label: 'Requests closed', value: `${r0.closed} of ${r0.opened}` },
      ...(hasSla ? [{ label: 'Within SLA', value: r0.sla }] : []),
      { label: 'Uptime', value: r0.up },
    ],
    split: r0.split.map(([label, h]) => ({ label, hours: hm(h), pct: (h / smx) * 100 })),
    done: r0.done,
  };

  const env = m.env.length ? m.env : c.url ? [{ label: 'Production', url: c.url, health: 'Healthy' }] : [];

  return {
    mode,
    plan,
    hasHours,
    hasSla,
    planLabel: PLAN_TYPE_LABEL[c.type],
    health: { uptime: m.uptime, incident: m.inc, window: c.win || 'None planned', version: m.ver, deployed: m.dep },
    hours: {
      used: hm(used),
      quota: `${c.hours}h`,
      left: over ? `${hm(used - c.hours)} over plan` : `${hm(left)} left this month`,
      leftColor: over ? colors.danger : colors.tealInk,
      pct: Math.min(100, (used / (c.hours || 1)) * 100),
      rollLabel: c.roll === 'roll' ? 'Unused hours roll over 1 month' : 'Unused hours expire monthly',
      overLabel: c.over === 'bill' ? 'Extra hours billed hourly' : 'Extra work quoted first',
      bars: m.hist.map(([month, h]) => ({ month, hours: hm(h), pct: (h / mx) * 100, over: hasHours && h > c.hours })),
      planLinePct: ((c.hours || 0) / mx) * 100,
      toQuote: openReqs.filter((r) => r.outside).length,
    },
    sla: {
      cover: c.cover,
      resp: c.resp,
      fix: c.fix,
      onTime: requests.length ? `${requests.filter((r) => !r.risk).length} of ${requests.length} on time` : 'No requests yet',
      renew: shY(c.renew),
    },
    requests: mode === 'client' ? requests : openReqs,
    myRequests: openReqs.filter((r) => r.as && r.as === person?.name),
    openCount: openReqs.length,
    tasks: mode === 'client' ? [] : mode === 'ic' ? tasks.filter((t) => t.mine) : tasks,
    environments: env,
    releases: m.rel,
    report,
    until: plan ? shY(plan.renew) : p?.sup ? shY(p.sup.until) : 'Not set',
    liveSince: plan ? shY(plan.start) : p?.deliv ? shY(p.deliv) : '',
  };
}

/** Short month label for the toast ("Sep report downloaded"). */
export const reportToast = {
  downloaded: (m: string) => `${m} report downloaded`,
  sent: (m: string) => `${m} report sent to client`,
};
