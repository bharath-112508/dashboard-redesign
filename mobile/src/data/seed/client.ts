import type { ClientBug, ClientTeamMember, Comment, Question } from '../types';

/** Questions to clients (v5 `QS0`). Question 1's numeric task 10 is PMT-10. */
export const QUESTIONS: Question[] = [
  { id: 1, by: 'Rahul', title: 'Which languages at launch?', text: 'Should the app support only Swedish at launch, or English too? This decides how we set up translations for every screen.', when: '2 days ago', task: 'PMT-10', answer: '', projectId: 'dacop' },
  { id: 2, by: 'Chary', title: 'Logo files for the app icon', text: 'Can we use your existing logo files for the app icon, or do you have a new version? Please attach the source files (SVG or AI) if you have them.', when: 'yesterday', task: null, answer: 'Use the new version, we will send it this week.', answeredBy: 'Ingrid Solberg', projectId: 'dacop' },
  { id: 4, by: 'Rahul', title: 'Which BankID environment for staging?', text: 'We need to know whether to use the BankID test environment or your own staging tenant. This blocks PMT-10.', when: '3 days ago', task: 'PMT-10', answer: '', projectId: 'dacop' },
  { id: 7, by: 'Vivek', title: 'DNS access for portal domain', text: 'Please give us access to the DNS for portal.nordlys.no so we can set up the pilot.', when: '2 days ago', task: 'NRD-7', answer: '', projectId: 'nordp' },
];

/** Client bugs (v5 `BUGS0`), dates ISO (A-14), linked to their project (A-16). */
export const BUGS: ClientBug[] = [
  { id: 'cbm1', title: 'App freezes when I open a task offline', desc: 'On my iPhone 14, if I lose signal and open a task from the list, the screen goes white and the app stops responding. I have to close it and open it again.', atts: [], epicId: 'mob', projectId: 'dacop', when: '2026-10-08', by: 'Erik Nyström', st: 'prog' },
  { id: 'cbm2', title: 'BankID login loops back to the start screen', desc: 'After approving in the BankID app, I am sent back to the login screen instead of my projects. It happens about every second time.', atts: [], epicId: 'mob', projectId: 'dacop', when: '2026-10-09', by: 'Lars Moen', st: 'todo' },
  { id: 'cbm3', title: 'Wrong date format on invoices page', desc: 'Dates show as 10/09/2026. We use 9 Oct 2026 or 2026-10-09 in Sweden.', atts: [], epicId: 'web', projectId: 'dacop', when: '2026-10-07', by: 'Ingrid Solberg', st: 'done' },
];

export const BUG_CHAT: Record<string, Comment[]> = {};

/** Client team (v5 `CTEAM0`, web `ClientTeamMember`). */
export const CLIENT_TEAM: ClientTeamMember[] = [
  { id: 'ct1', companyId: 'daco', name: 'Anna Lindqvist', email: 'anna@daco.se', title: 'Project lead' },
  { id: 'ct2', companyId: 'daco', name: 'Erik Nyström', email: 'erik@daco.se', title: 'Field manager' },
];
