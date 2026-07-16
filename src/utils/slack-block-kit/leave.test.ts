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
        const ctx = blocks.find((b) => b.type === 'context');
        expect(JSON.stringify(ctx)).toMatch(/Cancelled/);
    });

    it('renders single-day range without the arrow, with half-day flag when set', () => {
        const blocks = buildLeaveMessageBlocks(
            { ...leave, start_date: '2026-06-10', end_date: '2026-06-10', is_half_day: true },
            { status: 'pending' }
        );
        const header = blocks.find((b) => b.type === 'header');
        expect(JSON.stringify(header)).toMatch(/2026-06-10/);
        expect(JSON.stringify(header)).toMatch(/half day/i);
    });

    it('renders multi-day range with the arrow', () => {
        const blocks = buildLeaveMessageBlocks(leave, { status: 'pending' });
        const header = blocks.find((b) => b.type === 'header');
        expect(JSON.stringify(header)).toContain('2026-06-10 → 2026-06-12');
    });
});
