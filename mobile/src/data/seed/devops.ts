import type { DevopsProject, DevopsSettings } from '../types';

/** DevOps projects (prototype DV). Logs are newest first. */
export const DEVOPS_SEED: DevopsProject[] = [
  {
    p: 'Daco platform', co: 'Daco', phase: 'First project deployment', rem: 'Reminder 2', remIn: 3, est: '2026-10-24', ci: true,
    deps: [
      { v: '2.6.2', note: 'Bug fixes for ticket import', st: 'Live', day: 'Today' },
      { v: '2.6.1', note: 'Ticket import and BankID login', st: 'Live', day: 'Today' },
      { v: '2.6.0', note: 'Push notifications', st: 'Live', day: '9 Oct' },
      { v: '2.5.3', note: 'Profile settings', st: 'Rolled back', day: '8 Oct' },
      { v: '2.5.2', note: 'Performance fixes', st: 'Live', day: '6 Oct' },
      { v: '1.0.0', note: 'First go-live', st: 'Live', day: '28 Sep' },
    ],
    log: [
      ['8 Oct', 'Rahul', 'Staging deployed, waiting for client DNS.'],
      ['2 Oct', 'Ganesh', 'Tenant created in Azure.'],
    ],
  },
  {
    p: 'Nordlys portal', co: 'Nordlys Energi', phase: 'Client first tenant setup', rem: 'Reminder 1', remIn: 0, est: '2026-11-07', ci: false,
    deps: [], log: [['9 Oct', 'Ganesh', 'Sent tenant checklist to the client.']],
  },
  {
    p: 'Fjordline app', co: 'Fjordline Logistics', phase: 'CI/CD setup', rem: 'Reminder 3', remIn: -1, est: '2026-10-31', ci: false,
    deps: [], log: [['7 Oct', 'Ganesh', 'Pipeline draft ready, waiting for repo access.']],
  },
  {
    p: 'Fish health dashboard', co: 'Havbruk AS', phase: 'Client onboarding', rem: 'Reminder 1', remIn: 6, est: '2026-12-05', ci: false,
    deps: [], log: [['6 Oct', 'Vivek', 'Kick-off held, contracts signed.']],
  },
];

/** DevOps settings (prototype SEQ0, PH0, DST0 and the date-rule defaults). */
export const DEVOPS_SETTINGS_SEED: DevopsSettings = {
  seq: [
    { n: 'Reminder 1', d: 0 },
    { n: 'Reminder 2', d: 3 },
    { n: 'Reminder 3', d: 7 },
  ],
  rules: { skipWeekends: false, pauseOnClient: true, notifyPm: true },
  phases: ['Client onboarding', 'Client first tenant setup', 'First project deployment', 'CI/CD setup', 'Live'],
  statuses: ['Not started', 'In progress', 'Waiting on client', 'Done'],
  log: [],
};

/** Labels of the date rules (S-DVSET). */
export const DEVOPS_RULE_LABEL = {
  skipWeekends: 'Skip weekends',
  pauseOnClient: 'Pause while waiting on client',
  notifyPm: 'Notify project manager',
} as const;
