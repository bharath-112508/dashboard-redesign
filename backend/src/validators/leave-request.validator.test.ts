import { describe, expect, it } from 'vitest';

import {
    applyLeaveBodySchema,
    approveLeaveBodySchema,
    calendarLeavesQuerySchema,
    cancelLeaveBodySchema,
    listLeavesQuerySchema,
    rejectLeaveBodySchema,
} from './leave-request.validator.js';

/**
 * Coverage focus for the leave-request validators — the cross-field
 * `superRefine` rules are the bit worth pinning at the validator
 * layer (vs. the engine layer). They short-circuit the engine on
 * malformed input, so a regression here would either:
 *   - Let an invalid request reach the engine (which then has to
 *     do the date math and surface a less-friendly error), OR
 *   - Reject a valid request that the engine WOULD have accepted.
 *
 * Both directions are user-visible bugs.
 */

const validIds = '507f1f77bcf86cd799439011';

const validApplyBody = {
    leave_type_id: validIds,
    start_date: '2026-04-23',
    end_date: '2026-04-25',
    is_half_day: false,
    reason: 'Family event',
};

// ─── applyLeaveBodySchema ────────────────────────────────────────────────

describe('applyLeaveBodySchema — date constraints', () => {
    it('accepts a valid full-day request', () => {
        expect(() => applyLeaveBodySchema.parse(validApplyBody)).not.toThrow();
    });

    it('rejects when start_date > end_date', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            start_date: '2026-04-25',
            end_date: '2026-04-23',
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues[0]!.message).toContain('start_date must be on or before end_date');
        }
    });

    it('rejects a span exceeding LEAVE_REQUEST_MAX_DAYS (180-day cap defence against pathological requests)', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            start_date: '2026-01-01',
            end_date: '2027-12-31', // ~24 months, well over any realistic cap
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues[0]!.message).toContain('exceeds maximum');
        }
    });

    it('rejects a non-real calendar date (month 13)', () => {
        // The regex `^\d{4}-\d{2}-\d{2}$` accepts impossible months
        // like 13. The `.refine` after the regex catches them via
        // dayjs's strict parser (with `customParseFormat` loaded from
        // the platform-configured `utils/date.js` singleton — pre-fix
        // the validator imported plain `dayjs` and the strict flag was
        // silently a no-op).
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            start_date: '2026-13-01',
            end_date: '2026-13-01',
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('real calendar date'))).toBe(true);
        }
    });

    it('rejects Feb 30 (impossible day-of-month for the supplied month)', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            start_date: '2026-02-30',
            end_date: '2026-02-30',
        });
        expect(r.success).toBe(false);
    });
});

describe('applyLeaveBodySchema — half-day rules', () => {
    it('rejects half-day with start_date != end_date', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            is_half_day: true,
            half_day_slot: 'first_half',
            start_date: '2026-04-23',
            end_date: '2026-04-24',
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('Half-day requests must have'))).toBe(true);
        }
    });

    it('rejects half-day without a half_day_slot', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            is_half_day: true,
            start_date: '2026-04-23',
            end_date: '2026-04-23',
            // half_day_slot intentionally omitted
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('half_day_slot is required'))).toBe(true);
        }
    });

    it('rejects half_day_slot supplied when is_half_day is false (cross-field consistency)', () => {
        // Defence in depth: a payload that sends `half_day_slot:
        // 'first_half'` but `is_half_day: false` is internally
        // contradictory. Reject at the validator layer rather than
        // having the engine pick one signal and silently ignore the
        // other.
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            is_half_day: false,
            half_day_slot: 'first_half',
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('only valid when is_half_day is true'))).toBe(true);
        }
    });

    it('accepts a valid half-day request', () => {
        const r = applyLeaveBodySchema.safeParse({
            ...validApplyBody,
            is_half_day: true,
            half_day_slot: 'second_half',
            start_date: '2026-04-23',
            end_date: '2026-04-23',
        });
        expect(r.success).toBe(true);
    });
});

// ─── approveLeaveBodySchema (strict) ─────────────────────────────────────

describe('approveLeaveBodySchema', () => {
    it('accepts an empty body (remarks default to empty string)', () => {
        const r = approveLeaveBodySchema.safeParse({});
        expect(r.success).toBe(true);
        if (r.success) expect(r.data.approver_remarks).toBe('');
    });

    it('rejects unknown fields (strict mode — no rogue payload smuggling)', () => {
        // .strict() catches a typo or an injection attempt that adds
        // fields the schema doesn't declare.
        const r = approveLeaveBodySchema.safeParse({ approver_remarks: 'ok', injected: 'payload' });
        expect(r.success).toBe(false);
    });

    it('rejects an additional_approval_reason that is shorter than the minimum', () => {
        // The `min(ADDITIONAL_APPROVAL_REASON_MIN)` is the policy:
        // an additional approval can't be granted with a one-word
        // explanation. A regression that dropped the min would let
        // a manager click-through approvals without explaining.
        const r = approveLeaveBodySchema.safeParse({ additional_approval_reason: 'ok' });
        expect(r.success).toBe(false);
    });
});

// ─── rejectLeaveBodySchema ───────────────────────────────────────────────

describe('rejectLeaveBodySchema', () => {
    it('requires non-empty approver_remarks (rejection MUST carry a reason)', () => {
        // Policy: a rejection without a reason isn't actionable for
        // the requester. Pin the min:1 — a regression that dropped
        // it would let managers reject silently.
        const r = rejectLeaveBodySchema.safeParse({ approver_remarks: '' });
        expect(r.success).toBe(false);
    });

    it('accepts non-trivial remarks', () => {
        const r = rejectLeaveBodySchema.safeParse({ approver_remarks: 'Already covered by team lead' });
        expect(r.success).toBe(true);
    });

    it('trims whitespace and re-checks the min:1 (defence against `   ` rejection)', () => {
        // Defence: `.trim().min(1)` together close the loophole of
        // rejecting with a whitespace-only reason.
        const r = rejectLeaveBodySchema.safeParse({ approver_remarks: '     ' });
        expect(r.success).toBe(false);
    });
});

// ─── cancelLeaveBodySchema ───────────────────────────────────────────────

describe('cancelLeaveBodySchema', () => {
    it('accepts an omitted cancellation_reason (BUG-035 — reason optional)', () => {
        const r = cancelLeaveBodySchema.safeParse({});
        expect(r.success).toBe(true);
    });

    it('accepts an empty cancellation_reason (BUG-035 — reason optional)', () => {
        const r = cancelLeaveBodySchema.safeParse({ cancellation_reason: '' });
        expect(r.success).toBe(true);
    });

    it('accepts a real reason', () => {
        const r = cancelLeaveBodySchema.safeParse({ cancellation_reason: 'plans changed' });
        expect(r.success).toBe(true);
    });
});

// ─── listLeavesQuerySchema ───────────────────────────────────────────────

describe('listLeavesQuerySchema', () => {
    it('coerces query-string `requires_additional_approval` from "true"/"false" strings to booleans', () => {
        // Express query strings are always strings — the validator
        // transforms the literal "true"/"false" into proper booleans
        // so the service layer can do `if (q.requires_additional_approval)`.
        const trueRes = listLeavesQuerySchema.safeParse({ requires_additional_approval: 'true' });
        expect(trueRes.success).toBe(true);
        if (trueRes.success) expect(trueRes.data.requires_additional_approval).toBe(true);

        const falseRes = listLeavesQuerySchema.safeParse({ requires_additional_approval: 'false' });
        expect(falseRes.success).toBe(true);
        if (falseRes.success) expect(falseRes.data.requires_additional_approval).toBe(false);
    });

    it('coerces page + limit from query-string numbers', () => {
        const r = listLeavesQuerySchema.safeParse({ page: '3', limit: '50' });
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.page).toBe(3);
            expect(r.data.limit).toBe(50);
        }
    });

    it('rejects when from_date > to_date', () => {
        const r = listLeavesQuerySchema.safeParse({ from_date: '2026-12-31', to_date: '2026-01-01' });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('on or before'))).toBe(true);
        }
    });

    it('rejects limit > 200 (DoS defence — pagination cap)', () => {
        const r = listLeavesQuerySchema.safeParse({ limit: '500' });
        expect(r.success).toBe(false);
    });

    it('defaults page=1 and limit=50 when omitted', () => {
        const r = listLeavesQuerySchema.safeParse({});
        expect(r.success).toBe(true);
        if (r.success) {
            expect(r.data.page).toBe(1);
            expect(r.data.limit).toBe(50);
        }
    });
});

// ─── calendarLeavesQuerySchema ───────────────────────────────────────────

describe('calendarLeavesQuerySchema', () => {
    it('rejects from_date > to_date', () => {
        const r = calendarLeavesQuerySchema.safeParse({ from_date: '2026-12-31', to_date: '2026-01-01' });
        expect(r.success).toBe(false);
    });

    it('rejects a range > 366 days (DoS defence — bounded calendar query)', () => {
        // 367-day window — would force the calendar endpoint to scan
        // a year+ of leave_requests + segment-expand the result. Reject
        // at the validator.
        const r = calendarLeavesQuerySchema.safeParse({
            from_date: '2025-01-01',
            to_date: '2026-01-03',
        });
        expect(r.success).toBe(false);
        if (!r.success) {
            expect(r.error.issues.some((i) => i.message.includes('366'))).toBe(true);
        }
    });

    it('accepts a 365-day range (under the cap)', () => {
        const r = calendarLeavesQuerySchema.safeParse({
            from_date: '2026-01-01',
            to_date: '2026-12-31',
        });
        expect(r.success).toBe(true);
    });
});
