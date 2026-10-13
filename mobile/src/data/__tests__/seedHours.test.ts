import { describe, expect, it } from '@jest/globals';

import { WEEK_MONDAY } from '../clock';
import { addD } from '../format';
import { entriesAll, entriesBetween, loggedMin, sumMin, weekBars } from '../selectors';
import { harness } from './helpers';

const STAFF = ['Rahul', 'Vivek', 'Bhavana P', 'Chary', 'Arjun'];
const week = (w: number) => [addD(WEEK_MONDAY, -7 * w), addD(WEEK_MONDAY, -7 * w + 6)] as const;

// Sample hours must look plausible (product owner): per-ticket time near the estimates,
// weekly totals realistic, and every view computed from the same entries.
describe('seed hours', () => {
  // Rahul sees every generated team entry plus the demo-owner entries: the largest totals.
  for (const pid of [1, 3]) {
    it(`per-ticket logged time stays near the estimate (signed in as ${pid})`, () => {
      const s = harness(pid).get();
      const est = s.tickets.filter((t) => t.est > 0);
      const ratio = est.map((t) => loggedMin(s, t.key) / 60 / t.est);
      expect(Math.max(...ratio)).toBeLessThanOrEqual(1.3);
      expect(ratio.filter((r) => r > 1).length).toBeLessThanOrEqual(5);
      expect(ratio.filter((r) => r <= 1).length).toBeGreaterThanOrEqual(est.length - 5);
      // tickets without an estimate get no time
      expect(s.tickets.filter((t) => !t.est).every((t) => loggedMin(s, t.key) === 0)).toBe(true);
    });
  }

  it('PMT-11 shows 6h of 6h (was 60h 30m)', () => {
    expect(loggedMin(harness(1).get(), 'PMT-11')).toBe(360);
  });

  it('full weeks: employees 30–40h, the freelancer about 20h', () => {
    const s = harness(1).get();
    for (const w of [1, 2]) {
      const [from, to] = week(w);
      for (const who of STAFF.filter((n) => n !== 'Rahul')) {
        const h = sumMin(entriesBetween(s, from, to, who)) / 60;
        expect(h).toBeGreaterThanOrEqual(30);
        expect(h).toBeLessThanOrEqual(40);
      }
      const sofia = sumMin(entriesBetween(s, from, to, 'Sofia')) / 60;
      expect(sofia).toBeGreaterThanOrEqual(15);
      expect(sofia).toBeLessThan(25);
    }
  });

  it('week bars and entry lists agree (dashboard and timesheet use the same entries)', () => {
    const s = harness(1).get();
    const [from, to] = week(0);
    const bars = weekBars(s, from, null, { idle: false });
    expect(sumMin(bars.map((b) => ({ min: b.billMin + b.nonMin })))).toBe(sumMin(entriesBetween(s, from, to)));
    const mine = weekBars(s, from, 'Rahul', { idle: false });
    expect(sumMin(mine.map((b) => ({ min: b.billMin + b.nonMin })))).toBe(sumMin(entriesAll(s).filter((e) => e.who === 'Rahul' && e.date >= from && e.date <= to)));
  });
});
