/**
 * The demo clock. Every "today" in the app comes from here (SPEC: TODAY = '2026-10-10',
 * a Saturday). Change it in this one place.
 */
export const TODAY = '2026-10-10';

/** Monday of TODAY's week. */
export const WEEK_MONDAY = '2026-10-05';

/** Required minutes per weekday and per week (staff; freelancers have no target). */
export const DAY_MIN = 480;
export const WEEK_MIN = 2400;

/** The demo password (DECISIONS 7). A person with a `pwHash` signs in with their own. */
export const DEMO_PASSWORD = 'demo';
