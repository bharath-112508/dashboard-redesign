import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

// Force a trailing slash on APP_BASE_URL to prove deep links never double-slash.
vi.mock('../config/server.config.js', async (orig) => ({
    ...(await orig<typeof import('../config/server.config.js')>()),
    APP_BASE_URL: 'https://app.example.com/',
}));

import { buildHomeDashboardView } from './slack-home-blocks.js';
import type { DashboardUser, HomeDashboardData } from '../services/slack-home.service.js';
import { SLACK_ACTION_APPLY_LEAVE_OPEN, SLACK_ACTION_LOG_TIME_OPEN } from '../constants/slack.js';

const base = (over: Partial<HomeDashboardData>): HomeDashboardData => ({
    user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Raj' },
    my_today: null,
    my_balances: [],
    my_pending: [],
    whos_out: [],
    team_attendance: null,
    pending_leaves: null,
    pending_total: null,
    my_time: null,
    can_log_time: false,
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

    it('renders team stats as an inline section with emoji + counts', () => {
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
        const text = JSON.stringify(view);
        expect(text).toMatch(/Present\* 18/);
        expect(text).toMatch(/Not checked in\* 4/);
        expect(text).toMatch(/On leave\* 3/);
        expect(text).toMatch(/Missing check-out\* 1/);
        // No 2-column `fields` block — stats render inline in a section.
        expect(view.blocks.some((b) => Array.isArray((b as { fields?: unknown }).fields))).toBe(false);
    });

    it('pending row uses a small left avatar (context image) when avatar_url present', () => {
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
        // Small left avatar = a context block carrying an image element with
        // the row's avatar URL (NOT a section accessory, which renders large
        // on the right).
        const withImg = view.blocks.find(
            (b) =>
                b.type === 'context' &&
                ((b as { elements?: Array<{ type?: string; image_url?: string }> }).elements ?? []).some(
                    (e) => e.type === 'image' && e.image_url === 'https://a/1.png'
                )
        );
        expect(withImg).toBeTruthy();
        // And it must not be a large right-side section accessory.
        const sectionAccessory = view.blocks.find(
            (b) => b.type === 'section' && (b as { accessory?: { type?: string } }).accessory?.type === 'image'
        );
        expect(sectionAccessory).toBeFalsy();
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

describe('App Home — apply for leave', () => {
    it('renders an Apply-for-leave button with the open action_id', () => {
        const view = buildHomeDashboardView(
            base({ my_balances: [{ leave_type: { code: 'CL' }, available: 8 }] }),
            base({}).user
        ) as { blocks: Array<Record<string, unknown>> };
        const actionIds = allActionIds(view);
        expect(actionIds).toContain(SLACK_ACTION_APPLY_LEAVE_OPEN);
    });
});

describe('Your time section', () => {
    /** Minimal HomeDashboardData — every other section tolerates nulls. */
    const baseData = (over: Record<string, unknown> = {}) =>
        ({
            user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya Krishnan' },
            my_today: null,
            my_balances: null,
            my_pending: null,
            whos_out: null,
            team_attendance: null,
            pending_leaves: null,
            pending_total: null,
            // Billable, non-billable and idle are all DIFFERENT, and idle
            // (30m) is folded into total_minutes but is neither billable nor
            // non-billable — so a wrong field, or deriving non-billable via
            // `total - billable` (which would call the idle 30m
            // "non-billable"), fails the assertions below.
            my_time: { total_minutes: 210, billable_minutes: 120, non_billable_minutes: 60 },
            can_log_time: true,
            ...over,
        }) as never;

    const user = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya Krishnan' } as never;

    it('renders today’s total with the billable split, using non_billable_minutes directly (not total - billable)', () => {
        const view = buildHomeDashboardView(baseData(), user);
        const text = JSON.stringify(view.blocks);
        expect(text).toContain('3h 30m');
        expect(text).toContain('2h billable');
        expect(text).toContain('1h non-billable');
        // The 30m of idle time must not appear as "non-billable".
        expect(text).not.toContain('90m non-billable');
        expect(text).not.toContain('1h 30m non-billable');
    });

    it('offers the Log time button', () => {
        const view = buildHomeDashboardView(baseData(), user) as { blocks: Array<Record<string, unknown>> };
        expect(allActionIds(view)).toContain(SLACK_ACTION_LOG_TIME_OPEN);
    });

    it('is absent for a caller without timesheet.write', () => {
        const view = buildHomeDashboardView(baseData({ can_log_time: false }), user) as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(allActionIds(view)).not.toContain(SLACK_ACTION_LOG_TIME_OPEN);
    });

    it('still offers the button when nothing is logged yet', () => {
        const view = buildHomeDashboardView(
            baseData({ my_time: { total_minutes: 0, billable_minutes: 0, non_billable_minutes: 0 } }),
            user
        ) as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(allActionIds(view)).toContain(SLACK_ACTION_LOG_TIME_OPEN);
        expect(JSON.stringify(view.blocks)).toContain('Nothing logged yet');
    });

    it('degrades to the button alone when the timesheet lookup failed', () => {
        // `safe()` returns null on error — the section must still render
        // rather than take the whole Home tab down with it.
        const view = buildHomeDashboardView(baseData({ my_time: null }), user) as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(allActionIds(view)).toContain(SLACK_ACTION_LOG_TIME_OPEN);
    });

    it('never exceeds Slack’s 100-block view ceiling', () => {
        const view = buildHomeDashboardView(baseData(), user);
        expect((view.blocks as unknown[]).length).toBeLessThanOrEqual(100);
    });
});

// ─── Your time: placement + the entry table ───────────────────────────────

describe('Your time — placement', () => {
    const dataWithTime = {
        user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya' },
        my_today: null,
        my_balances: null,
        my_pending: null,
        whos_out: null,
        team_attendance: null,
        pending_leaves: null,
        pending_total: null,
        my_time: { total_minutes: 210, billable_minutes: 120, non_billable_minutes: 60, entries: [] },
        can_log_time: true,
    } as never;
    const user = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya' } as never;

    it('is the first thing on the tab, above Attendance', () => {
        const view = buildHomeDashboardView(dataWithTime, user) as { blocks: Array<Record<string, unknown>> };
        const text = (b: Record<string, unknown>) => JSON.stringify(b);
        const timeIdx = view.blocks.findIndex((b) => text(b).includes('Your time'));
        const attIdx = view.blocks.findIndex((b) => text(b).includes('Attendance'));
        expect(timeIdx).toBeGreaterThanOrEqual(0);
        expect(attIdx).toBeGreaterThanOrEqual(0);
        expect(timeIdx).toBeLessThan(attIdx);
    });

    it('does not open with a stray divider when it is the first section', () => {
        const view = buildHomeDashboardView(dataWithTime, user) as { blocks: Array<Record<string, unknown>> };
        expect(view.blocks[0]!.type).not.toBe('divider');
    });

    it('a caller without timesheet.write still opens on Attendance', () => {
        const view = buildHomeDashboardView({ ...(dataWithTime as object), can_log_time: false } as never, user) as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(view.blocks[0]!.type).not.toBe('divider');
        expect(JSON.stringify(view.blocks[0])).toContain('Attendance');
    });
});

describe('Your time — entry list', () => {
    const user = { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya' } as never;
    const withEntries = (entries: unknown[]) =>
        ({
            user: { _id: new Types.ObjectId(), role: 'employee', full_name: 'Ananya' },
            my_today: null,
            my_balances: null,
            my_pending: null,
            whos_out: null,
            team_attendance: null,
            pending_leaves: null,
            pending_total: null,
            my_time: { total_minutes: 210, billable_minutes: 120, non_billable_minutes: 60, entries },
            can_log_time: true,
        }) as never;

    const ENTRIES = [
        {
            project: 'Nordmark Fleet Dashboard',
            work: 'NMF-142',
            note: 'completed the payment integration',
            minutes: 150,
        },
        { project: 'Aurora Foods', work: 'Standup', note: '', minutes: 30 },
    ];

    const text = (view: { blocks: Array<Record<string, unknown>> }) => JSON.stringify(view.blocks);

    it('shows the project name IN FULL — the old table truncated it to 16 chars', () => {
        const view = buildHomeDashboardView(withEntries(ENTRIES), user) as never as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(text(view)).toContain('Nordmark Fleet Dashboard');
    });

    it('shows the ticket key and the duration', () => {
        const view = buildHomeDashboardView(withEntries(ENTRIES), user) as never as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(text(view)).toContain('NMF-142');
        expect(text(view)).toContain('2h 30m');
    });

    it('shows the note on its own line', () => {
        const view = buildHomeDashboardView(withEntries(ENTRIES), user) as never as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(text(view)).toContain('completed the payment integration');
    });

    it('omits the separator when an entry has no ticket or category', () => {
        const view = buildHomeDashboardView(
            withEntries([{ project: 'Aurora', work: '', note: 'Ad-hoc', minutes: 60 }]),
            user
        ) as never as { blocks: Array<Record<string, unknown>> };
        // "Project ·  · 1h" — a dangling separator where `work` would be.
        expect(text(view)).not.toMatch(/·\s+·/);
    });

    it('clamps a very long note rather than flooding the tab', () => {
        const view = buildHomeDashboardView(
            withEntries([{ project: 'P', work: 'T-1', note: 'x'.repeat(400), minutes: 60 }]),
            user
        ) as never as { blocks: Array<Record<string, unknown>> };
        expect(text(view)).not.toContain('x'.repeat(200));
        expect(text(view)).toContain('…');
    });

    it('caps a long day, says how many are hidden, and stays under the block ceiling', () => {
        const many = Array.from({ length: 25 }, (_, i) => ({
            project: 'P',
            work: `T-${i}`,
            note: '',
            minutes: 15,
        }));
        const view = buildHomeDashboardView(withEntries(many), user) as never as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(text(view)).toMatch(/\+\s*\d+ more/);
        expect((view.blocks as unknown[]).length).toBeLessThanOrEqual(100);
    });

    it('renders nothing extra when nothing is logged', () => {
        const view = buildHomeDashboardView(withEntries([]), user) as never as {
            blocks: Array<Record<string, unknown>>;
        };
        expect(text(view)).not.toMatch(/more today/);
    });
});
