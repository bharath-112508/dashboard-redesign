import { describe, it, expect } from 'vitest';

import { buildLeaveMessageBlocks } from './leave.js';

/**
 * Phase 1 — Block Kit blocks for the leave-request lifecycle. The same
 * builder produces the INITIAL post AND every subsequent chat.update;
 * the only thing that changes between calls is the `status` argument
 * (pending → approved/rejected/cancelled).
 */

const leave = {
    _id: 'leave1',
    employee_name: 'Alice Andersson',
    type_label: 'Annual Leave (AL)',
    start_date: '2026-06-10',
    end_date: '2026-06-12',
    reason: 'Family trip',
    is_half_day: false,
};

describe('buildLeaveMessageBlocks', () => {
    it('includes Approve and Reject action buttons when status is pending', () => {
        const blocks = buildLeaveMessageBlocks(leave, { status: 'pending' });
        const actions = blocks.find((b) => b.type === 'actions');
        expect(actions).toBeDefined();
        const ids = (actions as { elements: Array<{ action_id: string }> }).elements.map((e) => e.action_id);
        expect(ids).toEqual([`approve_leave_${leave._id}`, `reject_leave_${leave._id}`]);
    });

    it('omits the actions block when status is approved + shows decided_by', () => {
        const blocks = buildLeaveMessageBlocks(leave, {
            status: 'approved',
            decided_by: 'Bob Manager',
        });
        expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
        const ctx = blocks.find((b) => b.type === 'context');
        expect(JSON.stringify(ctx)).toMatch(/Approved/);
        expect(JSON.stringify(ctx)).toMatch(/Bob Manager/);
    });

    it('omits the actions block when status is rejected', () => {
        const blocks = buildLeaveMessageBlocks(leave, {
            status: 'rejected',
            decided_by: 'Bob Manager',
        });
        expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
        const ctx = blocks.find((b) => b.type === 'context');
        expect(JSON.stringify(ctx)).toMatch(/Rejected/);
    });

    it('omits the actions block when status is cancelled', () => {
        const blocks = buildLeaveMessageBlocks(leave, { status: 'cancelled' });
        expect(blocks.find((b) => b.type === 'actions')).toBeUndefined();
        // A self-cancel emits no decision line (there is no decider to name),
        // so the status is asserted on the message as a whole rather than on
        // a context block that intentionally isn't there.
        expect(JSON.stringify(blocks)).toMatch(/Cancelled/);
    });

    // The range used to be one header string ("name · start → end"). The
    // redesign splits it into labelled From / To fields and renders dates
    // readably, so these assert the same facts in their new home.
    it('shows a single-day request as a half day when flagged', () => {
        const blocks = buildLeaveMessageBlocks(
            { ...leave, start_date: '2026-06-10', end_date: '2026-06-10', is_half_day: true },
            { status: 'pending' }
        );
        const s = JSON.stringify(blocks);
        expect(s).toContain('Jun 10, 2026');
        expect(s).toMatch(/half day/i);
    });

    it('shows both ends of a multi-day range', () => {
        const s = JSON.stringify(buildLeaveMessageBlocks(leave, { status: 'pending' }));
        expect(s).toContain('Jun 10, 2026');
        expect(s).toContain('Jun 12, 2026');
    });
});

// ─── Redesigned layout ────────────────────────────────────────────────────
//
// The message was a header line plus a two-field section. It now leads with
// the leave type and status, carries the requester's identity, and lays the
// dates/duration/status out as labelled fields — the shape the team asked
// for. Still ONE builder for all four states, because the same message is
// mutated in place by chat.update through the lifecycle.

const full = {
    _id: '6a94f2be81804c412aea70f5',
    employee_name: 'Kotha Vivek',
    employee_email: 'vivek@viljetech.com',
    employee_role: 'employee',
    type_label: 'SL — Sick Leave',
    type_code: 'SL',
    type_name: 'Sick Leave',
    start_date: '2026-08-31',
    end_date: '2026-08-31',
    total_days: 1,
    reason: 'Severe tooth pain, visiting the dentist.',
    is_half_day: false,
};

const flat = (blocks: unknown): string => JSON.stringify(blocks);

describe('leave message — redesigned layout', () => {
    it('leads with the type and the status on one line', () => {
        const b = buildLeaveMessageBlocks(full, { status: 'approved', decided_by: 'bharath' });
        const first = flat(b[0]);
        expect(first).toContain('Sick Leave');
        expect(first).toContain('Approved');
    });

    it('uses the type NAME, not the "CODE — Name" label, in the heading', () => {
        const b = buildLeaveMessageBlocks(full, { status: 'pending' });
        expect(flat(b[0])).not.toContain('SL —');
    });

    it('falls back to the label when no name was passed', () => {
        const { type_name, ...noName } = full;
        void type_name;
        const b = buildLeaveMessageBlocks(noName, { status: 'pending' });
        expect(flat(b[0])).toContain('SL — Sick Leave');
    });

    it('shows who decided it and when', () => {
        const b = buildLeaveMessageBlocks(full, {
            status: 'approved',
            decided_by: 'bharath',
            decided_on: '2026-08-31',
        });
        const s = flat(b);
        expect(s).toContain('bharath');
        expect(s).toContain('Aug 31, 2026');
    });

    it('shows the requester with their role and email', () => {
        const s = flat(buildLeaveMessageBlocks(full, { status: 'pending' }));
        expect(s).toContain('Kotha Vivek');
        expect(s).toContain('vivek@viljetech.com');
        // Role is title-cased for display, not the raw enum.
        expect(s).toContain('Employee');
        expect(s).not.toContain('team_lead');
    });

    it('title-cases a multi-word role', () => {
        const s = flat(buildLeaveMessageBlocks({ ...full, employee_role: 'team_lead' }, { status: 'pending' }));
        expect(s).toContain('Team Lead');
    });

    it('lays out From / To / Duration / Status as labelled fields', () => {
        const s = flat(buildLeaveMessageBlocks(full, { status: 'approved', decided_by: 'x' }));
        for (const label of ['From', 'To', 'Duration', 'Status']) expect(s).toContain(label);
        expect(s).toContain('1 day');
    });

    it('splits the dates and the duration into SEPARATE sections', () => {
        // Four fields in one section stack as two tight rows with no gap —
        // Block Kit exposes no spacing control inside a `fields` grid, so the
        // only way to separate them is a second block.
        const b = buildLeaveMessageBlocks(full, { status: 'pending' }) as unknown as Array<{
            type: string;
            fields?: Array<{ text: string }>;
        }>;
        const fieldRows = b.filter((x) => x.type === 'section' && Array.isArray(x.fields));
        expect(fieldRows).toHaveLength(2);
        expect(fieldRows.every((r) => r.fields?.length === 2)).toBe(true);
        expect(flat(fieldRows[0])).toContain('From');
        expect(flat(fieldRows[1])).toContain('Duration');
    });

    it('pluralises the duration', () => {
        const s = flat(buildLeaveMessageBlocks({ ...full, total_days: 3 }, { status: 'pending' }));
        expect(s).toContain('3 days');
    });

    it('marks a half day rather than showing a bare day count', () => {
        const s = flat(buildLeaveMessageBlocks({ ...full, total_days: 0.5, is_half_day: true }, { status: 'pending' }));
        expect(s).toMatch(/half day/i);
    });

    it('renders dates in a readable form, not ISO', () => {
        const s = flat(buildLeaveMessageBlocks(full, { status: 'pending' }));
        expect(s).toContain('Aug 31, 2026');
        expect(s).not.toContain('2026-08-31');
    });

    it('shows the reason, and a dash when there is none', () => {
        expect(flat(buildLeaveMessageBlocks(full, { status: 'pending' }))).toContain('Severe tooth pain');
        const { reason, ...noReason } = full;
        void reason;
        expect(flat(buildLeaveMessageBlocks(noReason, { status: 'pending' }))).toContain('Reason');
    });

    it('carries the request id for support lookups', () => {
        expect(flat(buildLeaveMessageBlocks(full, { status: 'pending' }))).toContain(full._id);
    });

    it('keeps Approve / Reject on a pending request only', () => {
        const pending = buildLeaveMessageBlocks(full, { status: 'pending' });
        expect(flat(pending)).toContain(`approve_leave_${full._id}`);
        expect(flat(pending)).toContain(`reject_leave_${full._id}`);
        for (const status of ['approved', 'rejected', 'cancelled'] as const) {
            const s = flat(buildLeaveMessageBlocks(full, { status, decided_by: 'x' }));
            expect(s).not.toContain('approve_leave_');
        }
    });

    it('a self-cancel says Cancelled without naming a decider', () => {
        const s = flat(buildLeaveMessageBlocks(full, { status: 'cancelled' }));
        expect(s).toContain('Cancelled');
        expect(s).not.toMatch(/Cancelled by/);
    });

    it('degrades when the extra fields are absent — legacy callers still render', () => {
        // Every new field is optional; a caller that has not been updated
        // must still produce a valid message rather than "undefined" text.
        const s = flat(buildLeaveMessageBlocks(leave, { status: 'pending' }));
        expect(s).not.toContain('undefined');
        expect(s).toContain('Alice Andersson');
    });
});
