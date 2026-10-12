/**
 * Static demo values kept by A-1: numbers the app has no data for (hours sold per
 * project, working-hour capacity, uptime, SLA, incidents, support history, upkeep tasks,
 * check-in times). Screens label them as demo where they show them. Everything else on
 * the dashboard is computed from the store.
 */

/** Hours sold per client project ("Budget vs hours used"). */
export const BUDGET_HOURS: Record<string, number> = {
  dacop: 400,
  nordp: 240,
  fjp: 120,
  inoffi: 160,
  welop: 300,
  alnla: 200,
  arcf: 500,
  fatw: 120,
  osbyw: 260,
};

/** Working-hour capacity of the team this month ("Logged this month … / 704h"). */
export const MONTH_CAPACITY_H = 704;

/** Maintenance support demo figures (project Support tab). */
export const SUPPORT_DEMO = {
  uptime: '99.98%',
  incidents: 1,
  sla: '96%',
  /** support hours used per month, Jul–Oct */
  hoursByMonth: [
    { m: 'Jul', h: 8 },
    { m: 'Aug', h: 11 },
    { m: 'Sep', h: 9 },
    { m: 'Oct', h: 6 },
  ],
} as const;

/** Upkeep tasks on maintenance projects (dev / devops Support view). */
export const UPKEEP_TASKS = [
  { title: 'Monthly dependency updates', due: '2026-10-31', icon: 'refresh' },
  { title: 'Backup restore test', due: '2026-11-15', icon: 'hard-drive' },
] as const;

/**
 * Demo check-in for a person on weekday i (0 = Mon) of this week, as in v5: some days
 * have no check-in. Returns null for "No check-in".
 */
export function demoCheckIn(name: string, i: number): { in: string; out: string } | null {
  if ((name.length + i) % 5 === 4) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return { in: `${p(8 + (i % 2))}:${p(((i * 7) % 60) + 10)}`, out: `${16 + (i % 3)}:${p(((i * 11) % 50) + 10)}` };
}
