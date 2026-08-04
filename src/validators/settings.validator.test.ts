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

    // The cap used to be 12, which meant the "maximum length" setting could
    // not express anything a password manager generates — the field was
    // configurable in name only. It is now bcrypt's 72-byte hashing limit.
    it('accepts 20 — a password-manager length, rejected under the old cap of 12', () => {
        expect(parseWith(20).success).toBe(true);
    });

    it('accepts the maximum, 72 (bcrypt hashes at most 72 bytes)', () => {
        expect(parseWith(72).success).toBe(true);
    });

    it('rejects 73 — past 72 bcrypt silently ignores the rest', () => {
        expect(parseWith(73).success).toBe(false);
    });
});

describe('patchSettingsBodySchema — payroll.company_email', () => {
    const parseWith = (company_email: string) => patchSettingsBodySchema.safeParse({ payroll: { company_email } });

    // Renders as the company's contact address on every payslip and letter,
    // so a malformed value is a wrong address printed on a document. The FE
    // guards it as well; this is the enforcement point.
    it('rejects a value that is not an email', () => {
        expect(parseWith('not-an-email').success).toBe(false);
    });

    it('rejects a website — the field is an email, not free letterhead text', () => {
        expect(parseWith('www.viljetech.com').success).toBe(false);
    });

    it('accepts blank — the field is optional until configured', () => {
        expect(parseWith('').success).toBe(true);
    });

    it('accepts a real address', () => {
        expect(parseWith('hr@viljetech.com').success).toBe(true);
    });
});

describe('patchSettingsBodySchema — leave_policy.comp_off_hours_per_day', () => {
    const parseWith = (comp_off_hours_per_day: number) =>
        patchSettingsBodySchema.safeParse({ leave_policy: { comp_off_hours_per_day } });

    // The accrual job derives `halfStep = max(1, threshold/2)` from this. At 0
    // the step collapses to one minute, so a single minute of overtime mints
    // half a comp-off day — an hour of overtime would grant 30 days.
    it('rejects 0', () => {
        expect(parseWith(0).success).toBe(false);
    });

    it('accepts the minimum, 0.25', () => {
        expect(parseWith(0.25).success).toBe(true);
    });

    it('accepts the default, 8', () => {
        expect(parseWith(8).success).toBe(true);
    });

    it('rejects above 24', () => {
        expect(parseWith(25).success).toBe(false);
    });
});
