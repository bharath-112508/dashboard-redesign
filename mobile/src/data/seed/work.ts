import { ANY_USER, type Leave, type Question, type TimeEntry } from '../types';

/** Client questions (prototype Q0). */
export const QUESTIONS_SEED: Question[] = [
  {
    id: 1, title: 'Which languages at launch?',
    text: 'Should the app ship with Norwegian and English only, or also Swedish? It changes the copy work for Sprint 3.',
    by: 'Rahul', when: '2 days ago', tk: 'PMT-10', att: ['language-switcher.png'],
    msgs: [{ side: 'vt', who: 'Rahul', t: 'Added the language switcher mockup, see the attachment.', when: '2 days ago' }],
    solved: false,
  },
  {
    id: 2, title: 'Logo files for the app icon', text: 'We need the final logo for the app icon and splash screen.',
    by: 'Chary', when: '3 days ago', tk: 'PMT-08', att: [],
    msgs: [
      { side: 'client', who: 'Ingrid Solberg', t: 'Use the new version from the brand folder.', when: 'Yesterday' },
      { side: 'vt', who: 'Chary', t: 'Got it. Can you send it as SVG?', when: '2h ago' },
      { side: 'vt', who: 'Chary', t: 'The dark variant too, please.', when: '1h ago' },
    ],
    solved: false,
  },
  {
    id: 3, title: 'Push notification texts', text: 'Please confirm the wording for the five push messages.',
    by: 'Vivek', when: '1 week ago', tk: 'PMT-11', att: ['push-copy.pdf'],
    msgs: [{ side: 'client', who: 'Ingrid Solberg', t: 'Approved as written.', when: '5 days ago' }],
    solved: true,
  },
];

/** Leave and comp-off requests (prototype L0). */
export const LEAVES_SEED: Leave[] = [
  { id: 1, who: 'Chary', type: 'Leave', from: '2026-10-24', to: '2026-10-25', reason: 'Family visit', st: 'Approved' },
  { id: 2, who: 'Chary', type: 'Comp-off', from: '2026-10-04', to: '2026-10-04', reason: 'Worked Saturday on the release', st: 'Pending' },
  { id: 3, who: 'Chary', type: 'Leave', from: '2026-09-12', to: '2026-09-12', reason: 'Sick', st: 'Approved' },
  { id: 4, who: 'Vivek', type: 'Leave', from: '2026-10-30', to: '2026-10-31', reason: 'Diwali', st: 'Pending' },
  { id: 5, who: 'Bhavana P', type: 'Comp-off', from: '2026-10-11', to: '2026-10-11', reason: 'Weekend deployment', st: 'Pending' },
  { id: 6, who: 'Ganesh', type: 'Leave', from: '2026-11-03', to: '2026-11-05', reason: 'Travel', st: 'Pending' },
  { id: 7, who: 'Rahul', type: 'Leave', from: '2026-12-22', to: '2026-12-31', reason: 'Christmas', st: 'Approved' },
];

type Row = [d: string, tk: number | null, text: string, h: number, bill: boolean, note: string];

const ENTRY_ROWS: Row[] = [
  ['2026-10-05', 1, '', 4, true, 'Token refresh flow'],
  ['2026-10-05', 8, '', 3.5, true, 'Final onboarding polish'],
  ['2026-10-06', 1, '', 3, true, 'Android testing'],
  ['2026-10-06', null, 'Sprint planning', 1, false, ''],
  ['2026-10-06', 2, '', 2, true, 'CSV parser'],
  ['2026-10-07', 4, '', 5, true, 'BankID sandbox'],
  ['2026-10-07', 2, '', 3, true, 'Field mapping'],
  ['2026-10-08', 3, '', 4, true, 'Review fixes'],
  ['2026-10-08', null, 'Code review', 1.5, false, ''],
  ['2026-10-09', 1, '', 2, true, 'Duplicate push on Android'],
];

/** This week's time entries (prototype E0). Owned by ANY_USER: every account sees them. */
export const ENTRIES_SEED: TimeEntry[] = ENTRY_ROWS.map(([d, tk, text, h, bill, note], i) => ({
  id: i + 1, d, tk, text, h, bill, note, who: ANY_USER,
}));

/**
 * Team hours base for the current week (prototype TEAMH): [logged, billable].
 * Team hours add the hours people log in the app on top; see selectors/time.ts.
 */
export const TEAM_WEEK_BASE: Record<string, [logged: number, billable: number]> = {
  Rahul: [34, 22],
  'Bhavana P': [39.5, 33],
  Vivek: [36, 18],
  Chary: [37.5, 33.5],
  Arjun: [24, 24],
  Ganesh: [31, 20],
};
