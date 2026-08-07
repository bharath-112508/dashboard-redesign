import { Types } from 'mongoose';

import { Notification, type NotificationDocument } from '../models/notification.model.js';
import { User, type UserDocument } from '../models/user.model.js';
import { Project } from '../models/project.model.js';
import { ROLES } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { NOTIFICATION_TYPES, RELATED_ENTITY_KINDS, type NotificationType } from '../constants/notification.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { REALTIME_TOPICS } from '../constants/realtime.js';
import { publish } from './realtime.service.js';
import logger from '../utils/logger.js';
import { sendEmail } from '../utils/mailer.js';
import { postOrUpdateSlackMessage, postSlackMessage, slackContextFrom, type SlackContext } from '../utils/slack.js';
import { buildLeaveMessageBlocks } from '../utils/slack-block-kit/leave.js';
import { LeaveRequest } from '../models/leave-request.model.js';
import { isPushConfigured, sendPushNotification, type PushPayload } from '../utils/push.js';
import { listSubscriptionsForUser } from './push-subscription.service.js';
import { runWithConcurrency } from '../utils/run-with-concurrency.js';

/**
 * Per-event recipient fan-out cap (BACKEND_AUDIT.md R11). Keeps a
 * 50-member project from blasting 50 parallel `sendEmail` calls past
 * ACS / Mailjet burst caps. Five concurrent dispatches is enough for
 * a typical event to finish within a normal request timeout; downstream
 * services see at most 5 sustained requests at a time per platform
 * instance.
 */
const NOTIFICATION_FAN_OUT_CONCURRENCY = 5;
import { NOTIFICATION_TYPE_TO_SLACK_CATEGORY, type SlackEventCategory } from '../constants/slack.js';
import type { SlackChannelMap } from '../models/system-settings.model.js';
import { getOrInitSettings } from './settings.service.js';
import {
    renderCorrectionDecidedEmail,
    renderCorrectionSubmittedEmail,
    renderLeaveDecisionEmail,
    renderLeaveSubmittedEmail,
    renderTaskCommentMentionEmail,
    renderTimesheetReminderEmail,
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
 * Slack — Step 25 wired in. Each `notify*` calls `loadSlackDispatch`
 * once per event; broadcast posts to the type-mapped channel; per-recipient
 * DM is fired inside `dispatchToRecipient` when the recipient has set
 * `slack_user_id` AND not opted out via `slack_notifications_enabled`.
 * All paths are gated on `system_settings.slack.enabled` + bot token
 * configured.
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

type RecipientUser = Pick<
    UserDocument,
    | '_id'
    | 'email'
    | 'full_name'
    | 'role'
    | 'slack_user_id'
    | 'slack_notifications_enabled'
    | 'push_notifications_enabled'
>;

// ─── Internal: per-recipient fan-out ─────────────────────────────────────

const dispatchToRecipient = async (
    recipient: RecipientUser,
    payload: NotificationPayload,
    email: RenderedEmail | null,
    context: string,
    slack?: SlackDispatch | null
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
        // Wake the recipient's notification bell NOW. The realtime-emit
        // middleware derives its topic from the REQUEST PATH, so a
        // notification born as a side effect of some other write (assigning
        // a task, approving leave, a comment) only ever published that
        // route's topic — never `notifications`. The bell then sat stale
        // until the 120s fallback poll or a manual refresh, which is exactly
        // the "notifications aren't real-time" report.
        //
        // Publishing here rather than at each call site means every current
        // AND future dispatch path is covered, including the cron-driven
        // ones that have no HTTP request for the middleware to inspect.
        publish([REALTIME_TOPICS.NOTIFICATIONS]);
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

    // 3. Slack DM — Step 25. Best-effort (`postSlackMessage` swallows
    // its own errors). Gated on three conditions:
    //   (a) Slack workspace is configured + enabled — passed in as
    //       `slack` from the caller (loaded once per event so we don't
    //       hit the settings collection per recipient).
    //   (b) Recipient supplied a `slack_user_id` — implicit opt-in.
    //   (c) Recipient hasn't explicitly toggled `slack_notifications_enabled = false`.
    if (slack && recipient.slack_user_id && recipient.slack_notifications_enabled !== false) {
        await postSlackMessage(slack.ctx, {
            channel: recipient.slack_user_id,
            text: buildSlackText(payload),
            context: `${context}.dm`,
        });
    }

    // 4. Web Push — V2-BE-10. Best-effort (`sendPushNotification`
    // swallows its own errors and auto-prunes 410/404 endpoints).
    // Gated on:
    //   (a) VAPID is configured (`isPushConfigured()` is a pure
    //       sync env check; no DB hit, so we don't need to pass it
    //       through from the caller like the Slack workspace state).
    //   (b) Recipient has at least one stored subscription (zero rows
    //       skips the inner loop entirely).
    //   (c) Recipient hasn't toggled `push_notifications_enabled = false`
    //       — kept symmetrical with the Slack opt-out.
    if (isPushConfigured() && recipient.push_notifications_enabled !== false) {
        try {
            const subscriptions = await listSubscriptionsForUser(recipient._id);
            if (subscriptions.length > 0) {
                const pushPayload: PushPayload = {
                    title: payload.title,
                    body: payload.body,
                    link_url: payload.link_url,
                    type: payload.type,
                    related_id: inAppRow?._id.toString(),
                };
                // Sequential per recipient — most users have 1-2 subs.
                // Outer parallelism is already handled by
                // `runWithConcurrency(5)` across recipients.
                for (const subscription of subscriptions) {
                    await sendPushNotification({
                        subscription,
                        payload: pushPayload,
                        context: `${context}.push`,
                    });
                }
            }
        } catch (err) {
            logger.warn(
                {
                    err,
                    code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED,
                    channel: 'push',
                    dispatch_event: context,
                    recipient_id: recipient._id.toString(),
                },
                'Notification push fan-out failed'
            );
        }
    }

    return inAppRow;
};

// ─── Slack: per-event setup + broadcast ──────────────────────────────────

interface SlackDispatch {
    ctx: SlackContext;
    channels: SlackChannelMap;
}

/**
 * Load the Slack section once per `notify*` invocation. Returns null
 * (and no error) when Slack is disabled or unconfigured — the dispatcher
 * paths that consume this short-circuit cleanly without logging spam.
 *
 * Intentionally never throws: a stuck settings collection should not
 * block the email/in-app fan-out, and the wider notification dispatcher
 * already swallows failures.
 *
 * The category mapping happens at broadcast time via
 * `NOTIFICATION_TYPE_TO_SLACK_CATEGORY` — this loader is type-agnostic.
 */
const loadSlackDispatch = async (): Promise<SlackDispatch | null> => {
    try {
        const settings = await getOrInitSettings();
        const ctx = slackContextFrom(settings.slack);
        if (!ctx) return null;
        return { ctx, channels: settings.slack.channels };
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.SLACK_DISPATCH_FAILED },
            'Failed to load Slack settings — skipping Slack fan-out'
        );
        return null;
    }
};

/**
 * Plain-text Slack body. The notification's `title` + `body` fields
 * are already prose; the matching email template (when present) is
 * HTML so we don't reuse it here. Slack mrkdwn would let us format
 * with `*bold*` but for v1 we keep the body as a single text run
 * that's safe to paste anywhere — channel post, DM, or future audit
 * replay.
 */
const buildSlackText = (payload: NotificationPayload): string => {
    const link = payload.link_url ? ` (${payload.link_url})` : '';
    return `${payload.title}\n${payload.body}${link}`;
};

/**
 * Fire a single channel broadcast for the given event. Caller has
 * already loaded the Slack dispatch context (`loadSlackDispatch`)
 * so this is a pure mapping + send. Best-effort.
 */
const dispatchSlackBroadcast = async (
    slack: SlackDispatch,
    type: NotificationType,
    text: string,
    context: string
): Promise<void> => {
    const category: SlackEventCategory = NOTIFICATION_TYPE_TO_SLACK_CATEGORY[type];
    const channel = slack.channels[category];
    if (!channel) return;
    await postSlackMessage(slack.ctx, {
        channel,
        text,
        context: `${context}.broadcast`,
    });
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

    const rows = await User.find(filter)
        .select('_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled')
        .lean<RecipientUser[]>();
    return rows ?? [];
};

/**
 * Recipients for a NEW approval request — leave or attendance correction:
 * the employee's reporting manager AND every active admin.
 *
 * This used to be manager-OR-admins — admins were the fallback only when no
 * active reporting manager was set. That left a request visible to exactly
 * one person, so if that manager was away (or simply slow) nothing surfaced
 * it to anyone who could also approve, and the request just sat. Admins hold
 * `leave_request.approve`, so they are legitimate reviewers, not bystanders.
 *
 * Still NOT every manager/team-lead — the routing stays targeted, it just
 * always includes the admin backstop. The requester is excluded (nobody
 * reviews their own request) and the list is de-duplicated, so an admin who
 * IS the reporting manager gets one notification, not two.
 */
const RECIPIENT_SELECT =
    '_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled';

const findRequestReviewersFor = async (requesterId: Types.ObjectId): Promise<RecipientUser[]> => {
    const requester = await User.findById(requesterId)
        .select('internal_profile.reporting_manager_id')
        .lean<{ internal_profile?: { reporting_manager_id?: Types.ObjectId | null } }>();
    const managerId = requester?.internal_profile?.reporting_manager_id ?? null;

    const [manager, admins] = await Promise.all([
        managerId
            ? User.findOne({ _id: managerId, status: USER_STATUSES.ACTIVE })
                  .select(RECIPIENT_SELECT)
                  .lean<RecipientUser>()
            : Promise.resolve(null),
        User.find({ role: ROLES.ADMIN, status: USER_STATUSES.ACTIVE }).select(RECIPIENT_SELECT).lean<RecipientUser[]>(),
    ]);

    const byId = new Map<string, RecipientUser>();
    if (manager) byId.set(String(manager._id), manager);
    for (const a of admins ?? []) byId.set(String(a._id), a);
    // An admin applying for their own leave must not be told about it.
    byId.delete(String(requesterId));
    return [...byId.values()];
};

const findUserById = async (id: Types.ObjectId): Promise<RecipientUser | null> => {
    return (
        (await User.findById(id)
            .select('_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled')
            .lean<RecipientUser>()) ?? null
    );
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
    /** Surfaced in the Slack channel message body. Falls back to
     *  "_none_" when absent. */
    reason?: string;
    /** Tags the date range with "(half day)" in the Slack message. */
    is_half_day?: boolean;
}

export const notifyLeaveSubmitted = async (input: LeaveDispatchInput): Promise<void> => {
    const context = 'notify.leave_submitted';
    try {
        const [requester, reviewers] = await Promise.all([
            findUserById(input.requester_id),
            // Route to the employee's reporting manager (fallback: admins),
            // instead of pinging every manager/admin.
            findRequestReviewersFor(input.requester_id),
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
        const broadcastBody = `${requester.full_name} requested ${input.leave_type_label} for ${input.start_date} → ${input.end_date} (${input.total_days} day${input.total_days === 1 ? '' : 's'}).`;

        // Step 25 — load Slack settings ONCE per event so the broadcast
        // and every per-recipient DM share a single settings read. Null
        // when Slack is disabled / unconfigured; downstream paths
        // short-circuit.
        const slack = await loadSlackDispatch();
        if (slack) {
            // Phase 1 — post a Block Kit message with Approve / Reject
            // buttons and persist Slack's `{channel, ts}` back to the
            // leave doc so subsequent state changes (`notifyLeaveDecided`)
            // can `chat.update` the SAME message in place.
            const channel = slack.channels.leaves;
            if (channel) {
                const slackResult = await postOrUpdateSlackMessage(slack.ctx, {
                    channel,
                    blocks: buildLeaveMessageBlocks(
                        {
                            _id: input.request_id.toString(),
                            employee_name: requester.full_name,
                            type_label: input.leave_type_label,
                            start_date: input.start_date,
                            end_date: input.end_date,
                            reason: input.reason,
                            is_half_day: input.is_half_day,
                        },
                        { status: 'pending' }
                    ),
                    text: `Leave request from ${requester.full_name} — ${broadcastBody}`,
                    existing: null,
                    context: `${context}.broadcast`,
                });
                if (slackResult.success && slackResult.ts && slackResult.channel) {
                    await LeaveRequest.findByIdAndUpdate(input.request_id, {
                        slack_message: {
                            channel: slackResult.channel,
                            ts: slackResult.ts,
                        },
                    });
                }
            }
        }

        // R11 — bounded fan-out so a 50-member project can't blast
        // 50 parallel email sends past ACS / Mailjet burst caps.
        await runWithConcurrency(reviewers, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
            dispatchToRecipient(
                r,
                {
                    ...payloadBase,
                    title: `Leave request from ${requester.full_name}`,
                    body: broadcastBody,
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
                context,
                slack
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

        // Phase 1 — edit the original leave message in-place via
        // `chat.update` (no fresh post per decision). The dispatcher
        // reads `slack_message` from the leave doc; legacy leaves
        // submitted before Phase 1 have `null` here and degrade to a
        // fresh post (still persisted back so any later state change
        // can update). Per-recipient DMs continue inside
        // `dispatchToRecipient` for the requester's verdict notice.
        const slack = await loadSlackDispatch();
        if (slack) {
            const channel = slack.channels.leaves;
            if (channel) {
                const leaveDoc = await LeaveRequest.findById(input.request_id).select('slack_message');
                const slackResult = await postOrUpdateSlackMessage(slack.ctx, {
                    channel,
                    blocks: buildLeaveMessageBlocks(
                        {
                            _id: input.request_id.toString(),
                            employee_name: requester.full_name,
                            type_label: input.leave_type_label,
                            start_date: input.start_date,
                            end_date: input.end_date,
                            reason: input.reason,
                            is_half_day: input.is_half_day,
                        },
                        {
                            status: input.decision,
                            // Self-cancel — actor IS the requester. Skip the
                            // "by …" line; "Cancelled" on its own reads cleaner.
                            decided_by: actorIsRequester ? undefined : actorName,
                        }
                    ),
                    text: `Leave ${verb}: ${requester.full_name} — ${input.leave_type_label} ${range} (${input.total_days}d)${actorIsRequester ? '' : ` — by ${actorName}`}`,
                    existing: leaveDoc?.slack_message ?? null,
                    context: `${context}.broadcast`,
                });
                // If we just fell back to a fresh post (legacy leave),
                // persist the new coordinates so a later state change
                // (e.g. cancel after admin-approved this) can chat.update.
                if (!leaveDoc?.slack_message && slackResult.success && slackResult.ts && slackResult.channel) {
                    await LeaveRequest.findByIdAndUpdate(input.request_id, {
                        slack_message: {
                            channel: slackResult.channel,
                            ts: slackResult.ts,
                        },
                    });
                }
            }
        }

        // R11 — bounded fan-out.
        await runWithConcurrency(recipients, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) => {
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
                context,
                slack
            );
        });
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
            // Same routing as a leave request. This used to be the blanket
            // `findReviewerPool` — EVERY active admin and manager, whether or
            // not the requester reported to them — so one person's correction
            // pinged managers with no relationship to them.
            findRequestReviewersFor(input.requester_id),
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
        const slack = await loadSlackDispatch();
        if (slack) {
            await dispatchSlackBroadcast(
                slack,
                NOTIFICATION_TYPES.ATTENDANCE_CORRECTION_REQUESTED,
                `Attendance correction from ${requester.full_name} for ${input.local_date}`,
                context
            );
        }

        // R11 — bounded fan-out.
        await runWithConcurrency(reviewers, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
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
                context,
                slack
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

        // No broadcast for decisions — single requester is the only stakeholder.
        // The DM is handled inside `dispatchToRecipient` via `slack`.
        const slack = await loadSlackDispatch();

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
            context,
            slack
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

// ─── Public API: task comment mention ────────────────────────────────────
//
// Fan-out: one in-app row + one best-effort email per mentioned user.
// Author is excluded from the recipient list defensively (the service
// also de-dupes mentions before calling, but a self-mention shouldn't
// notify the author even if it slipped through).
//
// Slack channel is intentionally a no-op slot (Step 25, Phase 2) — the
// shared `dispatchToRecipient` helper will pick it up automatically once
// `sendSlack` lands.

export interface TaskCommentMentionDispatchInput {
    comment_id: Types.ObjectId;
    task_id: Types.ObjectId;
    project_id: Types.ObjectId;
    author_id: Types.ObjectId;
    mentioned_user_ids: Types.ObjectId[];
    /** Pre-sanitised, plain-text comment body. Used for the email preview. */
    body_preview: string;
}

// ─── Public API: task comment watchers (BUG-068) ────────────────────────
//
// Sibling of `notifyTaskCommentMention` for the broader watcher set —
// task assignee, collaborators, creator, prior commenters. Whoever sits
// closer to the task than just being @-mentioned. **In-app only**: the
// mention path keeps the email channel for the "you were tagged" call;
// everyone else gets a quiet bell ping that the comments tab refreshes
// to anyway. Caller is responsible for de-duping against the @mention
// set so a recipient never gets two rows for the same comment.

export interface LeaveReviewReassignedDispatchInput {
    request_id: Types.ObjectId;
    /** The manager the pending request has just become the responsibility of. */
    reviewer_id: Types.ObjectId;
    requester_name: string;
    leave_type_label: string;
    start_date: string;
    end_date: string;
}

/**
 * Tell ONE newly-assigned reviewer that a pending request is now theirs.
 *
 * Deliberately not `notifyLeaveSubmitted`: that fans out to the manager AND
 * every admin, so replaying it on a reporting-line change gave admins a second
 * copy of a request they were already told about. The handoff only needs to
 * reach the person who just inherited the queue.
 */
export const notifyLeaveReviewReassigned = async (input: LeaveReviewReassignedDispatchInput): Promise<void> => {
    const context = 'notify.leave_review_reassigned';
    try {
        const reviewer = await User.findOne({ _id: input.reviewer_id, status: USER_STATUSES.ACTIVE })
            .select(RECIPIENT_SELECT)
            .lean<RecipientUser>();
        if (!reviewer) return;

        await dispatchToRecipient(
            reviewer,
            {
                type: NOTIFICATION_TYPES.LEAVE_REQUESTED,
                title: `Leave request from ${input.requester_name} is now yours to review`,
                body: `${input.leave_type_label} for ${input.start_date} → ${input.end_date}. It moved to you when you became their reporting manager.`,
                link_url: `/leaves/${input.request_id.toString()}`,
                related_entity: {
                    kind: RELATED_ENTITY_KINDS.LEAVE_REQUEST,
                    id: input.request_id,
                },
            },
            null,
            context,
            null
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'dispatch failed'
        );
    }
};

/**
 * Person-affecting admin actions.
 *
 * Each of these is something done TO a user by somebody else — added to a
 * project, balance corrected, role changed. None of them notified anyone, so
 * the only way to find out was to stumble across the change. All are in-app
 * only: they're informational, not a call to action, and an email per balance
 * tweak would be noise.
 */
const notifyOne = async (userId: Types.ObjectId, payload: NotificationPayload, context: string): Promise<void> => {
    try {
        const recipient = await User.findOne({ _id: userId, status: USER_STATUSES.ACTIVE })
            .select(RECIPIENT_SELECT)
            .lean<RecipientUser>();
        if (!recipient) return;
        await dispatchToRecipient(recipient, payload, null, context, null);
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'dispatch failed'
        );
    }
};

export const notifyProjectMembersAdded = async (input: {
    project_id: Types.ObjectId;
    project_name: string;
    actor_id: Types.ObjectId;
    member_ids: Types.ObjectId[];
}): Promise<void> => {
    const actor = await findUserById(input.actor_id).catch(() => null);
    const actorName = actor?.full_name ?? 'Someone';
    // Never tell the actor they added themselves.
    for (const id of input.member_ids.filter((m) => !m.equals(input.actor_id))) {
        await notifyOne(
            id,
            {
                type: NOTIFICATION_TYPES.PROJECT_MEMBER_ADDED,
                title: `${actorName} added you to ${input.project_name}`,
                body: 'You can now see this project and everything under it.',
                link_url: `/projects/${input.project_id.toString()}`,
                related_entity: { kind: RELATED_ENTITY_KINDS.PROJECT, id: input.project_id },
            },
            'notify.project_member_added'
        );
    }
};

export const notifyLeaveBalanceAdjusted = async (input: {
    balance_id: Types.ObjectId;
    user_id: Types.ObjectId;
    actor_id: Types.ObjectId;
    leave_type_label: string;
    delta: number;
    reason: string;
}): Promise<void> => {
    if (input.user_id.equals(input.actor_id)) return;
    const actor = await findUserById(input.actor_id).catch(() => null);
    const sign = input.delta > 0 ? '+' : '';
    await notifyOne(
        input.user_id,
        {
            type: NOTIFICATION_TYPES.LEAVE_BALANCE_ADJUSTED,
            title: `Your ${input.leave_type_label} balance changed by ${sign}${input.delta}`,
            body: `${actor?.full_name ?? 'An administrator'} adjusted it: ${input.reason}`,
            link_url: '/leaves?tab=balances',
            related_entity: { kind: RELATED_ENTITY_KINDS.LEAVE_BALANCE, id: input.balance_id },
        },
        'notify.leave_balance_adjusted'
    );
};

export const notifyCompOffAdjusted = async (input: {
    user_id: Types.ObjectId;
    actor_id: Types.ObjectId;
    days: number;
    direction: 'earned' | 'consumed';
    remarks: string;
}): Promise<void> => {
    if (input.user_id.equals(input.actor_id)) return;
    const actor = await findUserById(input.actor_id).catch(() => null);
    const verb = input.direction === 'earned' ? 'credited' : 'deducted';
    await notifyOne(
        input.user_id,
        {
            type: NOTIFICATION_TYPES.COMP_OFF_ADJUSTED,
            title: `${input.days} comp-off day${input.days === 1 ? '' : 's'} ${verb}`,
            body: `${actor?.full_name ?? 'An administrator'} adjusted your comp-off: ${input.remarks}`,
            link_url: '/comp-off',
            related_entity: null,
        },
        'notify.comp_off_adjusted'
    );
};

export const notifyRoleChanged = async (input: {
    user_id: Types.ObjectId;
    actor_id: Types.ObjectId;
    role_labels: string[];
}): Promise<void> => {
    if (input.user_id.equals(input.actor_id)) return;
    const actor = await findUserById(input.actor_id).catch(() => null);
    await notifyOne(
        input.user_id,
        {
            type: NOTIFICATION_TYPES.ROLE_CHANGED,
            title: 'Your access level changed',
            body: `${actor?.full_name ?? 'An administrator'} set your role to ${input.role_labels.join(', ') || 'none'}. Sign out and back in if something looks missing.`,
            link_url: '/me?tab=roles',
            related_entity: { kind: RELATED_ENTITY_KINDS.USER, id: input.user_id },
        },
        'notify.role_changed'
    );
};

export interface TaskAssignedDispatchInput {
    task_id: Types.ObjectId;
    task_title: string;
    /** Who did the assigning — excluded from the recipients. */
    actor_id: Types.ObjectId;
    /** Newly-added assignees only. Callers must diff against the previous set. */
    assignee_ids: Types.ObjectId[];
}

/**
 * "X assigned you TaskTitle". Fires on task create with assignees and on any
 * PATCH that ADDS one — the diff is the caller's job so a re-save with an
 * unchanged roster doesn't re-notify.
 *
 * In-app only, deliberately: assignment churn during planning would make an
 * email/Slack channel unusable. `NOTIFICATION_TYPES.TASK_ASSIGNED` has been in
 * the enum (and the Slack category map) since the beginning with nothing
 * dispatching it — assigning work notified nobody.
 */
export const notifyTaskAssigned = async (input: TaskAssignedDispatchInput): Promise<void> => {
    const context = 'notify.task_assigned';
    try {
        const recipientIds = input.assignee_ids.filter((id) => !id.equals(input.actor_id));
        if (recipientIds.length === 0) return;

        // Sequential, not `Promise.all`: if the second expression throws
        // *synchronously* the first promise is already in flight with no
        // handler attached, and the try/catch below never sees it — it
        // surfaces as an unhandled rejection instead. Two round-trips on a
        // notification path is a fine price for that not happening.
        const actor = await findUserById(input.actor_id);
        const recipients = await User.find({
            _id: { $in: recipientIds },
            status: USER_STATUSES.ACTIVE,
        })
            .select('_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled')
            .lean<RecipientUser[]>();

        if (recipients.length === 0) {
            logger.info({ context }, 'No active recipients to notify');
            return;
        }

        const actorName = actor?.full_name ?? 'Someone';
        await runWithConcurrency(recipients, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
            dispatchToRecipient(
                r,
                {
                    type: NOTIFICATION_TYPES.TASK_ASSIGNED,
                    title: `${actorName} assigned you a task`,
                    body: input.task_title,
                    link_url: `/tasks/${input.task_id.toString()}`,
                    related_entity: { kind: RELATED_ENTITY_KINDS.TASK, id: input.task_id },
                },
                null,
                context,
                null
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'dispatch failed'
        );
    }
};

export interface TaskCommentWatcherDispatchInput {
    comment_id: Types.ObjectId;
    task_id: Types.ObjectId;
    project_id: Types.ObjectId;
    author_id: Types.ObjectId;
    /** Already de-duped + excludes the author + excludes anyone in mentions. */
    watcher_user_ids: Types.ObjectId[];
    /** Pre-sanitised, plain-text comment body. Used for the in-app body. */
    body_preview: string;
    /** Used in the in-app title so the bell drawer reads `"X commented on TaskTitle"`. */
    task_title: string;
}

export const notifyTaskCommentWatchers = async (input: TaskCommentWatcherDispatchInput): Promise<void> => {
    const context = 'notify.task_comment_watchers';
    try {
        if (input.watcher_user_ids.length === 0) return;

        const recipientIds = input.watcher_user_ids.filter((id) => !id.equals(input.author_id));
        if (recipientIds.length === 0) return;

        const [author, recipients] = await Promise.all([
            findUserById(input.author_id),
            User.find({ _id: { $in: recipientIds }, status: USER_STATUSES.ACTIVE })
                .select('_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled')
                .lean<RecipientUser[]>(),
        ]);

        if (!author) {
            logger.warn({ context, author_id: input.author_id.toString() }, 'author missing — skipping');
            return;
        }
        if (recipients.length === 0) {
            logger.info({ context }, 'No active recipients to notify');
            return;
        }

        const linkUrl = `/tasks/${input.task_id.toString()}`;
        // In-app body cap is NOTIFICATION_BODY_MAX (2 000). Defensive
        // truncate so a 5 000-char comment doesn't trip validation.
        const inAppBody =
            input.body_preview.length > 1_900 ? `${input.body_preview.slice(0, 1_900).trimEnd()}…` : input.body_preview;

        // Watchers get in-app only — pass null for email + skip slack to
        // keep this quieter than the mention path. The mention email is
        // the place to escalate; "someone you collaborate with commented"
        // shouldn't blow up everyone's inbox.
        await runWithConcurrency(recipients, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
            dispatchToRecipient(
                r,
                {
                    type: NOTIFICATION_TYPES.TASK_COMMENT,
                    title: `${author.full_name} commented on ${input.task_title}`,
                    body: inAppBody,
                    link_url: linkUrl,
                    related_entity: {
                        kind: RELATED_ENTITY_KINDS.TASK,
                        id: input.task_id,
                    },
                },
                null,
                context,
                null
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Task-comment watcher dispatch failed'
        );
    }
};

export const notifyTaskCommentMention = async (input: TaskCommentMentionDispatchInput): Promise<void> => {
    const context = 'notify.task_comment_mention';
    try {
        if (input.mentioned_user_ids.length === 0) return;

        const recipientIds = input.mentioned_user_ids.filter((id) => !id.equals(input.author_id));
        if (recipientIds.length === 0) return;

        const [author, recipients] = await Promise.all([
            findUserById(input.author_id),
            User.find({ _id: { $in: recipientIds }, status: USER_STATUSES.ACTIVE })
                .select('_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled')
                .lean<RecipientUser[]>(),
        ]);

        if (!author) {
            logger.warn({ context, author_id: input.author_id.toString() }, 'author missing — skipping');
            return;
        }
        if (recipients.length === 0) {
            logger.info({ context }, 'No active recipients to notify');
            return;
        }

        const linkUrl = `/tasks/${input.task_id.toString()}`;
        const taskIdStr = input.task_id.toString();
        // The in-app `body` field caps at NOTIFICATION_BODY_MAX (2 000),
        // but the comment body cap is 5 000. Truncate defensively so a
        // long comment doesn't push the validator into rejecting the
        // notification row entirely.
        const inAppBody =
            input.body_preview.length > 1_900 ? `${input.body_preview.slice(0, 1_900).trimEnd()}…` : input.body_preview;

        // Mentions are DM-only: a channel broadcast would surface
        // private team chatter into a noisy #projects feed. Per-recipient
        // DM is the right channel — the mentioned user gets pinged
        // directly, which is what `@mention` on Slack already feels like.
        const slack = await loadSlackDispatch();

        // R11 — bounded fan-out.
        await runWithConcurrency(recipients, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
            dispatchToRecipient(
                r,
                {
                    type: NOTIFICATION_TYPES.TASK_COMMENT,
                    title: `${author.full_name} mentioned you in a comment`,
                    body: inAppBody,
                    link_url: linkUrl,
                    related_entity: {
                        kind: RELATED_ENTITY_KINDS.TASK,
                        id: input.task_id,
                    },
                },
                renderTaskCommentMentionEmail({
                    recipient_full_name: r.full_name,
                    author_full_name: author.full_name,
                    task_id: taskIdStr,
                    body_preview: input.body_preview,
                }),
                context,
                slack
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'Task-comment mention dispatch failed'
        );
    }
};

/**
 * notifyTimesheetReminder — Step 23 cron addition (Plan §8 row 5).
 *
 * Fired by `runTimesheetReminder` once per matching user per day. The
 * dispatcher does NOT do its own user-loading — the caller already has
 * a `RecipientUser` shape because the job has already filtered by
 * "logged < expected hours AND not on leave" against the headcount.
 * That keeps the per-user blast radius tight: a single bad recipient
 * doesn't take down the whole batch.
 */
export const notifyTimesheetReminder = async (input: {
    recipient: RecipientUser;
    local_date: string;
    expected_hours: number;
}): Promise<void> => {
    const context = 'timesheet-reminder';
    try {
        const linkUrl = `/timesheets/me/day/${input.local_date}`;
        // Personal nudge — DM only, no channel broadcast (a daily
        // "these N people forgot to log time" feed in #timesheet would
        // be embarrassing). The cron loops over each user; loading
        // settings per call is fine for a once-a-day batch.
        const slack = await loadSlackDispatch();
        await dispatchToRecipient(
            input.recipient,
            {
                type: NOTIFICATION_TYPES.TIMESHEET_REMINDER,
                title: `Log your time for ${input.local_date}`,
                body: `You haven't logged your full timesheet for ${input.local_date} yet.`,
                link_url: linkUrl,
                related_entity: null,
            },
            renderTimesheetReminderEmail({
                recipient_full_name: input.recipient.full_name,
                local_date: input.local_date,
                expected_hours: input.expected_hours,
            }),
            context,
            slack
        );
    } catch (err) {
        logger.warn(
            {
                err,
                code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED,
                dispatch_event: context,
                recipient_id: input.recipient._id.toString(),
            },
            'Timesheet-reminder dispatch failed'
        );
    }
};

export interface ClientTaskReportedDispatchInput {
    task_id: Types.ObjectId;
    task_title: string;
    project_id: Types.ObjectId;
    project_name: string;
    /** The client / representative who filed it. */
    actor_id: Types.ObjectId;
}

/**
 * A client filed an issue — tell the people who can act on it.
 *
 * Audience is the union of:
 *   - the project's internal roster (`member_ids`), which is where the team
 *     leads and employees actually working on it live, and
 *   - every active admin / manager (`findReviewerPool`), who own triage.
 *
 * The union matters. Roster-only would miss a manager who oversees the project
 * without being on it; pool-only would miss the employees doing the work. A
 * client report has NO assignee by design, so if this fan-out is wrong the
 * report simply sits in the backlog unseen — there is no second signal.
 */
export const notifyClientTaskReported = async (input: ClientTaskReportedDispatchInput): Promise<void> => {
    const context = 'notify.client_task_reported';
    try {
        const actor = await findUserById(input.actor_id);
        const project = await Project.findById(input.project_id)
            .select('member_ids')
            .lean<{ member_ids?: Types.ObjectId[] } | null>();

        const pool = await findReviewerPool(input.actor_id);

        // De-dupe across the two sources by id string; a manager who is also on
        // the roster must not get two copies.
        const seen = new Set(pool.map((r) => String(r._id)));
        const rosterIds = (project?.member_ids ?? []).filter((id: Types.ObjectId) => !seen.has(String(id)));

        const rosterUsers = rosterIds.length
            ? await User.find({ _id: { $in: rosterIds }, status: USER_STATUSES.ACTIVE })
                  .select(
                      '_id email full_name role slack_user_id slack_notifications_enabled push_notifications_enabled'
                  )
                  .lean<RecipientUser[]>()
            : [];

        const recipients = [...pool, ...rosterUsers];
        if (recipients.length === 0) {
            logger.info({ context }, 'No active recipients to notify');
            return;
        }

        const actorName = actor?.full_name ?? 'A client';
        const slack = await loadSlackDispatch();

        await runWithConcurrency(recipients, NOTIFICATION_FAN_OUT_CONCURRENCY, (r) =>
            dispatchToRecipient(
                r,
                {
                    type: NOTIFICATION_TYPES.TASK_REPORTED_BY_CLIENT,
                    title: `${actorName} reported an issue on ${input.project_name}`,
                    body: input.task_title,
                    link_url: `/tasks/${input.task_id.toString()}`,
                    related_entity: { kind: RELATED_ENTITY_KINDS.TASK, id: input.task_id },
                },
                null,
                context,
                slack
            )
        );
    } catch (err) {
        logger.warn(
            { err, code: ERROR_CODES.NOTIFICATION_DISPATCH_FAILED, dispatch_event: context },
            'dispatch failed'
        );
    }
};
