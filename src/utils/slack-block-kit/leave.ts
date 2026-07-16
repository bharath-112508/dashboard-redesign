import type { LeaveRequestStatus } from '../../constants/leave.js';

/**
 * Phase 1 — Block Kit blocks for a leave-request Slack message.
 *
 * Layout:
 *   1. Header  — employee name + date range
 *   2. Section — leave type · reason
 *   3. Context — status pill + decided-by line (when not pending)
 *   4. Actions — Approve / Reject buttons (PENDING only)
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

const STATUS_EMOJI: Record<LeaveRequestStatus, string> = {
    pending: '⏳',
    approved: '✅',
    rejected: '❌',
    cancelled: '🚫',
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
    type_label: string;
    /** YYYY-MM-DD */
    start_date: string;
    /** YYYY-MM-DD */
    end_date: string;
    reason?: string;
    is_half_day?: boolean;
}

interface BuilderArgs {
    status: LeaveRequestStatus;
    /** Renderer-side display name for "Approved by …" / "Rejected by …"
     *  line. Skip for pending and cancelled-by-employee. */
    decided_by?: string;
}

interface HeaderBlock {
    type: 'header';
    text: { type: 'plain_text'; text: string };
}
interface SectionBlock {
    type: 'section';
    fields: Array<{ type: 'mrkdwn'; text: string }>;
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
export type LeaveBlock = HeaderBlock | SectionBlock | ContextBlock | ActionsBlock;

export const buildLeaveMessageBlocks = (leave: LeaveBlockInput, args: BuilderArgs): LeaveBlock[] => {
    const range =
        leave.start_date === leave.end_date
            ? `${leave.start_date}${leave.is_half_day ? ' (half day)' : ''}`
            : `${leave.start_date} → ${leave.end_date}`;

    const blocks: LeaveBlock[] = [
        {
            type: 'header',
            text: { type: 'plain_text', text: `${leave.employee_name} · ${range}` },
        },
        {
            type: 'section',
            fields: [
                { type: 'mrkdwn', text: `*Type*\n${leave.type_label}` },
                {
                    type: 'mrkdwn',
                    text: `*Reason*\n${leave.reason && leave.reason.trim().length > 0 ? leave.reason : '_none_'}`,
                },
            ],
        },
    ];

    const statusLine =
        args.status === 'pending'
            ? `${STATUS_EMOJI[args.status]} ${STATUS_LABEL[args.status]}`
            : `${STATUS_EMOJI[args.status]} ${STATUS_LABEL[args.status]}${
                  args.decided_by ? ` by ${args.decided_by}` : ''
              }`;

    blocks.push({
        type: 'context',
        elements: [{ type: 'mrkdwn', text: statusLine }],
    });

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
