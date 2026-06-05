import type { RequestHandler } from 'express';
import { Types } from 'mongoose';

import { ERROR_CODES } from '../constants/error-codes.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { approveLeave, rejectLeave } from '../services/leave-request.service.js';
import { getOrInitSettings } from './../services/settings.service.js';
import {
    fetchSlackUserInfo,
    resolveSlackUser,
} from '../services/slack-user-mapping.service.js';
import { slackContextFrom } from '../utils/slack.js';
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
}

const ephemeral = (text: string) => ({ response_type: 'ephemeral' as const, text });

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

    let payload: BlockActionPayload;
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

    if (payload.type !== 'block_actions' || !payload.actions?.[0]) {
        res.status(200).json(ephemeral('Unsupported interaction.'));
        return;
    }

    const action = payload.actions[0];
    const isApprove = action.action_id.startsWith('approve_leave_');
    const isReject = action.action_id.startsWith('reject_leave_');

    if (isApprove || isReject) {
        const user = await resolveCaller(payload.user.id);
        if (!user) {
            res.status(200).json(
                ephemeral(
                    "Couldn't identify your Viljetech account. Set your Slack email on your profile or contact an admin."
                )
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
            res.status(200).json(
                ephemeral("You don't have permission to review leave requests.")
            );
            return;
        }

        const prefix = isApprove ? 'approve_leave_' : 'reject_leave_';
        const leaveIdStr = action.action_id.slice(prefix.length);
        if (!Types.ObjectId.isValid(leaveIdStr)) {
            res.status(200).json(ephemeral('Bad leave reference.'));
            return;
        }
        const leaveId = new Types.ObjectId(leaveIdStr);
        const caller = { id: user._id, role: user.role as RoleType };

        try {
            if (isApprove) {
                // Slack interactive has no text input — pass empty body.
                // If the leave requires `additional_approval_reason`
                // (would drive balance negative), the service throws
                // and we surface a clear ephemeral so the admin knows
                // to handle it in the web app.
                await approveLeave(leaveId, {} as Parameters<typeof approveLeave>[1], caller);
            } else {
                await rejectLeave(leaveId, {} as Parameters<typeof rejectLeave>[1], caller);
            }
            // Empty 200 — the channel `chat.update` (fired by the
            // dispatcher's notifyLeaveDecided) is the visible
            // confirmation.
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
                res.status(200).json(ephemeral('This leave was already decided.'));
                return;
            }
            if (code === ERROR_CODES.ADDITIONAL_APPROVAL_REASON_REQUIRED) {
                res.status(200).json(
                    ephemeral(
                        'This request needs an explicit override reason (balance would go negative). Approve from the web app to add one.'
                    )
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
            res.status(200).json(ephemeral('Sorry, something went wrong.'));
            return;
        }
    }

    res.status(200).json(ephemeral(`Unknown action: ${action.action_id}`));
};

export const handleSlashCommand: RequestHandler = async (req, res) => {
    const command = req.params.command;
    // Phase 2 (Tasks 17–19) wires the /checkin /checkout /status
    // handlers here.
    res.status(200).json(ephemeral(`/${command} is not implemented yet.`));
};
