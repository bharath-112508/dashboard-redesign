import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

// Force a trailing slash on APP_BASE_URL to prove deep links never double-slash.
vi.mock('../config/server.config.js', async (orig) => ({
    ...(await orig<typeof import('../config/server.config.js')>()),
    APP_BASE_URL: 'https://app.example.com/',
}));

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
    pending_total: null,
    ...over,
});

const allActionIds = (view: { blocks: Array<Record<string, unknown>> }): string[] =>
    view.blocks
        .filter((b) => b.type === 'actions')
        .flatMap((b) => (b.elements as Array<{ action_id?: string }>).map((e) => e.action_id ?? ''));

describe('buildHomeDashboardView', () => {
    it('deep links use a single slash even when APP_BASE_URL has a trailing slash', () => {
        const view = buildHomeDashboardView(base({}), base({}).user) as { blocks: Array<Record<string, unknown>> };
        const urls = view.blocks
            .filter((b) => b.type === 'actions')
            .flatMap((b) => (b.elements as Array<{ url?: string }>).map((e) => e.url))
            .filter((u): u is string => Boolean(u));
        expect(urls.length).toBeGreaterThan(0);
        for (const u of urls) {
            expect(u.startsWith('https://app.example.com//')).toBe(false);
            expect(u).toMatch(/^https:\/\/app\.example\.com\/[a-z]/);
        }
    });

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

    it('uses pending_total (real backlog) for the header count and "+N more", not the capped array', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        // List is capped at PENDING_CAP+1 (11) by the aggregator, but the true total is 30.
        const capped = Array.from({ length: 11 }, (_, i) => ({
            id: `L${i}`,
            status: 'pending',
            start_date: '2026-06-18',
            end_date: '2026-06-18',
            total_days: 1,
            requested_leave_type: { code: 'CL' },
            user: { full_name: `U${i}` },
        }));
        const view = buildHomeDashboardView(
            base({ user: reviewer, pending_leaves: capped, pending_total: 30 }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        const text = JSON.stringify(view);
        expect(text).toMatch(/Pending approvals/);
        expect(text).toMatch(/30/);
        expect(text).toMatch(/\+20 more/);
    });
});

const blockTypes = (view: { blocks: Array<Record<string, unknown>> }) => view.blocks.map((b) => b.type);

describe('buildHomeDashboardView — redesigned layout', () => {
    it('uses header blocks for section titles', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const view = buildHomeDashboardView(
            base({
                user: reviewer,
                team_attendance: {
                    headcount: 3,
                    present: 1,
                    incomplete: 0,
                    on_leave: 0,
                    not_in_count: 2,
                    not_in_roster: [],
                },
            }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        expect(blockTypes(view)).toContain('header');
    });

    it('renders team stats as a 2-column fields section', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const view = buildHomeDashboardView(
            base({
                user: reviewer,
                team_attendance: {
                    headcount: 22,
                    present: 18,
                    incomplete: 1,
                    on_leave: 3,
                    not_in_count: 4,
                    not_in_roster: [],
                },
            }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        const fieldsSection = view.blocks.find(
            (b) => b.type === 'section' && Array.isArray((b as { fields?: unknown }).fields)
        );
        expect(fieldsSection).toBeTruthy();
        expect(JSON.stringify(fieldsSection)).toMatch(/Present/);
        expect(JSON.stringify(fieldsSection)).toMatch(/18/);
    });

    it('pending row uses an image accessory when avatar_url present', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const view = buildHomeDashboardView(
            base({
                user: reviewer,
                pending_total: 1,
                pending_leaves: [
                    {
                        id: 'L1',
                        start_date: '2026-06-18',
                        end_date: '2026-06-19',
                        total_days: 2,
                        requested_leave_type: { code: 'CL' },
                        user: { full_name: 'Asha' },
                        avatar_url: 'https://a/1.png',
                    },
                ],
            }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        const withImg = view.blocks.find(
            (b) => b.type === 'section' && (b as { accessory?: { type?: string } }).accessory?.type === 'image'
        );
        expect(withImg).toBeTruthy();
        expect(JSON.stringify(withImg)).toContain('https://a/1.png');
    });

    it('pending row falls back to 👤 (no image accessory) when avatar_url null, keeps Approve/Reject', () => {
        const reviewer: DashboardUser = { _id: new Types.ObjectId(), role: 'admin', full_name: 'Boss' };
        const view = buildHomeDashboardView(
            base({
                user: reviewer,
                pending_total: 1,
                pending_leaves: [
                    {
                        id: 'L1',
                        start_date: '2026-06-18',
                        end_date: '2026-06-19',
                        total_days: 2,
                        requested_leave_type: { code: 'CL' },
                        user: { full_name: 'Asha' },
                        avatar_url: null,
                    },
                ],
            }),
            reviewer
        ) as { blocks: Array<Record<string, unknown>> };
        const imgAccessory = view.blocks.find(
            (b) => (b as { accessory?: { type?: string } }).accessory?.type === 'image'
        );
        expect(imgAccessory).toBeFalsy();
        expect(JSON.stringify(view)).toContain('👤');
        const ids = view.blocks
            .filter((b) => b.type === 'actions')
            .flatMap((b) => (b as { elements: Array<{ action_id?: string }> }).elements.map((e) => e.action_id ?? ''));
        expect(ids).toContain('approve_leave_L1');
        expect(ids).toContain('reject_leave_L1');
    });

    it('hides zero-balance leave types and bolds the codes', () => {
        const view = buildHomeDashboardView(
            base({
                my_balances: [
                    { leave_type: { code: 'CL' }, available: 15 },
                    { leave_type: { code: 'WFH' }, available: 0 },
                    { leave_type: { code: 'COMP_OFF' }, available: 0.5 },
                ],
            }),
            base({}).user
        ) as { blocks: Array<Record<string, unknown>> };
        const text = JSON.stringify(view);
        expect(text).toContain('*CL* 15');
        expect(text).toContain('*COMP_OFF* 0.5');
        expect(text).not.toContain('WFH'); // zero-balance type hidden
    });

    it('shows "No leave balance" when every balance is zero', () => {
        const view = buildHomeDashboardView(
            base({ my_balances: [{ leave_type: { code: 'CL' }, available: 0 }] }),
            base({}).user
        ) as { blocks: Array<Record<string, unknown>> };
        expect(JSON.stringify(view)).toContain('No leave balance');
    });
});
