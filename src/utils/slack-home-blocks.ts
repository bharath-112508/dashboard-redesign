import { APP_BASE_URL } from '../config/server.config.js';
import { attendanceHeaderBlocks } from './slack-attendance-blocks.js';
import {
    ATT_ROSTER_CAP,
    PENDING_CAP,
    WHOSOUT_CAP,
    type HomeDashboardData,
    type DashboardUser,
} from '../services/slack-home.service.js';

/** Action ids owned by the dashboard (leave Approve/Reject reuse the existing ids). */
export const SLACK_ACTION_HOME_REFRESH = 'home_refresh';

/**
 * Build a web-app deep link. `APP_BASE_URL` is the frontend base; strip any
 * trailing slash(es) so we never emit `https://host//leaves`. NOTE:
 * `APP_BASE_URL` must point at the FRONTEND app (where `/leaves` etc. render),
 * not the API host.
 */
const appUrl = (path: string): string => `${APP_BASE_URL.replace(/\/+$/, '')}${path}`;

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const divider = () => ({ type: 'divider' });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });
const linkButton = (text: string, url: string) => ({
    type: 'actions',
    elements: [{ type: 'button', text: { type: 'plain_text', text }, url }],
});

const name = (row: { user?: { full_name?: string | null } }): string => row.user?.full_name ?? 'Someone';
const typeCode = (row: { requested_leave_type?: { code?: string } }): string => row.requested_leave_type?.code ?? '—';

const moreLine = (total: number, cap: number): Array<Record<string, unknown>> =>
    total > cap ? [context(`+${total - cap} more`)] : [];

const myLeavesBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    if (data.my_balances === null) return [section('*Your leaves*\n_Couldn’t load right now._')];
    const bal = data.my_balances
        .map((b) => {
            const t = (b as { leave_type?: { code?: string } }).leave_type?.code ?? '?';
            const a = (b as { available?: number }).available ?? 0;
            return `${t} ${a}`;
        })
        .join(' · ');
    const blocks: Array<Record<string, unknown>> = [section(`*Your leaves* — ${bal || 'no balances'} left`)];
    const pend = data.my_pending ?? [];
    if (pend.length > 0) {
        blocks.push(
            section(
                pend
                    .slice(0, 5)
                    .map(
                        (p) =>
                            `• Pending: ${(p as { start_date?: string }).start_date}→${(p as { end_date?: string }).end_date} (${typeCode(p as never)})`
                    )
                    .join('\n')
            )
        );
    }
    blocks.push(linkButton('Open leaves →', appUrl('/leaves')));
    return blocks;
};

const whosOutBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    if (data.whos_out === null) return [section('*Who’s out*\n_Couldn’t load right now._')];
    const rows = data.whos_out;
    const body =
        rows.length === 0
            ? '_Nobody on leave today or this week._'
            : rows
                  .slice(0, WHOSOUT_CAP)
                  .map(
                      (r) =>
                          `• ${name(r as never)} — ${(r as { start_date?: string }).start_date}→${(r as { end_date?: string }).end_date} (${typeCode(r as never)})`
                  )
                  .join('\n');
    return [
        section(`*Who’s out (today + this week)*\n${body}`),
        ...moreLine(rows.length, WHOSOUT_CAP),
        linkButton('Open calendar →', appUrl('/leaves/calendar')),
    ];
};

const teamAttendanceBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    const t = data.team_attendance;
    if (!t) return [];
    const roster = t.not_in_roster.map((u) => u.full_name ?? 'Someone').join(', ');
    return [
        section(
            `*Today’s attendance* — Present ${t.present} · Not in ${t.not_in_count} · On leave ${t.on_leave} · Incomplete ${t.incomplete}`
        ),
        ...(roster ? [section(`Not in: ${roster}`)] : []),
        ...moreLine(t.not_in_count, ATT_ROSTER_CAP),
        linkButton('View attendance →', appUrl('/attendance')),
    ];
};

const pendingApprovalBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    const pending = data.pending_leaves;
    if (!pending) return [];
    // `pending` is capped at PENDING_CAP+1; `pending_total` is the real backlog
    // size for the header count and the "+N more" line.
    const total = data.pending_total ?? pending.length;
    const blocks: Array<Record<string, unknown>> = [section(`*Pending approvals (${total})*`)];
    if (pending.length === 0) {
        blocks.push(section('_Nothing waiting on you._'));
        return blocks;
    }
    for (const p of pending.slice(0, PENDING_CAP)) {
        const id = (p as { id: string }).id;
        blocks.push(
            section(
                `• *${name(p as never)}* — ${(p as { start_date?: string }).start_date}→${(p as { end_date?: string }).end_date} (${typeCode(p as never)}, ${(p as { total_days?: number }).total_days ?? '?'}d)`
            )
        );
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    style: 'primary',
                    text: { type: 'plain_text', text: 'Approve' },
                    action_id: `approve_leave_${id}`,
                },
                {
                    type: 'button',
                    style: 'danger',
                    text: { type: 'plain_text', text: 'Reject' },
                    action_id: `reject_leave_${id}`,
                },
            ],
        });
    }
    blocks.push(...moreLine(total, PENDING_CAP));
    blocks.push(linkButton('Open leave approvals →', appUrl('/leaves')));
    return blocks;
};

const refreshBlocks = (): Array<Record<string, unknown>> => [
    divider(),
    {
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: '🔄 Refresh' },
                action_id: SLACK_ACTION_HOME_REFRESH,
            },
        ],
    },
];

/**
 * Compose the full role-scoped Home dashboard. The aggregator only populates
 * team_attendance / pending_leaves for authorized viewers, so the builder
 * simply renders whatever sections are present (gating already done upstream).
 */
export const buildHomeDashboardView = (data: HomeDashboardData, user: DashboardUser): Record<string, unknown> => {
    const blocks: Array<Record<string, unknown>> = [
        ...attendanceHeaderBlocks(data.my_today as never, user.full_name ?? 'there'),
        divider(),
        ...myLeavesBlocks(data),
        divider(),
        ...whosOutBlocks(data),
        ...teamAttendanceBlocks(data),
        ...pendingApprovalBlocks(data),
        ...refreshBlocks(),
    ];
    return { type: 'home', blocks: blocks.slice(0, 100) };
};
