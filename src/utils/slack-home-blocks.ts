import { APP_BASE_URL } from '../config/server.config.js';
import { attendanceHeaderBlocks } from './slack-attendance-blocks.js';
import dayjs, { DEFAULT_TIMEZONE } from './date.js';
import { SLACK_ACTION_APPLY_LEAVE_OPEN, SLACK_ACTION_LOG_TIME_OPEN } from '../constants/slack.js';
import {
    ATT_ROSTER_CAP,
    PENDING_CAP,
    WHOSOUT_CAP,
    type HomeDashboardData,
    type DashboardUser,
    type MyTimeEntry,
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

/** A non-link action button (opens a modal via its action_id). */
const actionButton = (text: string, actionId: string, style?: 'primary' | 'danger') => ({
    type: 'actions',
    elements: [
        {
            type: 'button',
            text: { type: 'plain_text', text },
            action_id: actionId,
            ...(style ? { style } : {}),
        },
    ],
});

const header = (text: string) => ({ type: 'header', text: { type: 'plain_text', text, emoji: true } });
/**
 * A row with a small avatar on the LEFT, inline with the text. Uses a context
 * block (image element ~20px, left-aligned) rather than a section accessory
 * (which renders a large image on the right). Falls back to a 👤 prefix when
 * there's no avatar.
 */
const avatarRow = (text: string, avatarUrl: string | null | undefined, altText: string) => ({
    type: 'context',
    elements: avatarUrl
        ? [
              { type: 'image', image_url: avatarUrl, alt_text: altText },
              { type: 'mrkdwn', text },
          ]
        : [{ type: 'mrkdwn', text: `👤 ${text}` }],
});
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
    blocks.push(actionButton('➕ Apply for leave', SLACK_ACTION_APPLY_LEAVE_OPEN, 'primary'));
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
        // One stat per line — Slack mrkdwn can't align columns (whitespace
        // collapses, no tabs), so side-by-side stats either crowd (`fields`)
        // or sit ragged. A vertical list is clean and unambiguous.
        section(
            `🟢 *Present* ${t.present}\n\n` +
                `⚪ *Not checked in* ${t.not_in_count}\n\n` +
                `🌴 *On leave* ${t.on_leave}\n\n` +
                `🟡 *Missing check-out* ${t.incomplete}`
        ),
    ];
    if (roster) blocks.push(section(`*Not checked in:* ${roster}`));
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

/** "3h 30m", "45m", "0m" — Slack-friendly duration. */
const hm = (minutes: number): string => {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    if (h && m) return `${h}h ${m}m`;
    if (h) return `${h}h`;
    return `${m}m`;
};

/** Column widths for the entry table. Slack's code block is monospace but
 *  NOT infinitely wide — it scrolls horizontally on mobile rather than
 *  wrapping, so the row has to stay narrow enough to read on a phone. */
// 16 + 16 + ~6 for the duration ≈ 38 chars per row, which fits a phone-width
// code block without horizontal scrolling. Widening either column buys
// longer names at the cost of scrolling on every row.
const COL_PROJECT = 16;
const COL_WORK = 16;

/** Pad or truncate to an exact width, so every row starts its next column at
 *  the same offset. A row that overflows its column doesn't wrap — it shunts
 *  the rest of THAT row right and breaks the alignment for the whole table,
 *  which is the only reason to use a code block in the first place. */
const fit = (value: string, width: number): string => {
    const v = value ?? '';
    // `>=`, not `>`: a value of EXACTLY `width` gets no padding from
    // `padEnd`, so it runs straight into the next column with no gap
    // ("Nordmark FleetVLJ-142"). Truncating at `width - 2` leaves room for
    // the ellipsis AND a trailing space, so every column keeps its separator.
    if (v.length >= width) return `${v.slice(0, width - 2)}… `;
    return v.padEnd(width);
};

/** How many entries the table lists before collapsing to a "+N more" line. */
export const MY_TIME_ENTRY_CAP = 10;

/**
 * The day's entries as an aligned monospace table.
 *
 * ONE block regardless of row count — a busy day can't eat into the
 * 100-block view ceiling the way a block-per-row would. Slack has no table
 * primitive; a fenced code block is the only thing that renders in a
 * fixed-width font, which is what makes columns line up at all.
 */
const myTimeTable = (entries: MyTimeEntry[]): Array<Record<string, unknown>> => {
    if (entries.length === 0) return [];
    const shown = entries.slice(0, MY_TIME_ENTRY_CAP);
    const rows = shown.map((e) => `${fit(e.project, COL_PROJECT)}${fit(e.work, COL_WORK)}${hm(e.minutes)}`);
    const head = `${fit('PROJECT', COL_PROJECT)}${fit('WORK', COL_WORK)}TIME`;
    const out: Array<Record<string, unknown>> = [section(`\`\`\`\n${head}\n${rows.join('\n')}\n\`\`\``)];
    const hidden = entries.length - shown.length;
    if (hidden > 0) out.push(context(`+ ${hidden} more today — open the web timesheet for the full day.`));
    return out;
};

/**
 * Today's logged time, the day's entries, and the Log-time button.
 *
 * Renders FIRST on the Home tab: logging time is the thing people open this
 * for most often, and it used to sit below every leave and attendance
 * section. Being first is also why it emits no leading divider — the tab
 * would open on a rule.
 */
const myTimeBlocks = (data: HomeDashboardData): Array<Record<string, unknown>> => {
    if (!data.can_log_time) return [];

    const blocks: Array<Record<string, unknown>> = [header('Your time')];

    if (!data.my_time) {
        // The lookup failed. Say nothing about totals rather than imply zero.
        blocks.push(context("Couldn't load today's total."));
    } else if (data.my_time.total_minutes === 0) {
        blocks.push(section('Nothing logged yet today.'));
    } else {
        // `non_billable_minutes` is summed off the rows the same way
        // `billable_minutes` is (see slack-home.service.ts) — NOT derived as
        // `total - billable`. `total_minutes` also includes idle time, which
        // is neither billable nor non-billable; subtracting would have
        // mislabelled it as non-billable.
        blocks.push(
            section(
                `Today: *${hm(data.my_time.total_minutes)}*  (${hm(data.my_time.billable_minutes)} billable · ${hm(data.my_time.non_billable_minutes)} non-billable)`
            )
        );
    }

    blocks.push(...myTimeTable(data.my_time?.entries ?? []));
    blocks.push(actionButton('➕ Log time', SLACK_ACTION_LOG_TIME_OPEN, 'primary'));
    // Trailing rule: this section is first now, so it needs to separate
    // itself from Attendance below rather than from whatever was above.
    blocks.push(divider());
    return blocks;
};

/**
 * Compose the full role-scoped Home dashboard. The aggregator only populates
 * team_attendance / pending_leaves for authorized viewers, so the builder
 * simply renders whatever sections are present (gating already done upstream).
 */
export const buildHomeDashboardView = (data: HomeDashboardData, user: DashboardUser): Record<string, unknown> => {
    const blocks: Array<Record<string, unknown>> = [
        ...myTimeBlocks(data),
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
