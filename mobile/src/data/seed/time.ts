import { WEEK_MONDAY } from '../clock';
import { addD } from '../format';
import type { TimeEntry } from '../types';

const W = WEEK_MONDAY;
type Tpl = [proj: string, key: string, task: string, bill: boolean];

/** Demo owner marker: these entries belong to whoever is signed in (v5 `mine`). */
export const ANY_USER = '*';

const mine = (id: number, date: string, proj: string, key: string, task: string, min: number, bill: boolean, note = ''): TimeEntry => ({
  id, who: ANY_USER, date, proj, key, task, min, bill, note,
});

/** v5 `E0`: this week (9) plus 30 generated entries for the 3 earlier weeks (mostly project-level work). */
function myEntries(): TimeEntry[] {
  const L: TimeEntry[] = [
    mine(1, addD(W, 0), 'c:dacop', 'PMT-10', 'Login with BankID', 180, true, 'Token refresh flow'),
    mine(2, addD(W, 0), 'x:admin', '', 'Weekly planning', 60, false),
    mine(3, addD(W, 1), 'c:dacop', 'PMT-10', 'Login with BankID', 240, true),
    mine(4, addD(W, 1), 'c:dacop', 'PMT-20', 'Ticket import', 150, true, 'CSV mapping'),
    mine(5, addD(W, 2), 'i:i1', 'INT-3', 'Infra status settings', 210, false),
    mine(6, addD(W, 2), 'c:nordp', '', 'Client call', 45, true, 'Go-live date'),
    mine(7, addD(W, 3), 'c:dacop', 'PMT-11', 'Push notifications setup', 300, true),
    mine(8, addD(W, 4), 'c:dacop', 'PMT-20', 'Ticket import', 270, true, 'Tests'),
    mine(9, addD(W, 4), 'x:admin', '', 'Code review', 90, false),
  ];
  // Earlier weeks: mostly project-level work (reviews, calls, testing) with a little
  // ticket time, so per-ticket totals stay near their estimates.
  const tpl: Tpl[] = [
    ['c:dacop', '', 'Code review', true],
    ['c:nordp', 'NRD-4', 'Usage chart per meter', true],
    ['x:admin', '', 'Weekly planning', false],
    ['c:nordp', '', 'Client call', true],
    ['i:i1', 'INT-5', 'Follow-up reminders', false],
    ['c:dacop', '', 'Testing and QA', true],
    ['x:admin', '', 'Code review', false],
    ['c:dacop', '', 'Sprint ceremonies', true],
  ];
  // Ticket templates (1, 4) are used at most this many times in total.
  const cap: Record<number, number> = { 1: 2, 4: 1 };
  let id = 100;
  for (let w = 1; w <= 3; w++)
    for (let d = 0; d < 5; d++) {
      const day = addD(W, -7 * w + d);
      for (const [i, min] of [
        [(w * 5 + d) % tpl.length, 180 + ((w + d) % 4) * 45],
        [(w * 3 + d + 2) % tpl.length, 120 + ((w * d) % 3) * 30],
      ]) {
        let t = i;
        if (t in cap) {
          if (cap[t] > 0) cap[t]--;
          else t = 0;
        }
        const a = tpl[t];
        L.push(mine(id++, day, a[0], a[1], a[2], a[1] ? Math.min(min, 90) : min, a[3]));
      }
    }
  return L;
}

/** Ticket work of a person: `min` minutes per day from weekday `from` of week `w` (0 = this week). */
interface TicketWork {
  t: Tpl;
  w: number;
  from: number;
  min: number[];
}

interface TeamPlan {
  /** working weekdays (0 = Mon) */
  days: number[];
  /** day length in minutes for week w, weekday d */
  day: (w: number, d: number) => number;
  /** ticket time, kept near each ticket's estimate */
  work: TicketWork[];
  /** project-level and admin work that fills the rest of the day (key '') */
  fill: Tpl[];
}

const tk = (proj: string, key: string, task: string, bill = true): Tpl => [proj, key, task, bill];
const tx = (proj: string, task: string, bill = proj !== 'x:admin' && !proj.startsWith('i:')): Tpl => [proj, '', task, bill];
const WEEKDAYS = [0, 1, 2, 3, 4];
/** Employees: 6h–8h a day (about 32–38h a week). */
const staffDay = (seed: number) => (w: number, d: number) => 360 + ((seed * 3 + w * 5 + d * d * 2 + d) % 7) * 20;

/**
 * Team plans (v5 `TEAM_E`, reworked): per-ticket time stays plausible against the
 * estimates (most tickets under or near, a few modestly over), while each person's week
 * stays realistic (employees 32–38h, the freelancer Sofia about 20h on four days). The
 * rest of the day is project-level work without a ticket (reviews, calls, testing,
 * meetings), so dashboard, timesheet and project totals all come from these entries.
 */
const TEAM: Record<string, TeamPlan> = {
  Rahul: {
    days: WEEKDAYS,
    day: staffDay(0),
    work: [
      { t: tk('c:dacop', 'PMT-22', 'Time logging'), w: 2, from: 1, min: [120, 90, 90] },
      { t: tk('i:i1', 'INT-5', 'Follow-up reminders', false), w: 1, from: 2, min: [60, 60] },
      { t: tk('i:i1', 'INT-5', 'Follow-up reminders', false), w: 0, from: 1, min: [60] },
      { t: tk('c:dacop', 'PMT-20', 'Ticket import'), w: 0, from: 3, min: [30] },
    ],
    fill: [tx('c:dacop', 'Client follow-up'), tx('x:admin', 'Sales and estimates'), tx('c:dacop', 'Architecture review'), tx('x:admin', 'Weekly planning'), tx('i:i1', 'DevOps board upkeep')],
  },
  Vivek: {
    days: WEEKDAYS,
    day: staffDay(1),
    work: [
      { t: tk('i:i1', 'INT-3', 'Infra status settings', false), w: 1, from: 3, min: [60] },
      { t: tk('c:fjp', 'FJD-3', 'Route sync fails on iOS 18'), w: 0, from: 2, min: [90, 60] },
    ],
    fill: [tx('c:fjp', 'Support and monitoring'), tx('x:admin', 'Team management'), tx('i:i1', 'Platform maintenance'), tx('c:fjp', 'Release checks'), tx('x:admin', 'Hiring interviews')],
  },
  'Bhavana P': {
    days: WEEKDAYS,
    day: staffDay(2),
    work: [
      { t: tk('c:nordp', 'NRD-4', 'Usage chart per meter'), w: 2, from: 2, min: [60, 60] },
      { t: tk('c:nordp', 'NRD-4', 'Usage chart per meter'), w: 1, from: 1, min: [60, 60] },
      { t: tk('c:nordp', 'NRD-7', 'Go-live with pilot customers'), w: 0, from: 0, min: [90, 60, 60] },
    ],
    fill: [tx('c:nordp', 'Project management'), tx('c:dacop', 'Sprint planning'), tx('c:nordp', 'Client meeting'), tx('x:admin', 'Status reports'), tx('c:dacop', 'Backlog grooming')],
  },
  Sofia: {
    days: [0, 1, 2, 3],
    day: (w, d) => 270 + ((w + d) % 3) * 30,
    work: [
      { t: tk('c:dacop', 'PMT-14', 'Onboarding screens'), w: 2, from: 0, min: [120, 120, 90] },
      { t: tk('c:dacop', 'PMT-15', 'App icon and splash'), w: 2, from: 3, min: [90] },
      { t: tk('c:dacop', 'PMT-14', 'Onboarding screens'), w: 1, from: 0, min: [60] },
      { t: tk('c:dacop', 'PMT-15', 'App icon and splash'), w: 1, from: 1, min: [60] },
      { t: tk('c:dacop', 'PMT-21', 'Sprint planning view'), w: 0, from: 2, min: [60] },
    ],
    fill: [tx('c:dacop', 'UI components'), tx('c:dacop', 'Design QA'), tx('c:dacop', 'Frontend fixes')],
  },
  Arjun: {
    days: WEEKDAYS,
    day: staffDay(3),
    work: [],
    fill: [tx('x:admin', 'Infra maintenance', false), tx('c:dacop', 'Staging environment'), tx('x:admin', 'Monitoring and alerts', false), tx('c:fjp', 'Backups and restores')],
  },
  Chary: {
    days: WEEKDAYS,
    day: staffDay(4),
    work: [
      { t: tk('c:nordp', 'NRD-4', 'Usage chart per meter'), w: 2, from: 3, min: [60] },
      { t: tk('c:dacop', 'PMT-10', 'Login with BankID'), w: 1, from: 3, min: [30] },
      { t: tk('c:dacop', 'PMT-11', 'Push notifications setup'), w: 0, from: 4, min: [60] },
    ],
    fill: [tx('c:dacop', 'Code review'), tx('c:dacop', 'Mobile release prep'), tx('c:nordp', 'Bug triage'), tx('x:admin', 'Stand-ups and planning'), tx('c:dacop', 'Device testing')],
  },
};

/** Generated team entries for this week and the two before it. */
function teamEntries(): TimeEntry[] {
  const L: TimeEntry[] = [];
  let id = 5000;
  Object.entries(TEAM).forEach(([who, plan], pi) => {
    for (let w = 2; w >= 0; w--)
      for (const d of plan.days) {
        const date = addD(W, -7 * w + d);
        let left = plan.day(w, d);
        const push = (t: Tpl, min: number) => L.push({ id: id++, who, date, proj: t[0], key: t[1], task: t[2], min, bill: t[3], note: '', team: true });
        for (const x of plan.work) {
          const min = x.w === w ? x.min[d - x.from] : undefined;
          if (min) {
            push(x.t, min);
            left -= min;
          }
        }
        // the rest of the day: one or two project-level entries
        const n = plan.fill.length;
        const k = pi + w * 3 + d;
        const first = left > 240 ? Math.round(left / 60) * 30 : left;
        push(plan.fill[k % n], first);
        if (left > first) push(plan.fill[(k + 2) % n], left - first);
      }
  });
  return L;
}

export const ENTRIES: TimeEntry[] = [...myEntries(), ...teamEntries()];
