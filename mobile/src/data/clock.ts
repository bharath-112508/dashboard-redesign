/**
 * The app's fixed clock. The seed data is anchored on the prototype's date, so every
 * due date, week and "today" label is computed from TODAY (never from `new Date()`).
 * The greeting is the only thing that uses the real time of day (DECISIONS.md 7).
 */
export const TODAY = '2026-10-10';

/** Monday of the current week (TODAY is a Saturday). */
export const WEEK_MONDAY = '2026-10-05';

/** Weekly hour target for staff (freelancers have none). */
export const WEEK_TARGET_HOURS = 40;

/** "Good morning" / "Good afternoon" / "Good evening" from the device clock. */
export function greetingFor(date: Date = new Date()): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
