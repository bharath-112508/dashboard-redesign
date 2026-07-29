import { describe, expect, it } from 'vitest';

import { patchSettingsBodySchema } from './settings.validator.js';

describe('patchSettingsBodySchema — reminders.task_due_reminder_run_interval_hours', () => {
    const parseWith = (hours: number) =>
        patchSettingsBodySchema.safeParse({
            reminders: { task_due_reminder_run_interval_hours: hours },
        });

    it('rejects 0 (below the minimum)', () => {
        expect(parseWith(0).success).toBe(false);
    });

    it('accepts the minimum, 1', () => {
        expect(parseWith(1).success).toBe(true);
    });

    it('accepts the maximum, 24', () => {
        expect(parseWith(24).success).toBe(true);
    });

    it('rejects 25 (above the maximum)', () => {
        expect(parseWith(25).success).toBe(false);
    });
});

describe('patchSettingsBodySchema — security.password_max_length', () => {
    const parseWith = (length: number) =>
        patchSettingsBodySchema.safeParse({
            security: { password_max_length: length },
        });

    it('rejects below the minimum, 6', () => {
        expect(parseWith(5).success).toBe(false);
    });

    it('accepts the minimum, 6', () => {
        expect(parseWith(6).success).toBe(true);
    });

    it('accepts the maximum, 12', () => {
        expect(parseWith(12).success).toBe(true);
    });

    it('rejects 13 (above the maximum)', () => {
        expect(parseWith(13).success).toBe(false);
    });
});
