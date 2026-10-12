import type { Company, Contact, PortalPerm, Project, Sprint, SupportPlan } from '../types';

/** Support plans (prototype MCFG). */
export const PLANS_SEED: Record<string, SupportPlan> = {
  'Daco website': {
    type: 'both', hours: 10, roll: 'expire', over: 'bill', resp: '4 business hours', fix: '2 business days',
    cover: 'Business hours', start: '2026-05-15', renew: '2027-03-31', url: 'daco.no', win: 'Sun 19 Oct, 06:00–07:00', auto: true,
  },
  'Driver app': {
    type: 'sla', hours: 0, roll: 'expire', over: 'ask', resp: '1 business day', fix: '5 business days',
    cover: 'Business hours', start: '2026-08-30', renew: '2027-08-30', url: 'api.fjordline.se', win: '', auto: false,
  },
};

/** Defaults for a new support plan (S-PLAN). `start` is filled with TODAY by the caller. */
export const NEW_PLAN_DEFAULTS: Omit<SupportPlan, 'start'> = {
  type: 'both', hours: 10, roll: 'expire', over: 'ask', resp: '4 business hours', fix: '2 business days',
  cover: 'Business hours', renew: '2027-10-10', url: '', win: '', auto: true,
};

/** Projects (prototype CO), in company order. */
export const PROJECTS_SEED: Project[] = [
  { name: 'Daco platform', company: 'Daco', pct: 42, status: 'active', plan: null },
  { name: 'Daco intranet', company: 'Daco', pct: 68, status: 'active', plan: null },
  {
    name: 'Daco website', company: 'Daco', pct: 100, status: 'maint', deliv: '2026-05-15',
    sup: { until: '2027-03-31', used: 6, quota: 10 }, plan: PLANS_SEED['Daco website'],
  },
  { name: 'Nordlys portal', company: 'Nordlys Energi', pct: 55, status: 'active', plan: null },
  { name: 'Nordlys website', company: 'Nordlys Energi', pct: 100, status: 'done', deliv: '2026-06-30', plan: null },
  { name: 'Fjordline app', company: 'Fjordline Logistics', pct: 10, status: 'active', plan: null },
  {
    name: 'Driver app', company: 'Fjordline Logistics', pct: 100, status: 'maint', deliv: '2026-08-30',
    sup: { until: '2027-08-30', used: 2.5, quota: 10 }, plan: PLANS_SEED['Driver app'],
  },
  { name: 'Fish health dashboard', company: 'Havbruk AS', pct: 0, status: 'planned', plan: null },
];

/** Portal default: everything on, Timeline only for the client admin (S-COMPANY). */
function portal(role: Contact['role']): Record<PortalPerm, boolean> {
  return { Board: true, Timeline: role === 'Client admin', Questions: true, Bugs: true };
}

function contact(name: string, role: Contact['role'], email: string): Contact {
  return { name, role, email, portal: portal(role) };
}

/** Companies (prototype CO, CONT, COH). */
export const COMPANIES_SEED: Company[] = [
  {
    name: 'Daco', archived: false, hoursThisMonth: 142,
    contacts: [contact('Ingrid Solberg', 'Client admin', 'ingrid@daco.no'), contact('Lars Moen', 'Client user', 'lars@daco.no')],
  },
  { name: 'Nordlys Energi', archived: false, hoursThisMonth: 48.5, contacts: [contact('Kari Nordli', 'Client admin', 'kari@nordlys.no')] },
  { name: 'Fjordline Logistics', archived: false, hoursThisMonth: 12, contacts: [contact('Ola Berg', 'Client admin', 'ola@fjordline.no')] },
  { name: 'Havbruk AS', archived: false, hoursThisMonth: 3, contacts: [] },
];

/** The client portal's company (the only client account is Daco's). */
export const CLIENT_COMPANY = 'Daco';

/** Sprints (prototype SP). Epics are the distinct `e` values per project. Static. */
export const SPRINTS: Sprint[] = [
  { p: 'Daco platform', e: 'Mobile app', n: 'Sprint 1', st: 'done', a: '2026-09-21', b: '2026-10-04' },
  { p: 'Daco platform', e: 'Mobile app', n: 'Sprint 2', st: 'active', a: '2026-10-05', b: '2026-10-18' },
  { p: 'Daco platform', e: 'Mobile app', n: 'Sprint 3', st: 'planned', a: '2026-10-19', b: '2026-11-01' },
  { p: 'Daco platform', e: 'Web app', n: 'Sprint 1', st: 'active', a: '2026-10-05', b: '2026-10-18' },
  { p: 'Daco platform', e: 'Web app', n: 'Sprint 2', st: 'planned', a: '2026-10-19', b: '2026-11-01' },
  { p: 'Daco intranet', e: 'Single sign-on', n: 'Sprint 3', st: 'active', a: '2026-09-29', b: '2026-10-12' },
  { p: 'Nordlys portal', e: 'Billing', n: 'Sprint 4', st: 'active', a: '2026-10-06', b: '2026-10-17' },
  { p: 'Nordlys portal', e: 'Infra', n: 'Ops', st: 'active', a: '2026-10-01', b: '2026-10-31' },
  { p: 'Fjordline app', e: 'Route planning', n: 'Sprint 1', st: 'planned', a: '2026-10-13', b: '2026-10-26' },
  { p: 'Fjordline app', e: 'Infra', n: 'Ops', st: 'active', a: '2026-10-01', b: '2026-10-31' },
];
