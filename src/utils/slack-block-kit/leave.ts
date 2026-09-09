import type { LeaveRequestStatus } from '../../constants/leave.js';

/**
 * Phase 1 — Block Kit blocks for a leave-request Slack message.
 *
 * Layout:
 *   1. Section — {type emoji} *Type name* • Status
 *   2. Context — decision line ("🟢 Approved by X on Jun 3, 2026"), omitted
 *                while pending and on a self-cancel (nobody to name)
 *   3. Divider
 *   4. Section — *Employee name* • Role, with their email beneath
 *   5. Divider
 *   6. Section — From / To / Duration / Status as labelled fields
 *   7. Section — 💬 Reason
 *   8. Context — `ID: <id>` for support lookups
 *   9. Actions — Approve / Reject buttons (PENDING only)
 *
 * Every field added for this layout is OPTIONAL on `LeaveBlockInput`, so a
 * caller that hasn't been updated still renders a valid message rather than
 * printing "undefined".
 *
 * Same builder runs for the INITIAL chat.postMessage AND every
 * subsequent chat.update — the only thing that changes is `status`.
 * That gives the channel ONE message per leave, mutated in place.
 *
 * Action IDs encode the leave ID so the interactive controller
 * can route by prefix:
 *   approve_leave_<id>  /  reject_leave_<id>
 *
 * Future modules adding their own action_ids should follow the same
 * `<verb>_<resource>_<id>` snake_case convention.
 */

/**
 * Heading emoji by leave type CODE.
 *
 * Leave types are admin-created and their code is derived from the name, so
 * this can never be exhaustive — an unmapped type gets the neutral 📋 rather
 * than a wrong-but-confident icon.
 */
const TYPE_EMOJI: Record<string, string> = {
    SL: '🏥',
    CL: '🌴',
    WFH: '🏠',
    COMP_OFF: '🔁',
};
const DEFAULT_TYPE_EMOJI = '📋';

/** Coloured dot for the decision line — distinct from the status glyph in
 *  the heading so the two lines don't read as a repeat. */
const STATUS_DOT: Record<LeaveRequestStatus, string> = {
    pending: '🟡',
    approved: '🟢',
    rejected: '🔴',
    cancelled: '⚪',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-08-31` → `Aug 31, 2026`.
 *
 * Parsed by hand rather than via `new Date(...)`: these are calendar dates
 * with no time zone, and `new Date('2026-08-31')` is parsed as UTC midnight,
 * which renders as the PREVIOUS day for anyone behind UTC.
 */
const prettyDate = (iso?: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
    if (!m) return iso ?? '—';
    const month = MONTHS[Number(m[2]) - 1] ?? m[2];
    return `${month} ${Number(m[3])}, ${m[1]}`;
};

/** `team_lead` → `Team Lead`. */
const prettyRole = (role?: string): string =>
    (role ?? '')
        .split('_')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');

const durationText = (leave: LeaveBlockInput): string => {
    if (leave.is_half_day) return 'Half day';
    const d = leave.total_days;
    if (d === undefined || d === null) {
        // No count passed (a legacy caller) — say nothing rather than "0 days".
        return leave.start_date === leave.end_date ? '1 day' : '—';
    }
    return `${d} ${d === 1 ? 'day' : 'days'}`;
};

const STATUS_LABEL: Record<LeaveRequestStatus, string> = {
    pending: 'Pending',
    approved: 'Approved',
    rejected: 'Rejected',
    cancelled: 'Cancelled',
};

/**
 * Minimal projection the builder needs. Callers pass a denormalised
 * view of the leave + the employee + the type so the builder doesn't
 * have to chase populations of its own.
 */
export interface LeaveBlockInput {
    _id: string;
    employee_name: string;
    /** Shown under the name. Optional so a caller that hasn't been updated
     *  still renders — every field added for the redesign is optional. */
    employee_email?: string;
    /** Raw role key (`team_lead`); title-cased for display. */
    employee_role?: string;
    /** "SL — Sick Leave". Retained as the heading FALLBACK. */
    type_label: string;
    /** Leave type code, used only to pick the heading emoji. */
    type_code?: string;
    /** "Sick Leave" — preferred in the heading, where the code is noise. */
    type_name?: string;
    /** YYYY-MM-DD */
    start_date: string;
    /** YYYY-MM-DD */
    end_date: string;
    total_days?: number;
    reason?: string;
    is_half_day?: boolean;
}

interface BuilderArgs {
    status: LeaveRequestStatus;
    /** Renderer-side display name for "Approved by …" / "Rejected by …"
     *  line. Skip for pending and cancelled-by-employee. */
    decided_by?: string;
    /** YYYY-MM-DD the decision was taken. */
    decided_on?: string;
}

interface HeaderBlock {
    type: 'header';
    text: { type: 'plain_text'; text: string };
}
interface SectionBlock {
    type: 'section';
    /** A section carries EITHER `text` or `fields`, never both. */
    text?: { type: 'mrkdwn'; text: string };
    fields?: Array<{ type: 'mrkdwn'; text: string }>;
}
interface DividerBlock {
    type: 'divider';
}
interface ContextBlock {
    type: 'context';
    elements: Array<{ type: 'mrkdwn'; text: string }>;
}
interface ActionsBlock {
    type: 'actions';
    elements: Array<{
        type: 'button';
        style?: 'primary' | 'danger';
        text: { type: 'plain_text'; text: string };
        action_id: string;
        value: string;
    }>;
}
export type LeaveBlock = HeaderBlock | SectionBlock | ContextBlock | ActionsBlock | DividerBlock;

export const buildLeaveMessageBlocks = (leave: LeaveBlockInput, args: BuilderArgs): LeaveBlock[] => {
    const mrkdwn = (text: string): SectionBlock => ({ type: 'section', text: { type: 'mrkdwn', text } });
    const field = (label: string, value: string) => ({ type: 'mrkdwn' as const, text: `*${label}*\n${value}` });

    const typeEmoji = TYPE_EMOJI[leave.type_code ?? ''] ?? DEFAULT_TYPE_EMOJI;
    // The code is noise in the heading ("SL — Sick Leave"); the name reads
    // better. `type_label` stays the fallback for callers not yet passing a
    // name, so nothing renders blank.
    const typeText = leave.type_name ?? leave.type_label;

    const blocks: LeaveBlock[] = [mrkdwn(`${typeEmoji} *${typeText}*  •  ${STATUS_LABEL[args.status]}`)];

    // Who decided, and when. Nothing to say while pending, and a self-cancel
    // deliberately names nobody — "Cancelled by <the person who cancelled
    // their own leave>" reads like someone else intervened.
    if (args.status !== 'pending' && args.decided_by) {
        const on = args.decided_on ? ` on ${prettyDate(args.decided_on)}` : '';
        blocks.push({
            type: 'context',
            elements: [
                {
                    type: 'mrkdwn',
                    text: `${STATUS_DOT[args.status]} ${STATUS_LABEL[args.status]} by ${args.decided_by}${on}`,
                },
            ],
        });
    }

    blocks.push({ type: 'divider' });

    // Requester identity. The role and email are what let a reviewer act on
    // a name they don't recognise without leaving Slack.
    const role = prettyRole(leave.employee_role);
    const who = role ? `*${leave.employee_name}*  •  ${role}` : `*${leave.employee_name}*`;
    blocks.push(mrkdwn(leave.employee_email ? `${who}\n${leave.employee_email}` : who));

    blocks.push({ type: 'divider' });

    blocks.push({
        type: 'section',
        fields: [
            field('📅 From', prettyDate(leave.start_date)),
            field('📅 To', prettyDate(leave.end_date)),
            field('⏱ Duration', durationText(leave)),
            field('✅ Status', STATUS_LABEL[args.status]),
        ],
    });

    blocks.push(mrkdwn(`💬 *Reason*\n${leave.reason && leave.reason.trim().length > 0 ? leave.reason : '—'}`));

    // Support lookup. Deliberately in a `context` block — small and grey, so
    // it's there when someone needs it without competing with the content.
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `ID: ${leave._id}` }] });

    if (args.status === 'pending') {
        blocks.push({
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    style: 'primary',
                    text: { type: 'plain_text', text: 'Approve' },
                    action_id: `approve_leave_${leave._id}`,
                    value: leave._id,
                },
                {
                    type: 'button',
                    style: 'danger',
                    text: { type: 'plain_text', text: 'Reject' },
                    action_id: `reject_leave_${leave._id}`,
                    value: leave._id,
                },
            ],
        });
    }

    return blocks;
};
