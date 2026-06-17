import { APP_BASE_URL } from '../config/server.config.js';
import { attendanceHeaderBlocks } from './slack-attendance-blocks.js';
import dayjs, { DEFAULT_TIMEZONE } from './date.js';
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

const header = (text: string) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
/** A row with an avatar image accessory, or 👤-prefixed text when none. */
const avatarRow = (text: string, avatarUrl: string | null | undefined, altText: string) =>
    avatarUrl
        ? {
              type: 'section',
              text: { type: 'mrkdwn', text },
              accessory: { type: 'image', image_url: avatarUrl, alt_text: altText },
          }
        : { type: 'section', text: { type: 'mrkdwn', text: `👤 ${text}` } };
/** Mini-avatar context elements: image + name, ~5 people per context block. */
const avatarContext = (
    rows: Array<{ avatar_url?: string | null; label: string; alt: string }>
): Array<Record<string, unknown>> => {
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < rows.length; i += 5) {
        const chunk = rows.slice(i, i + 5);
        const elements: Array<Record<string, unknown>> = [];
        for (const r of chunk) {
            if (r.avatar_url) elements.push({ type: 'image', image_url: r.avatar_url, alt_text: r.alt });
            elements.push({ type: 'mrkdwn', text: r.avatar_url ? r.label : `👤 ${r.label}` });
        }
        out.push({ type: 'context', elements });
    }
    return out;
};
const istNow = () => dayjs().tz(DEFAULT_TIMEZONE);
const footerBlocks = (): Array<Record<string, unknown>> => [
    divider(),
    {
        type: 'actions',
        elements: [
            {
                type: 'button',
                text: { type: 'plain_text', text: '🔄 Refresh', emoji: true },
                action_id: SLACK_ACTION_HOME_REFRESH,
            },
        ],
    },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `updated ${istNow().format('HH:mm')}` }] },
];

const name = (row: { user?: { full_name?: string | null } }): string => row.user?.full_name ?? 'Someone';
const typeCode = (row: { requested_leave_type?: { code?: string } }): string => row.requested_leave_type?.code ?? '—';

const moreLine = (total: number, cap: number): Array<Record<string, unknown>> =>
    total > cap ? [context(`+${total - cap} more`)] : [];

const myLeavesBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    if (data.my_balances === null) return [header('Your leaves'), section('_Couldn’t load right now._')];
    // Hide zero-balance types (they're noise) and bold the codes for scanning.
    const bal = data.my_balances
        .map((b) => ({
            code: (b as { leave_type?: { code?: string } }).leave_type?.code ?? '?',
            available: (b as { available?: number }).available ?? 0,
        }))
        .filter((b) => b.available > 0)
        .map((b) => `*${b.code}* ${b.available}`)
        .join(' · ');
    const blocks: Array<Record<string, unknown>> = [
        header('Your leaves'),
        section(bal ? `${bal} left` : 'No leave balance'),
    ];
    const pend = data.my_pending ?? [];
    if (pend.length > 0) {
        blocks.push(
            section(
                pend
                    .slice(0, 5)
                    .map(
                        (p) =>
                            `• Pending ${(p as { start_date?: string }).start_date}→${(p as { end_date?: string }).end_date} (${typeCode(p as never)})`
                    )
                    .join('\n')
            )
        );
    }
    blocks.push(linkButton('Open leaves →', appUrl('/leaves')));
    return blocks;
};

const whosOutBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    if (data.whos_out === null) return [header("Who's out"), section('_Couldn’t load right now._')];
    const rows = data.whos_out;
    if (rows.length === 0) {
        return [
            header("Who's out"),
            section('_Nobody on leave today or this week._'),
            linkButton('Open calendar →', appUrl('/leaves/calendar')),
        ];
    }
    const mapped = rows.slice(0, WHOSOUT_CAP).map((r) => ({
        avatar_url: (r as { avatar_url?: string | null }).avatar_url ?? null,
        alt: name(r as never),
        label: `*${name(r as never)}* ${(r as { start_date?: string }).start_date}→${(r as { end_date?: string }).end_date} ${typeCode(r as never)}`,
    }));
    return [
        header("Who's out · today + this week"),
        ...avatarContext(mapped),
        ...moreLine(rows.length, WHOSOUT_CAP),
        linkButton('Open calendar →', appUrl('/leaves/calendar')),
    ];
};

const teamAttendanceBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    const t = data.team_attendance;
    if (!t) return [];
    const roster = t.not_in_roster.map((u) => u.full_name ?? 'Someone').join(', ');
    const blocks: Array<Record<string, unknown>> = [
        header('Today'),
        // Inline two-line summary — Slack's 2-column `fields` crowd these short
        // stats together; a single section with ` · ` separators reads cleaner.
        section(
            `🟢 *Present* ${t.present}  ·  ⚪ *Not in* ${t.not_in_count}\n` +
                `🌴 *On leave* ${t.on_leave}  ·  🟡 *Incomplete* ${t.incomplete}`
        ),
    ];
    if (roster) blocks.push(section(`*Not in:* ${roster}`));
    blocks.push(...moreLine(t.not_in_count, ATT_ROSTER_CAP));
    blocks.push(linkButton('View attendance →', appUrl('/attendance')));
    return blocks;
};

const pendingApprovalBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    const pending = data.pending_leaves;
    if (!pending) return [];
    // `pending` is capped at PENDING_CAP+1; `pending_total` is the real backlog
    // size for the header count and the "+N more" line.
    const total = data.pending_total ?? pending.length;
    const blocks: Array<Record<string, unknown>> = [header(`Pending approvals · ${total}`)];
    if (pending.length === 0) {
        blocks.push(section('_Nothing waiting on you._'));
        return blocks;
    }
    for (const p of pending.slice(0, PENDING_CAP)) {
        const id = (p as { id: string }).id;
        const label = `*${name(p as never)}* — ${(p as { start_date?: string }).start_date}→${(p as { end_date?: string }).end_date} · ${typeCode(p as never)} · ${(p as { total_days?: number }).total_days ?? '?'}d`;
        blocks.push(avatarRow(label, (p as { avatar_url?: string | null }).avatar_url, name(p as never)));
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
    blocks.push(linkButton('Open approvals →', appUrl('/leaves')));
    return blocks;
};

/**
 * Compose the full role-scoped Home dashboard. The aggregator only populates
 * team_attendance / pending_leaves for authorized viewers, so the builder
 * simply renders whatever sections are present (gating already done upstream).
 */
export const buildHomeDashboardView = (data: HomeDashboardData, user: DashboardUser): Record<string, unknown> => {
    const blocks: Array<Record<string, unknown>> = [
        header(`Attendance · ${istNow().format('ddd DD MMM')}`),
        ...attendanceHeaderBlocks(data.my_today as never, user.full_name ?? 'there'),
        ...teamAttendanceBlocks(data),
        divider(),
        ...myLeavesBlocks(data),
        divider(),
        ...whosOutBlocks(data),
        ...pendingApprovalBlocks(data),
        ...footerBlocks(),
    ];
    return { type: 'home', blocks: blocks.slice(0, 100) };
};
