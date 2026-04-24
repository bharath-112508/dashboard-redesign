import { Types } from 'mongoose';

import { Notification, type NotificationDocument } from '../models/notification.model.js';
import { User, type UserDocument } from '../models/user.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { NOTIFICATION_TYPES, RELATED_ENTITY_KINDS, type NotificationType } from '../constants/notification.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import logger from '../utils/logger.js';
import { sendEmail } from '../utils/mailer.js';
import {
    renderCorrectionDecidedEmail,
    renderCorrectionSubmittedEmail,
    renderLeaveDecisionEmail,
    renderLeaveSubmittedEmail,
    renderUserInviteEmail,
    type RenderedEmail,
} from '../utils/email-templates.js';

/**
 * Notification dispatcher (Step 11; Company_Management_Plan §6.2).
 *
 * Public surface: one `notify…` per business event. Each helper:
 *   1. Resolves recipients (single user or fan-out to manager+admin pool).
 *   2. Writes one in-app `notifications` row per recipient.
 *   3. Sends a best-effort email per recipient via `mailer.sendEmail`.
 *   4. NEVER throws — all errors are caught and logged at `warn` with the
 *      canonical `NOTIFICATION_DISPATCH_FAILED` error code so the primary
 *      business action (apply leave / approve correction / etc.) still
 *      returns 2xx as required by API_Contract §15.500.
 *
 * Slack channel is intentionally a no-op slot — adding it later (Step 25,
 * Phase 2) means dropping a `sendSlack(...)` call into `dispatchToRecipient`
 * without touching any of the per-event helpers.
 *
 * Implementation notes:
 *   - We deliberately do NOT use a worker queue here. The fan-out is small
 *     (typically <20 reviewers) and Mongo + the mail stub are fast enough
 *     that an awaited `Promise.all` is fine for Phase 1. When email moves
 *     to ACS we can revisit if latency becomes user-visible.
 *   - Recipient resolution always excludes the actor — nobody enjoys getting
 *     "you submitted a leave" notifications about their own action.
 *   - All failures are logged with `dispatch_event` + `recipient_id` (or the
 *     pool when the fetch itself fails) so an operator can grep the log for
 *     specific stuck recipients.
 */

// ─── Types ────────────────────────────────────────────────────────────────

/**
 * Identifies the user who triggered the dispatching event. Call-sites pass
 * the id only; the dispatcher resolves the display name internally so each
 * consumer doesn't have to fetch the user just to render a notification.
 */
export interface ActorRef {
    id: Types.ObjectId;
}

interface NotificationPayload {
    type: NotificationType;
    title: string;
    body: string;
    link_url: string;
    related_entity?: { kind: string; id: Types.ObjectId } | null;
}

type RecipientUser = Pick<UserDocument, '_id' | 'email' | 'full_name' | 'role'>;

// ─── Internal: per-recipient fan-out ─────────────────────────────────────

const dispatchToRecipient = async (
    recipient: RecipientUser,
    payload: NotificationPayload,
    email: RenderedEmail | null,
    context: string
): Promise<NotificationDocument | null> => {
    let inAppRow: NotificationDocument | null = null;

    // 1. In-app — the source-of-truth channel. If this fails we still try
    // email so the user isn't completely silenced.
    try {
        inAppRow = await Notification.create({
            user_id: recipient._id,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            link_url: payload.link_url,
            related_entity: payload.related_entity ?? null,
            is_read: false,
            read_at: null,
        });
    } catch (err) {
        logger.warn(
            {
                err,
                code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED,
                channel: 'in_app',
                dispatch_event: context,
                recipient_id: recipient._id.toString(),
            },
            'Notification in-app write failed'
        );
    }

    // 2. Email — best effort. Failure here does not affect the in-app row.
    if (email) {
        try {
            await sendEmail({
                to: recipient.email,
                subject: email.subject,
                html: email.html,
                text: email.text,
                context,
            });
        } catch (err) {
            logger.warn(
                {
                    err,
                    code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED,
                    channel: 'email',
                    dispatch_event: context,
                    recipient_id: recipient._id.toString(),
                },
                'Notification email send failed'
            );
        }
    }

    return inAppRow;
};

// ─── Internal: recipient resolution ──────────────────────────────────────

/**
 * Active managers + admins, optionally excluding a single user (typically
 * the actor of the triggering event). Returns the minimal projection the
 * dispatcher needs.
 */
const findReviewerPool = async (excludeUserId?: Types.ObjectId): Promise<RecipientUser[]> => {
    const filter: Record<string, unknown> = {
        role: { $in: [ROLES.ADMIN, ROLES.MANAGER] },
        status: USER_STATUSES.ACTIVE,
    };
    if (excludeUserId) filter._id = { $ne: excludeUserId };

    const rows = await User.find(filter).select('_id email full_name role').lean<RecipientUser[]>();
    return rows ?? [];
};

const findUserById = async (id: Types.ObjectId): Promise<RecipientUser | null> => {
    return (await User.findById(id).select('_id email full_name role').lean<RecipientUser>()) ?? null;
};

const resolveActorName = async (actor: ActorRef, fallback = 'a user'): Promise<string> => {
    const u = await findUserById(actor.id);
    return u?.full_name ?? fallback;
};

// ─── Public API: leave events ────────────────────────────────────────────

export interface LeaveDispatchInput {
    request_id: Types.ObjectId;
    requester_id: Types.ObjectId;
    leave_type_label: string;
    start_date: string;
    end_date: string;
    total_days: number;
}

export const notifyLeaveSubmitted = async (input: LeaveDispatchInput): Promise<void> => {
    const context = 'notify.leave_submitted';
    try {
        const [requester, reviewers] = await Promise.all([
            findUserById(input.requester_id),
            findReviewerPool(input.requester_id),
        ]);
        if (!requester) {
            logger.warn({ context, requester_id: input.requester_id.toString() }, 'requester missing — skipping');
            return;
        }
        if (reviewers.length === 0) {
            logger.info({ context }, 'No active reviewers — leave submission notification skipped');
            return;
        }

        const linkUrl = `/leaves/${input.request_id.toString()}`;
        const payloadBase = {
            type: NOTIFICATION_TYPES.LEAVE_REQUESTED,
            link_url: linkUrl,
            related_entity: { kind: RELATED_ENTITY_KINDS.LEAVE_REQUEST, id: input.request_id },
        };

        await Promise.all(
            reviewers.map((r) =>
                dispatchToRecipient(
                    r,
                    {
                        ...payloadBase,
                        title: `Leave request from ${requester.full_name}`,
                        body: `${requester.full_name} requested ${input.leave_type_label} for ${input.start_date} → ${input.end_date} (${input.total_days} day${input.total_days === 1 ? '' : 's'}).`,
                    },
                    renderLeaveSubmittedEmail({
                        recipient_full_name: r.full_name,
                        requester_full_name: requester.full_name,
                        leave_type_label: input.leave_type_label,
                        start_date: input.start_date,
                        end_date: input.end_date,
                        total_days: input.total_days,
                        request_id: input.request_id.toString(),
                    }),
                    context
                )
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Leave-submitted dispatch failed'
        );
    }
};

export interface LeaveDecisionDispatchInput extends LeaveDispatchInput {
    decision: 'approved' | 'rejected' | 'cancelled';
    actor: ActorRef;
    remarks?: string | null;
}

export const notifyLeaveDecided = async (input: LeaveDecisionDispatchInput): Promise<void> => {
    const context = `notify.leave_${input.decision}`;
    try {
        const requester = await findUserById(input.requester_id);
        if (!requester) {
            logger.warn({ context, requester_id: input.requester_id.toString() }, 'requester missing — skipping');
            return;
        }
        const actorName = await resolveActorName(input.actor);
        const actorIsRequester = input.actor.id.equals(input.requester_id);

        const typeMap: Record<LeaveDecisionDispatchInput['decision'], NotificationType> = {
            approved: NOTIFICATION_TYPES.LEAVE_APPROVED,
            rejected: NOTIFICATION_TYPES.LEAVE_REJECTED,
            cancelled: NOTIFICATION_TYPES.LEAVE_CANCELLED,
        };

        const range =
            input.start_date === input.end_date ? input.start_date : `${input.start_date} → ${input.end_date}`;

        const linkUrl = `/leaves/${input.request_id.toString()}`;

        // Recipient set:
        //  - approved/rejected: only the requester learns the verdict.
        //  - cancelled: requester (when an admin cancelled on their behalf)
        //    AND the manager/admin pool minus the canceller, so reviewers
        //    don't keep working on a withdrawn item.
        const recipients: RecipientUser[] = [];
        if (!actorIsRequester) recipients.push(requester);
        if (input.decision === 'cancelled') {
            const reviewers = await findReviewerPool(input.actor.id);
            // De-dupe: skip the requester (already in the list) so they
            // don't get two rows for the same event.
            recipients.push(...reviewers.filter((r) => !r._id.equals(input.requester_id)));
        }

        if (recipients.length === 0) {
            logger.info({ context }, 'No recipients to notify (actor is the only stakeholder)');
            return;
        }

        const verb = input.decision;
        const titleByDecision = {
            approved: 'Your leave request was approved',
            rejected: 'Your leave request was rejected',
            cancelled: 'Leave request cancelled',
        } as const;

        await Promise.all(
            recipients.map((r) => {
                const isRequester = r._id.equals(input.requester_id);
                const title = isRequester ? titleByDecision[input.decision] : `Leave request cancelled by ${actorName}`;
                const body = isRequester
                    ? `Your ${input.leave_type_label} request for ${range} (${input.total_days} day${input.total_days === 1 ? '' : 's'}) was ${verb}` +
                      (actorIsRequester ? '.' : ` by ${actorName}.`)
                    : `${requester.full_name}'s ${input.leave_type_label} request for ${range} was cancelled by ${actorName}.`;

                return dispatchToRecipient(
                    r,
                    {
                        type: typeMap[input.decision],
                        title,
                        body,
                        link_url: linkUrl,
                        related_entity: { kind: RELATED_ENTITY_KINDS.LEAVE_REQUEST, id: input.request_id },
                    },
                    isRequester
                        ? renderLeaveDecisionEmail({
                              recipient_full_name: r.full_name,
                              decision: input.decision,
                              leave_type_label: input.leave_type_label,
                              start_date: input.start_date,
                              end_date: input.end_date,
                              total_days: input.total_days,
                              request_id: input.request_id.toString(),
                              actor_full_name: actorIsRequester ? undefined : actorName,
                              remarks: input.remarks ?? null,
                          })
                        : null,
                    context
                );
            })
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Leave-decision dispatch failed'
        );
    }
};

// ─── Public API: attendance-correction events ────────────────────────────

export interface CorrectionSubmittedDispatchInput {
    request_id: Types.ObjectId;
    requester_id: Types.ObjectId;
    local_date: string;
}

export const notifyAttendanceCorrectionSubmitted = async (input: CorrectionSubmittedDispatchInput): Promise<void> => {
    const context = 'notify.attendance_correction_submitted';
    try {
        const [requester, reviewers] = await Promise.all([
            findUserById(input.requester_id),
            findReviewerPool(input.requester_id),
        ]);
        if (!requester) {
            logger.warn({ context, requester_id: input.requester_id.toString() }, 'requester missing — skipping');
            return;
        }
        if (reviewers.length === 0) {
            logger.info({ context }, 'No active reviewers — correction submitted notification skipped');
            return;
        }

        const linkUrl = `/attendance/correction-requests/${input.request_id.toString()}`;
        await Promise.all(
            reviewers.map((r) =>
                dispatchToRecipient(
                    r,
                    {
                        type: NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REQUESTED,
                        title: `Attendance correction from ${requester.full_name}`,
                        body: `${requester.full_name} requested a correction for their attendance on ${input.local_date}.`,
                        link_url: linkUrl,
                        related_entity: {
                            kind: RELATED_ENTITY_KINDS.ATTENDANCE_CORRECTION_REQUEST,
                            id: input.request_id,
                        },
                    },
                    renderCorrectionSubmittedEmail({
                        recipient_full_name: r.full_name,
                        requester_full_name: requester.full_name,
                        local_date: input.local_date,
                        request_id: input.request_id.toString(),
                    }),
                    context
                )
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Correction-submitted dispatch failed'
        );
    }
};

export interface CorrectionDecidedDispatchInput {
    request_id: Types.ObjectId;
    requester_id: Types.ObjectId;
    local_date: string;
    decision: 'approved' | 'rejected';
    actor: ActorRef;
    remarks?: string | null;
}

export const notifyAttendanceCorrectionDecided = async (input: CorrectionDecidedDispatchInput): Promise<void> => {
    const context = `notify.attendance_correction_${input.decision}`;
    try {
        const requester = await findUserById(input.requester_id);
        if (!requester) {
            logger.warn({ context, requester_id: input.requester_id.toString() }, 'requester missing — skipping');
            return;
        }
        // Don't notify when the actor is the requester (admins reviewing
        // their own request would be odd, but handle the edge case).
        if (input.actor.id.equals(input.requester_id)) {
            return;
        }
        const actorName = await resolveActorName(input.actor);

        const linkUrl = `/attendance/correction-requests/${input.request_id.toString()}`;

        await dispatchToRecipient(
            requester,
            {
                type: NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_DECIDED,
                title: `Your attendance correction was ${input.decision}`,
                body: `Your attendance correction request for ${input.local_date} was ${input.decision} by ${actorName}.`,
                link_url: linkUrl,
                related_entity: {
                    kind: RELATED_ENTITY_KINDS.ATTENDANCE_CORRECTION_REQUEST,
                    id: input.request_id,
                },
            },
            renderCorrectionDecidedEmail({
                recipient_full_name: requester.full_name,
                decision: input.decision,
                local_date: input.local_date,
                request_id: input.request_id.toString(),
                actor_full_name: actorName,
                remarks: input.remarks ?? null,
            }),
            context
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Correction-decision dispatch failed'
        );
    }
};

// ─── Public API: user invite ─────────────────────────────────────────────
//
// Email-only — invitee has no session yet, so the in-app bell is irrelevant.
// We deliberately accept `initial_password` here because in Phase 1 admins
// pick the seed password at create time. When the "magic link onboarding"
// flow lands (Phase 2 polish) this signature will swap to a one-time URL.

export interface UserInviteDispatchInput {
    recipient_user_id: Types.ObjectId;
    invited_by: ActorRef;
    initial_password: string;
}

export const notifyUserInvited = async (input: UserInviteDispatchInput): Promise<void> => {
    const context = 'notify.user_invited';
    try {
        const recipient = await findUserById(input.recipient_user_id);
        if (!recipient) {
            logger.warn({ context, recipient_id: input.recipient_user_id.toString() }, 'recipient missing — skipping');
            return;
        }
        const invitedByName = await resolveActorName(input.invited_by, 'Your administrator');

        const email = renderUserInviteEmail({
            recipient_full_name: recipient.full_name,
            invited_by_name: invitedByName,
            initial_password: input.initial_password,
        });

        await sendEmail({
            to: recipient.email,
            subject: email.subject,
            html: email.html,
            text: email.text,
            context,
        });
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'User-invite dispatch failed'
        );
    }
};
