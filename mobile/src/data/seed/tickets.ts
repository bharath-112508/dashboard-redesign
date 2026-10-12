import type { Comment, FileRef, Subtask, Ticket, TicketPrio, TicketStatus, TicketType } from '../types';

const c = (who: string, t: string, when: string): Comment => ({ who, t, when });

interface RawTicket {
  key: string;
  t: string;
  proj: string;
  epic: string;
  sprint: string | null;
  type: TicketType;
  st: TicketStatus;
  prio: TicketPrio;
  start?: string;
  due?: string;
  est: number;
  as: string[];
  subs?: { t: string; done: boolean }[];
  desc?: string;
  att?: FileRef[];
  blk?: string[];
  unread?: number;
  comments?: Comment[];
  client?: boolean;
  support?: 'problem' | 'change';
}

/** Subtasks get stable ids "<KEY>.s<n>" (A-11). */
function ticket(r: RawTicket): Ticket {
  const subs: Subtask[] = (r.subs ?? []).map((s, i) => ({
    id: `${r.key}.s${i + 1}`,
    title: s.t,
    st: s.done ? 'done' : 'todo',
    as: '',
    due: '',
    note: '',
    comments: [],
  }));
  return {
    key: r.key,
    title: r.t,
    projectId: r.proj,
    epicId: r.epic,
    sprintId: r.sprint,
    type: r.type,
    st: r.st,
    prio: r.prio,
    start: r.start,
    due: r.due,
    est: r.est,
    as: r.as,
    subs,
    desc: r.desc ?? '',
    att: r.att ?? [],
    blk: r.blk ?? [],
    unread: r.unread ?? 0,
    comments: r.comments ?? [],
    client: r.client,
    support: r.support,
    subSeq: subs.length + 1,
  };
}

/**
 * Tickets (v5 `T0`, 18). The i1 tickets use the INT prefix (A-13; v5 had OPS-3/OPS-5,
 * which clashed with DevOps keys).
 */
const RAW: RawTicket[] = [
  { key: 'PMT-11', t: 'Push notifications setup', proj: 'dacop', epic: 'mob', sprint: 'm2', type: 'Task', st: 'prog', prio: 'Critical', start: '2026-10-05', due: '2026-10-07', est: 6, as: ['Chary'], subs: [{ t: 'iOS push certificates', done: true }, { t: 'Android token refresh', done: false }, { t: 'Status-change triggers', done: false }], desc: 'Send push notifications on every status change. iOS works; Android receives duplicates after token refresh.', att: [{ n: 'android-log.txt', size: '14 KB', when: '2026-10-08' }], unread: 2, comments: [c('Vivek', 'Push is the last blocker for the Sprint 2 demo. Can we pair on it today?', '2h ago'), c('Chary', 'Yes. The Android token refresh is the issue, fix goes to review this afternoon.', '12 min ago')] },
  { key: 'PMT-10', t: 'Login with BankID', proj: 'dacop', epic: 'mob', sprint: 'm2', type: 'Story', st: 'review', prio: 'High', start: '2026-10-05', due: '2026-10-15', est: 8, as: ['Chary'], subs: [{ t: 'Test environment', done: true }, { t: 'Redirect handling', done: true }], desc: 'Sign in with BankID on iOS and Android. Waiting for the client to confirm the staging environment.', comments: [c('Rahul', 'Asked Daco which BankID environment to use for staging.', '3 days ago')] },
  { key: 'PMT-12', t: 'Profile and settings', proj: 'dacop', epic: 'mob', sprint: 'm2', type: 'Story', st: 'todo', prio: 'Medium', start: '2026-10-12', due: '2026-10-14', est: 5, as: ['Chary', 'Rahul'], subs: [{ t: 'Profile screen', done: false }, { t: 'Notification settings', done: false }, { t: 'Language picker', done: false }], desc: 'Profile page with photo, contact details and notification settings.', blk: ['PMT-10'], unread: 1, comments: [c('Bhavana P', 'Copy for the onboarding is with the client for approval.', 'today')] },
  { key: 'PMT-31', t: 'Crash when opening a task offline', proj: 'dacop', epic: 'mob', sprint: 'm2', type: 'Bug', st: 'todo', prio: 'High', due: '2026-10-17', est: 3, as: ['Chary'], desc: 'Reported by the client. The app goes white when a task is opened without signal.', client: true },
  { key: 'PMT-14', t: 'Onboarding screens', proj: 'dacop', epic: 'mob', sprint: 'm1', type: 'Story', st: 'done', prio: 'Medium', due: '2026-10-03', est: 6, as: ['Sofia'] },
  { key: 'PMT-15', t: 'App icon and splash', proj: 'dacop', epic: 'mob', sprint: 'm1', type: 'Task', st: 'done', prio: 'Low', due: '2026-10-01', est: 2, as: ['Sofia'], att: [{ n: 'icon-source.svg', size: '22 KB', when: '2026-09-29' }] },
  { key: 'PMT-16', t: 'Offline task cache', proj: 'dacop', epic: 'mob', sprint: null, type: 'Story', st: 'todo', prio: 'Medium', est: 8, as: [], desc: 'Keep the last 50 tasks available without signal.' },
  { key: 'PMT-20', t: 'Ticket import', proj: 'dacop', epic: 'web', sprint: 'w3', type: 'Task', st: 'prog', prio: 'High', start: '2026-10-01', due: '2026-10-09', est: 6, as: ['Rahul', 'Chary'], subs: [{ t: 'CSV mapping', done: true }, { t: 'Validation errors', done: false }], desc: 'Import existing tickets from the old spreadsheet as CSV.', att: [{ n: 'tickets-export.csv', size: '88 KB', when: '2026-10-02' }] },
  { key: 'PMT-21', t: 'Sprint planning view', proj: 'dacop', epic: 'web', sprint: 'w3', type: 'Task', st: 'todo', prio: 'Medium', due: '2026-10-11', est: 5, as: ['Sofia'], blk: ['PMT-20'] },
  { key: 'PMT-22', t: 'Time logging', proj: 'dacop', epic: 'web', sprint: 'w3', type: 'Story', st: 'done', prio: 'Medium', due: '2026-10-06', est: 6, as: ['Rahul'] },
  { key: 'NRD-4', t: 'Usage chart per meter', proj: 'nordp', epic: 'n1', sprint: 'n1s', type: 'Task', st: 'prog', prio: 'Medium', due: '2026-10-10', est: 8, as: ['Bhavana P', 'Chary'], subs: [{ t: 'Hourly data', done: true }, { t: 'Chart', done: false }] },
  { key: 'NRD-7', t: 'Go-live with pilot customers', proj: 'nordp', epic: 'n1', sprint: 'n1s', type: 'Story', st: 'todo', prio: 'Critical', due: '2026-10-17', est: 12, as: ['Bhavana P'], subs: [{ t: 'Pilot list', done: true }, { t: 'DNS', done: false }, { t: 'Training', done: false }], desc: 'Waiting for DNS access from Nordlys.', unread: 1, comments: [c('Vivek', 'DNS access asked from Kari.', '2 days ago')] },
  { key: 'NRD-9', t: 'Billing API spec', proj: 'nordp', epic: 'n2', sprint: null, type: 'Task', st: 'todo', prio: 'Low', est: 4, as: [] },
  { key: 'FJD-3', t: 'Route sync fails on iOS 18', proj: 'fjp', epic: 'f1', sprint: null, type: 'Bug', st: 'prog', prio: 'High', due: '2026-10-13', est: 3, as: ['Vivek'], desc: 'Support request from Fjordline. Routes do not refresh after the iOS 18 update.', support: 'problem' },
  { key: 'FJD-4', t: 'Add Swedish translations', proj: 'fjp', epic: 'f2', sprint: null, type: 'Task', st: 'todo', prio: 'Medium', due: '2026-10-24', est: 4, as: ['Vivek'], desc: 'Change request from Fjordline.', support: 'change' },
  { key: 'INT-3', t: 'Infra status settings', proj: 'i1', epic: 'i1', sprint: 'i1s', type: 'Task', st: 'done', prio: 'Medium', due: '2026-10-07', est: 4, as: ['Vivek'] },
  { key: 'INT-5', t: 'Follow-up reminders', proj: 'i1', epic: 'i1', sprint: 'i1s', type: 'Task', st: 'prog', prio: 'High', due: '2026-10-14', est: 6, as: ['Rahul'], subs: [{ t: 'Client ladder', done: true }, { t: 'Internal ladder', done: false }] },
  { key: 'VW-1', t: 'Case study pages', proj: 'i2', epic: 'i2', sprint: null, type: 'Task', st: 'todo', prio: 'Low', due: '2026-11-14', est: 10, as: ['Sofia'] },
];

export const TICKETS: Ticket[] = RAW.map(ticket);
