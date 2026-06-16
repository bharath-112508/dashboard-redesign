import { describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { buildHomeDashboardView } from './slack-home-blocks.js';
import type { DashboardUser, HomeDashboardData } from '../services/slack-home.service.js';

const base = (over: Partial<HomeDashboardData>): HomeDashboardData => ({
    user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj' },
    my_today: null,
    my_balances: [],
    my_pending: [],
    whos_out: [],
    team_attendance: null,
    pending_leaves: null,
    ...over,
});

const allActionIds = (view: { blocks: Array<Record<string, unknown>> }): string[] =>
    view.blocks
        .filter((b) => b.type === 'actions')
        .flatMap((b) => (b.elements as Array<{ action_id?: string }>).map((e) => e.action_id ?? ''));

describe('buildHomeDashboardView', () => {
    it('is a home view with a check-in button and a refresh button for an employee', () => {
        const view = buildHomeDashboardView(base({}), base({}).user) as {
            type: string;
            blocks: Array<Record<string, unknown>>;
        };
        expect(view.type).toBe('home');
        const ids = allActionIds(view);
        expect(ids).toContain('attendance_check_in');
        expect(ids).toContain('home_refresh');
    });

    it('omits the pending-approvals section for an employee (no approve buttons)', () => {
        const view = buildHomeDashboardView(base({ pending_leaves: null }), base({}).user) as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(allActionIds(view).some((id) => id.startsWith('approve_leave_'))).toBe(false);
    });

    it('renders Approve/Reject buttons for a reviewer with pending leaves', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const data = base({
            user: reviewer,
            team_attendance: {
                headcount: 3,
                present: 1,
                incomplete: 0,
                on_leave: 0,
                not_in_count: 2,
                not_in_roster: [],
            },
            pending_leaves: [
                {
                    id: 'L1',
                    status: 'pending',
                    start_date: '2026-06-18',
                    end_date: '2026-06-19',
                    total_days: 2,
                    requested_leave_type: { code: 'CL' },
                    user: { full_name: 'Asha' },
                },
            ],
        });
        const view = buildHomeDashboardView(data, reviewer) as { blocks: Array<Record<string, unknown>> };
        const ids = allActionIds(view);
        expect(ids).toContain('approve_leave_L1');
        expect(ids).toContain('reject_leave_L1');
    });

    it('caps the pending list and shows a "+N more" hint', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const many = Array.from({ length: 12 }, (_, i) => ({
            id: `L${i}`,
            status: 'pending',
            start_date: '2026-06-18',
            end_date: '2026-06-18',
            total_days: 1,
            requested_leave_type: { code: 'CL' },
            user: { full_name: `U${i}` },
        }));
        const view = buildHomeDashboardView(base({ user: reviewer, pending_leaves: many }), reviewer) as {
            blocks: Array<Record<string, unknown>>;
        };
        const text = JSON.stringify(view);
        expect(text).toMatch(/\+2 more/);
    });
});
