import { describe, expect, it } from 'vitest';

import dayjs, { DATE_FORMAT, DEFAULT_TIMEZONE } from './date.js';

/**
 * `utils/date` is a 20-line file but it sets up the IST-timezone
 * defaults that the rest of the platform relies on. The contract
 * worth pinning at this layer:
 *
 *   1. `DEFAULT_TIMEZONE` is `'Asia/Kolkata'` — every IST-anchored
 *      computation in the codebase keys off this constant. A regression
 *      that flipped it to UTC would break attendance / leave / dashboard
 *      "today" math (the H1 audit fixed sites that previously used
 *      `getUTC*` instead of this).
 *   2. `DATE_FORMAT = 'YYYY-MM-DD'` — every API surface that emits or
 *      consumes a date-only field (leave start/end, attendance
 *      local_date, holiday date, etc.) uses this format.
 *   3. The `tz` plugin is loaded — `dayjs().tz('Asia/Kolkata')` works.
 *      A regression that dropped the plugin would surface here as
 *      `dayjs.tz is not a function` on import.
 *   4. `customParseFormat` + `isoWeek` plugins are loaded — used by
 *      report subscriptions and ISO-week timesheet rollups.
 */

describe('DEFAULT_TIMEZONE', () => {
    it('is the IST timezone used by every business-day calculation', () => {
        expect(DEFAULT_TIMEZONE).toBe('Asia/Kolkata');
    });
});

describe('DATE_FORMAT', () => {
    it('is the canonical date-only API format', () => {
        expect(DATE_FORMAT).toBe('YYYY-MM-DD');
    });

    it('round-trips a known UTC moment to the IST calendar date', () => {
        // 2026-04-23 UTC 00:00 = 2026-04-23 IST 05:30 (still same date).
        // Pin the format does what the API expects.
        const formatted = dayjs.utc('2026-04-23T00:00:00Z').tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);
        expect(formatted).toBe('2026-04-23');
    });

    it('correctly crosses the IST/UTC midnight boundary (the H1 bug area)', () => {
        // 2026-01-01 UTC 00:00 is 2026-01-01 IST 05:30 — same year.
        // 2026-01-01 IST 00:00 is 2025-12-31 UTC 18:30 — DIFFERENT year.
        // Pin that the IST projection sees the IST calendar, not UTC.
        const istNewYearMoment = dayjs.tz('2026-01-01 00:00', DEFAULT_TIMEZONE);
        expect(istNewYearMoment.year()).toBe(2026);
        // Same instant viewed in UTC is still the previous year.
        expect(istNewYearMoment.utc().year()).toBe(2025);
    });
});

describe('dayjs plugins', () => {
    it('utc plugin is loaded', () => {
        expect(typeof dayjs.utc).toBe('function');
        expect(dayjs.utc('2026-04-23T00:00:00Z').isValid()).toBe(true);
    });

    it('timezone plugin is loaded', () => {
        expect(typeof dayjs.tz).toBe('function');
        expect(dayjs.tz('2026-04-23 09:00', DEFAULT_TIMEZONE).isValid()).toBe(true);
    });

    it('customParseFormat plugin is loaded (used by report subscriptions)', () => {
        // The plugin enables the second-arg parse-format. Without it,
        // `dayjs('23/04/2026', 'DD/MM/YYYY')` would fall back to the
        // default ISO parser and produce an Invalid Date.
        expect(dayjs('23/04/2026', 'DD/MM/YYYY').isValid()).toBe(true);
        expect(dayjs('23/04/2026', 'DD/MM/YYYY').format(DATE_FORMAT)).toBe('2026-04-23');
    });

    it('isoWeek plugin is loaded (used by timesheet ISO-week rollups)', () => {
        // The plugin adds `.isoWeek()` to the dayjs prototype.
        const monday = dayjs.tz('2026-01-05', DEFAULT_TIMEZONE);
        expect(typeof monday.isoWeek).toBe('function');
        // Jan 5 2026 is Monday of ISO week 2.
        expect(monday.isoWeek()).toBe(2);
    });
});
