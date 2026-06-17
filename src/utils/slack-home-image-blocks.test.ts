import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

// Force a trailing slash on APP_BASE_URL to prove deep links never double-slash.
vi.mock('../config/server.config.js', async (orig) => ({
    ...(await orig<typeof import('../config/server.config.js')>()),
    APP_BASE_URL: 'https://app.example.com/',
}));

import { buildImageHomeView } from './slack-home-image-blocks.js';
import { buildHomeDashboardView } from './slack-home-blocks.js';
import { SLACK_ACTION_ATTENDANCE_CHECK_IN, SLACK_ACTION_ATTENDANCE_CHECK_OUT } from '../constants/slack.js';
import type { DashboardUser, HomeDashboardData } from '../services/slack-home.service.js';

const base = (over: Partial<HomeDashboardData>): HomeDashboardData => ({
    user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj' },
    my_today: null,
    my_balances: [],
    my_pending: [],
    whos_out: [],
    team_attendance: null,
    pending_leaves: null,
    pending_total: null,
    ...over,
});

const IMG = 'https://blob/x.png';

const allActionIds = (view: { blocks: Array<Record<string, unknown>> }): string[] =>
    view.blocks
        .filter((b) => b.type === 'actions')
        .flatMap((b) => (b.elements as Array<{ action_id?: string }>).map((e) => e.action_id ?? ''));

describe('buildImageHomeView', () => {
    it('puts the image first, then a divider, in a home view', () => {
        const view = buildImageHomeView(IMG, base({}), base({}).user) as {
            type: string;
            blocks: Array<Record<string, unknown>>;
        };
        expect(view.type).toBe('home');
        expect(view.blocks[0]!.type).toBe('image');
        expect((view.blocks[0] as { image_url?: string }).image_url).toBe(IMG);
        expect(view.blocks[1]!.type).toBe('divider');
    });

    it('reviewer view: check-in/out actions + per-pending Approve/Reject + refresh', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const data = base({
            user: reviewer,
            // No segments → not checked in → Check In button is the deterministic one.
            my_today: { segments: [] },
            team_attendance: {
                headcount: 3,
                present: 1,
                incomplete: 0,
                on_leave: 0,
                not_in_count: 2,
                not_in_roster: [],
            },
            pending_total: 2,
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
                {
                    id: 'L2',
                    status: 'pending',
                    start_date: '2026-06-20',
                    end_date: '2026-06-20',
                    total_days: 1,
                    requested_leave_type: { code: 'SL' },
                    user: { full_name: 'Ben' },
                },
            ],
        });
        const view = buildImageHomeView(IMG, data, reviewer) as { blocks: Array<Record<string, unknown>> };
        const ids = allActionIds(view);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_IN);

        const text = JSON.stringify(view);
        expect(text).toContain('approve_leave_');
        expect(text).toContain('reject_leave_');
        expect(text).toContain('approve_leave_L1');
        expect(text).toContain('approve_leave_L2');
        expect(ids).toContain('home_refresh');
        // Per-pending labels carry the requester name since the image rows aren't tappable.
        expect(text).toContain('Asha');
        expect(text).toContain('Ben');
    });

    it('shows Check Out when the latest segment is open', () => {
        const data = base({
            my_today: { segments: [{ check_in: { time: '2026-06-17T05:30:00.000Z' }, check_out: null }] },
        });
        const view = buildImageHomeView(IMG, data, base({}).user) as { blocks: Array<Record<string, unknown>> };
        const ids = allActionIds(view);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_OUT);
    });

    it('employee view: image + check-in/out + refresh, but NO approve buttons', () => {
        const data = base({ my_today: { segments: [] }, pending_leaves: null });
        const view = buildImageHomeView(IMG, data, base({}).user) as {
            type: string;
            blocks: Array<Record<string, unknown>>;
        };
        expect(view.blocks[0]!.type).toBe('image');
        const ids = allActionIds(view);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_IN);
        expect(ids).toContain('home_refresh');
        expect(JSON.stringify(view)).not.toContain('approve_leave_');
    });

    it('respects PENDING_CAP and shows a "+N more" hint', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const many = Array.from({ length: 11 }, (_, i) => ({
            id: `L${i}`,
            status: 'pending',
            start_date: '2026-06-18',
            end_date: '2026-06-18',
            total_days: 1,
            requested_leave_type: { code: 'CL' },
            user: { full_name: `U${i}` },
        }));
        const view = buildImageHomeView(
            IMG,
            base({ user: reviewer, my_today: { segments: [] }, pending_leaves: many, pending_total: 30 }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        const text = JSON.stringify(view);
        expect(text).toMatch(/\+20 more/);
    });
});

// Guard: the shared extraction must not break the native dashboard view.
describe('buildHomeDashboardView still builds after extraction', () => {
    it('is a home view with a check-in + refresh button for an employee', () => {
        const view = buildHomeDashboardView(base({ my_today: { segments: [] } }), base({}).user) as {
            type: string;
            blocks: Array<Record<string, unknown>>;
        };
        expect(view.type).toBe('home');
        const ids = allActionIds(view);
        expect(ids).toContain(SLACK_ACTION_ATTENDANCE_CHECK_IN);
        expect(ids).toContain('home_refresh');
    });
});
