import type { RequestHandler } from 'express';

import { ERROR_CODES } from '../constants/error-codes.js';
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

    // Phase 1 (Task 14) wires the approve_leave_* / reject_leave_*
    // handlers here. For the Phase 0 skeleton, everything is "unknown".
    res.status(200).json(ephemeral(`Unknown action: ${action.action_id}`));
};

export const handleSlashCommand: RequestHandler = async (req, res) => {
    const command = req.params.command;
    // Phase 2 (Tasks 17–19) wires the /checkin /checkout /status
    // handlers here.
    res.status(200).json(ephemeral(`/${command} is not implemented yet.`));
};
