import type { Ticket } from '../types';

/** Tickets (prototype T0, DATA.md §1.2), verbatim. */
export const TICKETS_SEED: Ticket[] = [
  {
    id: 1, key: 'PMT-11', title: 'Push notifications setup', proj: 'Daco platform', epic: 'Mobile app', sprint: 'Sprint 2',
    type: 'Story', st: 'prog', prio: 'Critical', due: '2026-10-07', est: 6, hrs: 9, as: ['Chary'], subs: [1, 3],
    desc: 'Send push notifications on every status change. iOS works; Android receives duplicates after token refresh.',
    att: [],
    comments: [
      { who: 'Vivek', t: 'Push is the last blocker for the Sprint 2 demo. Can we pair on it today?', when: '2h ago' },
      { who: 'Chary', t: 'Yes. The Android token refresh is the issue, fix goes to review this afternoon.', when: '12 min ago' },
    ],
  },
  {
    id: 2, key: 'PMT-20', title: 'Ticket import', proj: 'Daco platform', epic: 'Web app', sprint: 'Sprint 1',
    type: 'Task', st: 'prog', prio: 'High', due: '2026-10-09', est: 6, hrs: 8, as: ['Rahul', 'Chary'], subs: [0, 2],
    desc: 'Import existing tickets from the old spreadsheet as CSV.', att: [], comments: [],
  },
  {
    id: 3, key: 'DIN-5', title: 'Single sign-on with Azure AD', proj: 'Daco intranet', epic: 'Single sign-on', sprint: 'Sprint 3',
    type: 'Story', st: 'review', prio: 'Urgent', due: '2026-10-10', est: 8, hrs: 7, as: ['Vivek', 'Chary'],
    desc: 'Staff log in with their Microsoft account. Guests keep email login.', att: [],
    comments: [{ who: 'Vivek', t: 'Moved to review. Bhavana, can you check the token handling?', when: '1h ago' }],
  },
  {
    id: 4, key: 'PMT-10', title: 'Login with BankID', proj: 'Daco platform', epic: 'Mobile app', sprint: 'Sprint 2',
    type: 'Story', st: 'prog', prio: 'High', due: '2026-10-13', est: 10, hrs: 6, as: ['Chary', 'Arjun'], subs: [2, 4],
    desc: 'Clients log in with BankID on mobile. Fallback to email code.', att: [], comments: [],
  },
  {
    id: 5, key: 'NRD-9', title: 'Invoice PDF shows wrong VAT', proj: 'Nordlys portal', epic: 'Billing', sprint: 'Sprint 4',
    type: 'Bug', st: 'todo', prio: 'Critical', due: '2026-10-14', est: 3, hrs: 0, as: ['Arjun'],
    desc: 'VAT is calculated on the net amount twice for business customers.', att: ['invoice-oct.pdf'], comments: [],
  },
  {
    id: 6, key: 'PMT-22', title: 'Time logging per ticket', proj: 'Daco platform', epic: 'Web app', sprint: 'Sprint 1',
    type: 'Task', st: 'todo', prio: 'Medium', due: '2026-10-16', est: 5, hrs: 1, as: ['Chary'],
    desc: 'Log hours from the ticket and show them in the timesheet.', att: [], comments: [],
  },
  {
    id: 7, key: 'FJL-3', title: 'Offline route cache', proj: 'Fjordline app', epic: 'Route planning', sprint: 'Sprint 1',
    type: 'Task', st: 'todo', prio: 'Medium', due: '2026-10-22', est: 12, hrs: 0, as: ['Arjun'],
    desc: 'Drivers see the day’s routes without signal.', att: [], comments: [],
  },
  {
    id: 8, key: 'PMT-08', title: 'Onboarding screens', proj: 'Daco platform', epic: 'Mobile app', sprint: 'Sprint 1',
    type: 'Story', st: 'done', prio: 'Medium', due: '2026-10-08', est: 8, hrs: 7.5, as: ['Chary'], subs: [3, 3],
    desc: 'Three onboarding screens before login.', att: [], comments: [],
  },
  {
    id: 9, key: 'PMT-34', title: 'Login button hidden on small phones', proj: 'Daco platform', epic: 'Mobile app', sprint: 'Sprint 2',
    type: 'Bug', st: 'todo', prio: 'High', due: '2026-10-15', est: 2, hrs: 0, as: ['Chary'],
    client: true, reporter: 'Ingrid Solberg', raised: '2026-10-09',
    desc: 'On iPhone SE the login button sits under the keyboard, so you cannot tap it.', att: ['iphone-se-login.png'],
    comments: [
      { who: 'Ingrid Solberg', t: 'Happens every time on my iPhone SE.', when: 'Yesterday' },
      { who: 'Chary', t: 'Reproduced. We will move the button above the keyboard this sprint.', when: '3h ago' },
    ],
  },
  {
    id: 10, key: 'PMT-35', title: 'Push arrives twice on Android', proj: 'Daco platform', epic: 'Mobile app', sprint: 'Sprint 2',
    type: 'Bug', st: 'prog', prio: 'Medium', due: '2026-10-17', est: 3, hrs: 1, as: ['Arjun'],
    client: true, reporter: 'Lars Moen', raised: '2026-10-08',
    desc: 'Every status change notification arrives twice on a Pixel 7.', att: ['pixel-notifications.png'],
    comments: [{ who: 'Lars Moen', t: 'Every status change arrives twice on my Pixel.', when: '2 days ago' }],
  },
  {
    id: 11, key: 'OPS-14', title: 'Staging environment for Nordlys', proj: 'Nordlys portal', epic: 'Infra', sprint: 'Ops',
    type: 'Task', st: 'prog', prio: 'High', due: '2026-10-12', est: 4, hrs: 2, as: ['Ganesh'],
    desc: 'Create the staging environment and share the URL with the client.', att: [], comments: [],
  },
  {
    id: 12, key: 'OPS-15', title: 'CI pipeline for Fjordline app', proj: 'Fjordline app', epic: 'Infra', sprint: 'Ops',
    type: 'Task', st: 'todo', prio: 'Medium', due: '2026-10-20', est: 6, hrs: 0, as: ['Ganesh'],
    desc: 'Build and test on every pull request, deploy main to staging.', att: [], comments: [],
  },
];
