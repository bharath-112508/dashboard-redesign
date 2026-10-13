import { describe, expect, it } from 'vitest';

import logger, { formatMs } from './logger.js';

/**
 * `utils/logger` is mostly pino configuration (transport / redact).
 * The redaction list is the security-relevant bit but we can't
 * easily inspect pino's runtime redaction without rebuilding the
 * logger; the alternative is a static-string check on the source,
 * which is brittle.
 *
 * What we do pin:
 *   1. The default export is a callable pino logger (`info`, `warn`,
 *      `error`, `debug` exist). A regression that broke the import
 *      shape would surface every service file's logger calls as
 *      `logger.info is not a function`.
 *   2. `formatMs` produces human-readable durations across every
 *      bucket of the bucketing rule:
 *        - `< 1s`        → `${ms}ms`
 *        - `< 1min`      → `${s}s`
 *        - `< 1 hour`    → `${m} minute(s)`
 *        - `>= 1 hour`   → `${h} hour(s) [${rm}m]`
 *      Used in audit-archive + cron-summary log lines, so a regression
 *      would degrade the operator-facing log output silently.
 */

describe('logger default export', () => {
    it('exposes the standard pino log levels', () => {
        expect(typeof logger.info).toBe('function');
        expect(typeof logger.warn).toBe('function');
        expect(typeof logger.error).toBe('function');
        expect(typeof logger.debug).toBe('function');
    });
});

describe('formatMs', () => {
    it('milliseconds bucket — values under 1 second', () => {
        expect(formatMs(0)).toBe('0ms');
        expect(formatMs(1)).toBe('1ms');
        expect(formatMs(999)).toBe('999ms');
    });

    it('seconds bucket — values 1s to <60s', () => {
        expect(formatMs(1000)).toBe('1s');
        expect(formatMs(15_500)).toBe('15s'); // floored
        expect(formatMs(59_999)).toBe('59s');
    });

    it('minutes bucket — values 1min to <60min', () => {
        // Singular vs plural at 1 minute exactly.
        expect(formatMs(60_000)).toBe('1 minute');
        expect(formatMs(120_000)).toBe('2 minutes');
        expect(formatMs(59 * 60_000)).toBe('59 minutes');
    });

    it('hours bucket — singular form at exactly 1 hour, no remainder', () => {
        expect(formatMs(60 * 60_000)).toBe('1 hour');
    });

    it('hours bucket — plural form when > 1 hour, no remainder', () => {
        expect(formatMs(2 * 60 * 60_000)).toBe('2 hours');
    });

    it('hours bucket — appends `Xm` when there are leftover minutes', () => {
        // 1h 30m
        expect(formatMs(90 * 60_000)).toBe('1 hour 30m');
        // 2h 45m
        expect(formatMs((2 * 60 + 45) * 60_000)).toBe('2 hours 45m');
    });
});
