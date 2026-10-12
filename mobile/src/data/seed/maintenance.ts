import { TODAY } from '../clock';
import type { MaintData, MonthlyReport, UpkeepTask } from '../types';

/** Upkeep tasks past their due date start as done (prototype rule). */
function task(id: string, title: string, due: string, who: string): UpkeepTask {
  return { id, title, due, who, done: due < TODAY };
}

/** Maintenance data per live project (prototype MNT). SLA terms live on the plan. */
export const MAINTENANCE_SEED: Record<string, MaintData> = {
  'Daco website': {
    uptime: '99.96%', inc: '12 Sep · 14 min outage (DNS)', ver: 'v2.4.1', dep: '2 Oct',
    env: [
      { label: 'Production', url: 'daco.no', health: 'Healthy' },
      { label: 'Staging', url: 'staging.daco.no', health: 'Healthy' },
    ],
    hist: [['Jul', 8], ['Aug', 10.5], ['Sep', 7], ['Oct', 6]],
    req: [
      { id: 'WEB-41', t: 'Contact form not sending on Safari', type: 'Bug', prio: 'Blocking', st: 'prog', as: 'Chary', by: 'Ingrid Solberg', opened: '10 Oct', sla: 'Fix due 12 Oct', risk: false, hrs: 1.5, outside: false },
      { id: 'WEB-40', t: 'Add new office address to footer', type: 'Change', prio: 'Minor', st: 'todo', as: 'Bhavana P', by: 'Lars Moen', opened: '8 Oct', sla: 'Reply sent · in plan', risk: false, hrs: 0, outside: false },
      { id: 'WEB-38', t: 'Landing page for spring campaign', type: 'Change', prio: 'Minor', st: 'todo', as: '', by: 'Ingrid Solberg', opened: '7 Oct', sla: 'Estimate 12h · outside plan', risk: true, hrs: 0, outside: true },
      { id: 'WEB-36', t: 'Images slow on mobile', type: 'Bug', prio: 'Annoying', st: 'done', as: 'Chary', by: 'Lars Moen', opened: '29 Sep', sla: 'Fixed 2 Oct', risk: false, hrs: 3, outside: false },
    ],
    rel: [
      { v: 'v2.4.1', date: '2 Oct', text: 'Faster image loading on mobile. Cookie banner no longer covers the menu.' },
      { v: 'v2.4.0', date: '18 Sep', text: 'Security updates for the CMS. New careers page.' },
    ],
    tasks: [
      task('t1', 'Backup restore test', '2026-10-15', 'Ganesh'),
      task('t2', 'Renew SSL certificate', '2026-10-20', 'Ganesh'),
      task('t3', 'Monthly dependency updates', '2026-10-31', 'Chary'),
      task('t4', 'September report to client', '2026-10-05', 'Vivek'),
    ],
  },
  'Driver app': {
    uptime: '99.9%', inc: 'No incidents in 90 days', ver: 'v1.3.0', dep: '24 Sep',
    env: [
      { label: 'Production', url: 'App Store · Google Play', health: 'Healthy' },
      { label: 'API', url: 'api.fjordline.se', health: 'Healthy' },
    ],
    hist: [['Aug', 1], ['Sep', 4], ['Oct', 2.5]],
    req: [
      { id: 'DRV-12', t: 'Signature pad lags on older Android', type: 'Bug', prio: 'Annoying', st: 'review', as: 'Arjun', by: 'Ola Berg', opened: '6 Oct', sla: 'Fix due 13 Oct', risk: false, hrs: 2.5, outside: false },
    ],
    rel: [{ v: 'v1.3.0', date: '24 Sep', text: 'Proof-of-delivery photos upload in the background.' }],
    tasks: [
      task('d1', 'iOS SDK update check', '2026-10-25', 'Arjun'),
      task('d2', 'September report to client', '2026-10-05', 'Vivek'),
    ],
  },
};

/** Maintenance data for a project moved to maintenance in the app (prototype MEMPTY). */
export const EMPTY_MAINTENANCE: MaintData = {
  uptime: '—', inc: 'No incidents yet', ver: '—', dep: '—', env: [], hist: [], req: [], rel: [], tasks: [],
};

/** Closed monthly reports (prototype MREP). October is computed live. Static. */
export const REPORTS: Record<string, Record<string, MonthlyReport>> = {
  'Daco website': {
    Sep: {
      opened: 3, closed: 3, sla: '100%', up: '99.98%',
      done: ['Fixed WEB-36 · Images slow on mobile', 'Released v2.4.0 · CMS security updates, careers page', 'Backup restore test passed', 'Uptime monitoring moved to new provider'],
      split: [['Bugs', 3], ['Changes', 2.5], ['Upkeep', 1.5]],
    },
    Aug: {
      opened: 4, closed: 4, sla: '100%', up: '99.99%',
      done: ['Released v2.3.2 · Cookie banner update', 'Fixed WEB-33 · Search shows old pages', 'Monthly dependency updates'],
      split: [['Bugs', 4], ['Changes', 5], ['Upkeep', 1.5]],
    },
    Jul: {
      opened: 2, closed: 2, sla: '100%', up: '100%',
      done: ['Fixed WEB-30 · Broken link in footer', 'Monthly dependency updates'],
      split: [['Bugs', 2], ['Changes', 4.5], ['Upkeep', 1.5]],
    },
  },
  'Driver app': {
    Sep: {
      opened: 2, closed: 2, sla: '100%', up: '99.9%',
      done: ['Released v1.3.0 · Background photo upload', 'Fixed DRV-10 · Login loop on iOS 18'],
      split: [['Bugs', 3], ['Changes', 0], ['Upkeep', 1]],
    },
    Aug: {
      opened: 1, closed: 1, sla: '100%', up: '100%',
      done: ['Store listing updated'],
      split: [['Bugs', 0], ['Changes', 0], ['Upkeep', 1]],
    },
  },
};
