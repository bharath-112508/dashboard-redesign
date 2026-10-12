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

/** v5 `E0`: this week (9) plus 30 generated entries for the 3 earlier weeks. */
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
  const tpl: Tpl[] = [
    ['c:dacop', 'PMT-12', 'Profile and settings', true],
    ['c:dacop', 'PMT-21', 'Sprint planning view', true],
    ['x:admin', '', 'Weekly planning', false],
    ['c:nordp', 'NRD-4', 'Usage chart per meter', true],
    ['i:i1', 'INT-5', 'Follow-up reminders', false],
    ['x:admin', '', 'Code review', false],
  ];
  let id = 100;
  for (let w = 1; w <= 3; w++)
    for (let d = 0; d < 5; d++) {
      const day = addD(W, -7 * w + d);
      const a = tpl[(w * 5 + d) % tpl.length];
      const b = tpl[(w * 3 + d + 2) % tpl.length];
      L.push(mine(id++, day, a[0], a[1], a[2], 180 + ((w + d) % 4) * 45, a[3]));
      L.push(mine(id++, day, b[0], b[1], b[2], 120 + ((w * d) % 3) * 30, b[3]));
    }
  return L;
}

/** v5 `TEAM_E`: 6 people × 3 weeks × weekdays × 2 tasks. */
function teamEntries(): TimeEntry[] {
  const P: Record<string, Tpl[]> = {
    Rahul: [['c:dacop', 'PMT-20', 'Ticket import', true], ['i:i1', 'INT-5', 'Follow-up reminders', false]],
    Vivek: [['c:fjp', 'FJD-3', 'Route sync fails on iOS 18', true], ['i:i1', 'INT-3', 'Infra status settings', false]],
    'Bhavana P': [['c:nordp', 'NRD-4', 'Usage chart per meter', true], ['c:nordp', 'NRD-7', 'Go-live with pilot customers', true]],
    Sofia: [['c:dacop', 'PMT-21', 'Sprint planning view', true], ['c:dacop', 'PMT-14', 'Onboarding screens', true]],
    Arjun: [['x:admin', '', 'Infra maintenance', false], ['c:dacop', '', 'Staging environment', true]],
    Chary: [['c:dacop', 'PMT-11', 'Push notifications setup', true], ['c:dacop', 'PMT-10', 'Login with BankID', true]],
  };
  const L: TimeEntry[] = [];
  let id = 5000;
  Object.entries(P).forEach(([who, tk], wi) => {
    for (let w = 0; w < 3; w++)
      for (let d = 0; d < 5; d++) {
        const date = addD(W, -7 * w + d);
        tk.forEach((t, ti) =>
          L.push({ id: id++, who, date, proj: t[0], key: t[1], task: t[2], min: 150 + ((wi + d + ti + w) % 4) * 45, bill: t[3], note: '', team: true }),
        );
      }
  });
  return L;
}

export const ENTRIES: TimeEntry[] = [...myEntries(), ...teamEntries()];
