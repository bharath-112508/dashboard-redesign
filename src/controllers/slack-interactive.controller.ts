import type { RequestHandler } from 'express';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import {
    SLACK_ACTION_ATTENDANCE_CHECK_IN,
    SLACK_ACTION_ATTENDANCE_CHECK_OUT,
    SLACK_ACTION_BREAK_START_LUNCH,
    SLACK_ACTION_BREAK_START_TEA,
    SLACK_ACTION_BREAK_START_OTHER,
    SLACK_ACTION_BREAK_END,
    SLACK_ACTION_APPLY_LEAVE_OPEN,
    SLACK_CALLBACK_APPLY_LEAVE,
} from '../constants/slack.js';
import { approveLeave, rejectLeave, applyLeave } from '../services/leave-request.service.js';
import { checkIn, checkOut, getMyToday, startBreak, endBreak } from '../services/attendance.service.js';
import { getOrInitSettings } from './../services/settings.service.js';
import { fetchSlackUserInfo, resolveSlackUser } from '../services/slack-user-mapping.service.js';
import { slackContextFrom, publishHomeView, openSlackModal, postSlackMessage } from '../utils/slack.js';
import { buildHomeDashboardData } from '../services/slack-home.service.js';
import { buildHomeDashboardView, SLACK_ACTION_HOME_REFRESH } from '../utils/slack-home-blocks.js';
import { loadApplyLeaveModalTypes } from '../services/slack-leave.service.js';
import { buildApplyLeaveModal, parseApplyLeaveSubmission, appErrorToModalErrors } from '../utils/slack-leave-blocks.js';
import { applyLeaveBodySchema } from '../validators/leave-request.validator.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import { buildAuditContext } from '../utils/audit-context.js';
import { publish } from '../services/realtime.service.js';
import { REALTIME_TOPICS } from '../constants/realtime.js';
import logger from '../utils/logger.js';

/**
 * Slack interactive controller (Phase 0 skeleton, extended by
 * Phase 1 + 2 tasks).
 *
 * Endpoints:
 *   - POST /api/v1/slack/interactive       — Block Kit button clicks
 *                                            (Approve/Reject leave etc.)
 *   - POST /api/v1/slack/commands/:command — slash commands
 *                                            (/checkin, /checkout, /status)
 *
 * Slack signs both surfaces — verification + raw-body capture happen
 * upstream in `slack-webhook.middleware.ts`. By the time these handlers
 * run, `req.body` is already a parsed object.
 *
 * Response contract: ALWAYS respond 200 within Slack's 3-second
 * window. Errors and permission denials respond with ephemeral text
 * (`response_type: 'ephemeral'`) — visible to the clicker, never to
 * the channel. The visible CHANNEL confirmation for Approve/Reject
 * happens asynchronously: the BE-side state change fires
 * `notifyLeaveDecided`, which `chat.update`s the original message
 * in place (no new post per state transition).
 */

interface BlockActionPayload {
    type: 'block_actions';
    user: { id: string };
    actions: Array<{ action_id: string; value?: string }>;
    response_url?: string;
    view?: { type?: string };
    trigger_id?: string;
}

interface ViewSubmissionPayload {
    type: 'view_submission';
    user: { id: string };
    view: { callback_id?: string; state?: { values?: unknown } };
}

const ephemeral = (text: string) => ({ response_type: 'ephemeral' as const, text });

/**
 * Block Kit button clicks IGNORE the HTTP ack body — Slack only renders
 * feedback POSTed to the payload's `response_url` (unlike slash
 * commands, where the response body IS the message). Without this,
 * every error ephemeral below is invisible: the user clicks
 * Approve/Reject and nothing appears to happen.
 *
 * Fire-and-forget: failures log at warn and never delay the 3-second
 * ack window.
 */
const postEphemeralToResponseUrl = (responseUrl: string | undefined, text: string): void => {
    if (!responseUrl) return;
    void fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text }),
        signal: AbortSignal.timeout(2500),
    }).catch((err: unknown) => {
        logger.warn({ err }, 'Slack response_url ephemeral dispatch failed');
    });
};

// Reviewer roles can approve / reject — matches `isReviewer` in
// leave-request.service.ts. Phase 1 reuses that gate so Slack
// approvals follow the same auth model as the web app's
// /leaves/:id/approve endpoint.
const isReviewer = (role: RoleType): boolean =>
    role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

/**
 * Resolve the Slack-user → Viljetech-user via the shared mapping
 * service. Returns null when the clicker has no matching account —
 * caller responds ephemeral.
 *
 * Loads Slack settings as a side-effect (the resolver needs a bot
 * token to call `users.info` on email fallback). Returns null when
 * Slack is unconfigured too.
 */
const resolveCaller = async (slackUserId: string) => {
    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return null;
    return resolveSlackUser(slackUserId, {
        botToken: ctx.botToken!,
        fetchUserInfo: fetchSlackUserInfo,
    });
};

/** Every role except `client` holds `leave_request.write`. The Slack path
 *  bypasses Express `requirePermission`, so gate here the same way. */
const canApplyLeave = (role: RoleType): boolean => role !== ROLES.CLIENT;

/**
 * Open the Apply-for-leave modal. Shared by the App Home button and the
 * `/applyleave` slash command. Returns an ephemeral text on any pre-open
 * failure (no Slack context, no active types) so the caller can surface it;
 * returns null once the modal open has been dispatched.
 */
const openApplyLeaveModal = async (
    slackUserId: string,
    triggerId: string | undefined,
    user: { _id: Types.ObjectId }
): Promise<string | null> => {
    if (!triggerId) return 'Sorry, something went wrong.';
    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return 'Slack is not configured.';
    const types = await loadApplyLeaveModalTypes(user._id);
    if (types.length === 0) return 'No leave types are available to apply for.';
    const today = dayjs().tz(DEFAULT_TIMEZONE).format('YYYY-MM-DD');
    const view = buildApplyLeaveModal(types, today);
    const opened = await openSlackModal(ctx, triggerId, view);
    return opened ? null : 'Could not open the leave form — please try again.';
};

/**
 * Re-render a user's App Home tab from their current attendance state.
 * Fire-and-forget — non-throwing; logs via publishHomeView's own policy.
 * `displayName` falls back to "there" when the user doc has no name.
 */
const renderAttendanceHome = async (
    slackUserId: string,
    user: { _id: Types.ObjectId; full_name?: string | null; role?: RoleType }
): Promise<void> => {
    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (!ctx) return;
    const data = await buildHomeDashboardData({
        _id: user._id,
        role: (user.role ?? 'employee') as RoleType,
        full_name: user.full_name ?? null,
    });
    const view = buildHomeDashboardView(data, data.user);
    await publishHomeView(ctx, slackUserId, view, 'attendance-home');
};

export { renderAttendanceHome };

/**
 * Apply-for-leave modal submit. Maps `view.state.values` → the existing
 * `applyLeaveBodySchema` (reusing the web form's validation verbatim), calls
 * `applyLeave`, and either clears the modal (empty 200) or returns inline
 * field errors (`response_action: errors`). On success, fires a DM confirmation
 * + Home re-publish fire-and-forget (the balance reservation changed).
 *
 * MUST respond within Slack's 3s window — `applyLeave` is awaited (we need the
 * outcome to decide the response), the side-effects are not.
 */
const handleApplyLeaveSubmission: RequestHandler = async (req, res) => {
    const payload = JSON.parse((req.body as { payload: string }).payload) as ViewSubmissionPayload;
    const slackUserId = payload.user.id;

    const user = await resolveCaller(slackUserId);
    if (!user) {
        res.status(200).json({
            response_action: 'errors',
            errors: { reason: "Couldn't identify your Viljetech account — contact an admin." },
        });
        return;
    }
    if (!canApplyLeave(user.role as RoleType)) {
        res.status(200).json({ response_action: 'errors', errors: { reason: "Your role can't apply for leave." } });
        return;
    }

    // Reuse the HTTP validator so Slack input gets identical validation +
    // defaults. Field-level Zod issues map to the matching block_id.
    const parsed = applyLeaveBodySchema.safeParse(parseApplyLeaveSubmission(payload.view));
    if (!parsed.success) {
        const errors: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
            const field = String(issue.path[0] ?? '');
            // Zod field names map 1:1 to the modal block_ids except the type id.
            const block = field === 'leave_type_id' ? 'leave_type' : field;
            errors[block] = issue.message;
        }
        // Guarantee at least one error references a real block.
        if (Object.keys(errors).length === 0) errors.reason = 'Please check the form and try again.';
        res.status(200).json({ response_action: 'errors', errors });
        return;
    }

    const audit = buildAuditContext(req, {
        overrideActor: { actor_id: user._id, actor_role: user.role as RoleType },
    });

    try {
        await applyLeave(parsed.data, { id: user._id, role: user.role as RoleType, audit });
    } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        const message = (err as { message?: string })?.message ?? 'Could not submit your leave.';
        logger.warn({ err, code, reason: 'apply_leave_submit_failed' }, 'Slack apply-leave submission rejected');
        res.status(200).json({ response_action: 'errors', errors: appErrorToModalErrors(code, message) });
        return;
    }

    // Success — clear the modal, then fire side-effects. Slack actions bypass
    // the HTTP after-write middleware, so emit the realtime events explicitly.
    res.status(200).json({});
    publish([REALTIME_TOPICS.LEAVES, REALTIME_TOPICS.LEAVE_BALANCES]);

    const settings = await getOrInitSettings();
    const ctx = slackContextFrom(settings.slack);
    if (ctx) {
        void postSlackMessage(ctx, {
            channel: slackUserId,
            text: '✅ Your leave request was submitted and is pending approval.',
            context: 'apply-leave-confirm-dm',
        });
    }
    void renderAttendanceHome(slackUserId, user);
};

export const handleInteractive: RequestHandler = async (req, res) => {
    const rawPayload = (req.body as { payload?: unknown })?.payload;
    if (typeof rawPayload !== 'string') {
        logger.warn(
            { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'no_payload' },
            'Slack interactive missing payload field'
        );
        res.status(200).json(ephemeral('Sorry, something went wrong.'));
        return;
    }

    let payload: BlockActionPayload | ViewSubmissionPayload;
    try {
        payload = JSON.parse(rawPayload);
    } catch {
        logger.warn(
            { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'payload_parse_failed' },
            'Slack interactive payload JSON.parse failed'
        );
        res.status(200).json(ephemeral('Sorry, something went wrong.'));
        return;
    }

    if (payload.type === 'view_submission') {
        if (payload.view?.callback_id === SLACK_CALLBACK_APPLY_LEAVE) {
            await handleApplyLeaveSubmission(req, res, () => undefined);
            return;
        }
        res.status(200).json({});
        return;
    }

    if (payload.type !== 'block_actions' || !payload.actions?.[0]) {
        res.status(200).json(ephemeral('Unsupported interaction.'));
        return;
    }

    const action = payload.actions[0];
    const isApprove = action.action_id.startsWith('approve_leave_');
    const isReject = action.action_id.startsWith('reject_leave_');

    // Dual-channel feedback: the JSON body keeps the existing (test-
    // pinned) contract, while the response_url POST is what Slack
    // actually shows to the clicker for block_actions.
    const respond = (text: string) => {
        postEphemeralToResponseUrl(payload.response_url, text);
        res.status(200).json(ephemeral(text));
    };

    const BREAK_START_BY_ACTION: Record<string, 'lunch' | 'tea' | 'other'> = {
        [SLACK_ACTION_BREAK_START_LUNCH]: 'lunch',
        [SLACK_ACTION_BREAK_START_TEA]: 'tea',
        [SLACK_ACTION_BREAK_START_OTHER]: 'other',
    };
    const isBreakStart = action.action_id in BREAK_START_BY_ACTION;
    const isBreakEnd = action.action_id === SLACK_ACTION_BREAK_END;
    if (isBreakStart || isBreakEnd) {
        const fromHome = payload.view?.type === 'home';
        const user = await resolveCaller(payload.user.id);
        if (!user) {
            respond("Couldn't identify your Viljetech account.");
            return;
        }
        try {
            if (isBreakStart) {
                await startBreak(user._id, BREAK_START_BY_ACTION[action.action_id]!, 'slack');
            } else {
                await endBreak(user._id, 'slack');
            }
        } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            const msg =
                code === ERROR_CODES.NOT_CHECKED_IN
                    ? 'Check in before starting a break.'
                    : code === ERROR_CODES.ALREADY_ON_BREAK
                      ? "You're already on a break."
                      : code === ERROR_CODES.NOT_ON_BREAK
                        ? "You're not on a break."
                        : 'Sorry, something went wrong.';
            respond(msg);
            if (fromHome) void renderAttendanceHome(payload.user.id, user);
            return;
        }
        publish([REALTIME_TOPICS.ATTENDANCE]);
        if (fromHome) {
            res.status(200).json({});
            void renderAttendanceHome(payload.user.id, user);
        } else {
            respond(isBreakStart ? '✅ Break started.' : '✅ Break ended.');
        }
        return;
    }

    const isAttendanceIn = action.action_id === SLACK_ACTION_ATTENDANCE_CHECK_IN;
    const isAttendanceOut = action.action_id === SLACK_ACTION_ATTENDANCE_CHECK_OUT;
    if (isAttendanceIn || isAttendanceOut) {
        const fromHome = payload.view?.type === 'home';
        const user = await resolveCaller(payload.user.id);
        if (!user) {
            respond(
                "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin."
            );
            return;
        }
        try {
            if (isAttendanceIn) {
                await checkIn({ method: 'manual' }, user._id, '');
            } else {
                await checkOut({ method: 'manual' }, user._id, '');
            }
        } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            if (code === ERROR_CODES.ALREADY_CHECKED_IN) {
                respond("You're already checked in. Use Check Out to end your day.");
                if (fromHome) void renderAttendanceHome(payload.user.id, user);
                return;
            }
            if (code === ERROR_CODES.NOT_CHECKED_IN) {
                respond("You're not checked in right now. Use Check In first.");
                if (fromHome) void renderAttendanceHome(payload.user.id, user);
                return;
            }
            logger.warn(
                {
                    err,
                    code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED,
                    reason: 'attendance_action_threw',
                    action_id: action.action_id,
                },
                'Slack interactive: attendance action threw'
            );
            respond('Sorry, something went wrong.');
            return;
        }
        // Slack actions bypass the HTTP after-write middleware, so emit the
        // realtime change event explicitly on the success path. Synchronous +
        // non-throwing.
        publish([REALTIME_TOPICS.ATTENDANCE]);
        if (fromHome) {
            res.status(200).json({});
            void renderAttendanceHome(payload.user.id, user);
        } else {
            respond(isAttendanceIn ? '✅ Checked in.' : '✅ Checked out.');
        }
        return;
    }

    if (action.action_id === SLACK_ACTION_HOME_REFRESH) {
        const user = await resolveCaller(payload.user.id);
        res.status(200).json({});
        if (user) void renderAttendanceHome(payload.user.id, user);
        return;
    }

    if (action.action_id === SLACK_ACTION_APPLY_LEAVE_OPEN) {
        const user = await resolveCaller(payload.user.id);
        if (!user) {
            respond(
                "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin."
            );
            return;
        }
        if (!canApplyLeave(user.role as RoleType)) {
            respond("Your role can't apply for leave.");
            return;
        }
        const err = await openApplyLeaveModal(payload.user.id, payload.trigger_id, user);
        if (err) respond(err);
        else res.status(200).json({});
        return;
    }

    if (isApprove || isReject) {
        const user = await resolveCaller(payload.user.id);
        if (!user) {
            respond(
                "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin."
            );
            return;
        }
        if (!isReviewer(user.role as RoleType)) {
            logger.warn(
                {
                    code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED,
                    reason: 'permission_denied',
                    user_id: user._id,
                    role: user.role,
                    action_id: action.action_id,
                },
                'Slack interactive: caller lacks reviewer role'
            );
            respond("You don't have permission to review leave requests.");
            return;
        }

        const prefix = isApprove ? 'approve_leave_' : 'reject_leave_';
        const leaveIdStr = action.action_id.slice(prefix.length);
        if (!Types.ObjectId.isValid(leaveIdStr)) {
            respond('Bad leave reference.');
            return;
        }
        const leaveId = new Types.ObjectId(leaveIdStr);
        // Synthesise an audit context from the Slack request so the
        // approve/reject row gets attributed to the Slack actor instead
        // of being silently dropped (the service gates audit writes on
        // `caller.audit`). `actor_role` mirrors the resolved user's role
        // so audit consumers can filter the same way they do for HTTP.
        const audit = buildAuditContext(req, {
            overrideActor: { actor_id: user._id, actor_role: user.role as RoleType },
        });
        const caller = { id: user._id, role: user.role as RoleType, audit };

        try {
            if (isApprove) {
                // Slack interactive has no text input — pass empty body.
                // If the leave requires `additional_approval_reason`
                // (would drive balance negative), the service throws
                // and we surface a clear ephemeral so the admin knows
                // to handle it in the web app.
                await approveLeave(leaveId, {} as Parameters<typeof approveLeave>[1], caller);
            } else {
                // The reject body validator requires `approver_remarks`
                // (min 1) on the HTTP route. Slack has no text input,
                // so default to a recognisable string — the email +
                // channel update render this verbatim and the audit row
                // captures it as the rejection rationale.
                await rejectLeave(
                    leaveId,
                    { approver_remarks: 'Rejected via Slack' } as Parameters<typeof rejectLeave>[1],
                    caller
                );
            }
            // Slack actions bypass the HTTP after-write middleware, so emit
            // the realtime change events explicitly. A leave decision moves
            // both the request status and the balance (used/pending).
            publish([REALTIME_TOPICS.LEAVES, REALTIME_TOPICS.LEAVE_BALANCES]);
            // Empty 200 — the channel `chat.update` (fired by the
            // dispatcher's notifyLeaveDecided) is the visible
            // confirmation. When the tap originated on the Home tab,
            // also re-publish the dashboard so the actioned request
            // drops off the pending list.
            if (payload.view?.type === 'home') {
                void renderAttendanceHome(payload.user.id, user);
            }
            res.status(200).json({});
            return;
        } catch (err: unknown) {
            const code = (err as { code?: string })?.code;
            // `CORRECTION_REQUEST_NOT_PENDING` is the code the leave
            // service uses for "leave is no longer pending" (the name
            // is a historical artifact — applies to leave + correction
            // both). Slack retries on >3s response timeouts, so this
            // path also covers idempotent double-clicks.
            if (code === ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING) {
                respond('This leave was already decided.');
                return;
            }
            if (code === ERROR_CODES.ADDITIONAL_APPROVAL_REASON_REQUIRED) {
                respond(
                    'This request needs an explicit override reason (balance would go negative). Approve from the web app to add one.'
                );
                return;
            }
            // The reviewer-role gate already passed above, so FORBIDDEN
            // from the service means the self-review guard fired: the
            // clicker authored this leave. Pre-fix this fell into the
            // generic branch and (worse) never reached Slack at all, so
            // an admin rejecting their own request saw nothing happen.
            if (code === ERROR_CODES.FORBIDDEN) {
                respond(
                    "You can't approve or reject your own leave request — another admin or manager has to action it."
                );
                return;
            }
            logger.warn(
                {
                    err,
                    code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED,
                    reason: 'service_threw',
                    action_id: action.action_id,
                },
                'Slack interactive: leave service threw'
            );
            respond('Sorry, something went wrong.');
            return;
        }
    }

    respond(`Unknown action: ${action.action_id}`);
};

/**
 * Format a Date as `HH:MM` in IST (Asia/Kolkata) — every slash-command
 * confirmation surfaces this so the user gets a quick "checked in at
 * 09:42" without having to open the app.
 */
const formatTimeIST = (d: Date): string =>
    new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(d);

export const handleSlashCommand: RequestHandler = async (req, res) => {
    const command = req.params.command;
    const slackUserId = (req.body as { user_id?: string })?.user_id;
    if (!slackUserId) {
        res.status(200).json(ephemeral('Missing Slack user id.'));
        return;
    }
    const triggerId = (req.body as { trigger_id?: string })?.trigger_id;

    const user = await resolveCaller(slackUserId);
    if (!user) {
        res.status(200).json(
            ephemeral(
                "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin."
            )
        );
        return;
    }

    try {
        if (command === 'applyleave') {
            if (!canApplyLeave(user.role as RoleType)) {
                res.status(200).json(ephemeral("Your role can't apply for leave."));
                return;
            }
            const err = await openApplyLeaveModal(slackUserId, triggerId, user);
            res.status(200).json(err ? ephemeral(err) : {});
            return;
        }
        if (command === 'checkin') {
            // Slack has no QR / no geolocation — record as a manual
            // check-in. The attendance service still respects
            // org-level geofence policies (which may reject) but for
            // a manual punch from a trusted Slack workspace that's
            // the right semantic.
            const result = (await checkIn({ method: 'manual' }, user._id, '')) as {
                check_in?: { time?: Date | string } | null;
            };
            const rawTime = result?.check_in?.time;
            const inAt = rawTime instanceof Date ? rawTime : rawTime ? new Date(rawTime) : new Date();
            // Slack bypasses the HTTP after-write middleware — emit explicitly.
            publish([REALTIME_TOPICS.ATTENDANCE]);
            res.status(200).json(
                ephemeral(`✅ Checked in at ${formatTimeIST(inAt)}. Use \`/checkout\` when you're done.`)
            );
            return;
        }
        if (command === 'checkout') {
            // Same manual-method posture as `/checkin`.
            const result = (await checkOut({ method: 'manual' }, user._id, '')) as {
                segments?: Array<{ check_out?: { time?: Date | string } | null }>;
                total_worked_minutes?: number;
            };
            // The service closes the latest segment — `segments[-1]` carries
            // the check-out time. Fall back to "now" if the shape isn't what
            // we expect (defensive — the assertion has been right in tests
            // and integration).
            const segs = result?.segments ?? [];
            const lastSeg = segs[segs.length - 1];
            const rawOut = lastSeg?.check_out?.time;
            const outAt = rawOut instanceof Date ? rawOut : rawOut ? new Date(rawOut) : new Date();
            const worked = result?.total_worked_minutes ?? 0;
            const h = Math.floor(worked / 60);
            const m = worked % 60;
            // Slack bypasses the HTTP after-write middleware — emit explicitly.
            publish([REALTIME_TOPICS.ATTENDANCE]);
            res.status(200).json(ephemeral(`✅ Checked out at ${formatTimeIST(outAt)} (${h}h ${m}m worked).`));
            return;
        }
        // Slack reserves `/status` as a built-in command, so workspaces
        // register this as `/mystatus` (or similar) instead. The handler keys
        // off the URL path segment, so accept both `…/commands/status` and
        // `…/commands/mystatus` — same today's-segments response either way.
        if (command === 'status' || command === 'mystatus') {
            const record = (await getMyToday(user._id)) as {
                segments?: Array<{
                    check_in?: { time?: Date | string } | null;
                    check_out?: { time?: Date | string } | null;
                }>;
                total_worked_minutes?: number;
            } | null;
            const segs = record?.segments ?? [];
            if (segs.length === 0) {
                res.status(200).json(ephemeral('No segments today.'));
                return;
            }
            const lines = segs.map((s) => {
                const rawIn = s.check_in?.time;
                const rawOut = s.check_out?.time;
                const inT = rawIn instanceof Date ? rawIn : rawIn ? new Date(rawIn) : null;
                const outT = rawOut instanceof Date ? rawOut : rawOut ? new Date(rawOut) : null;
                const inStr = inT ? formatTimeIST(inT) : '—';
                const outStr = outT ? formatTimeIST(outT) : 'now';
                return `• ${inStr} → ${outStr}`;
            });
            const worked = record?.total_worked_minutes ?? 0;
            const h = Math.floor(worked / 60);
            const m = worked % 60;
            res.status(200).json(ephemeral(`${lines.join('\n')}\n\n*Total:* ${h}h ${m}m`));
            return;
        }
        res.status(200).json(ephemeral(`/${command} is not implemented yet.`));
    } catch (err: unknown) {
        const code = (err as { code?: string })?.code;
        if (code === ERROR_CODES.ALREADY_CHECKED_IN) {
            res.status(200).json(
                ephemeral(
                    "You're already checked in. Use `/checkout` to end your day or `/status` to see today's segments."
                )
            );
            return;
        }
        if (code === ERROR_CODES.NOT_CHECKED_IN) {
            res.status(200).json(ephemeral("You're not currently checked in. Use `/checkin` first."));
            return;
        }
        // Slack carries no client IP, no geolocation, no wifi info — if
        // the org has geofence or wifi_restriction enabled the service
        // throws LOCATION_NOT_ALLOWED (covers both). Surface a clear
        // message instead of the generic "something went wrong."
        if (code === ERROR_CODES.LOCATION_NOT_ALLOWED) {
            res.status(200).json(
                ephemeral(
                    "Slack check-in isn't available from your location — please use the web app or the office QR code."
                )
            );
            return;
        }
        logger.warn(
            {
                err,
                command,
                code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED,
                reason: 'slash_command_threw',
            },
            'Slack slash command failed'
        );
        res.status(200).json(ephemeral('Sorry, something went wrong.'));
    }
};

interface SlackEventEnvelope {
    type?: string;
    challenge?: string;
    event?: { type?: string; user?: string; tab?: string };
}

/**
 * POST /api/v1/slack/events — Slack Events API.
 *
 * Two cases:
 *   - `url_verification` — echo the `challenge` so Slack can verify the
 *     request URL when the admin first registers it.
 *   - `event_callback` → `app_home_opened` — ack 200 immediately, then
 *     render the user's Home tab asynchronously (Slack publishes the view
 *     via views.publish, not in the HTTP response). Any other event is a
 *     200 no-op so future subscriptions don't error.
 *
 * Signature verification + raw-body capture happen upstream in
 * slack-webhook.middleware.ts (content-type application/json).
 */
export const handleSlackEvents: RequestHandler = async (req, res) => {
    const body = (req.body ?? {}) as SlackEventEnvelope;

    if (body.type === 'url_verification') {
        res.status(200).json({ challenge: body.challenge });
        return;
    }

    // Slack fires `app_home_opened` for ANY app tab (Home / Messages / About);
    // only the Home tab needs a `views.publish`. Skip the others to avoid a
    // wasted Slack call + DB read. Older payloads may omit `tab` — treat a
    // missing tab as Home so we don't regress those.
    if (
        body.type === 'event_callback' &&
        body.event?.type === 'app_home_opened' &&
        body.event.user &&
        (body.event.tab === undefined || body.event.tab === 'home')
    ) {
        res.status(200).json({});
        const slackUserId = body.event.user;
        try {
            const user = await resolveCaller(slackUserId);
            if (user) await renderAttendanceHome(slackUserId, user);
        } catch (err) {
            logger.warn(
                { err, code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'app_home_render_failed' },
                'Slack app_home_opened render failed'
            );
        }
        return;
    }

    res.status(200).json({});
};
