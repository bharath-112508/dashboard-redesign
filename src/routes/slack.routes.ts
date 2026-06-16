import { Router } from 'express';

import {
    handleInteractive,
    handleSlashCommand,
    handleSlackEvents,
} from '../controllers/slack-interactive.controller.js';
import { slackWebhookRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { slackWebhookMiddleware } from '../middlewares/slack-webhook.middleware.js';

/**
 * Slack inbound webhook routes (Phase 0).
 *
 * Stack order matters:
 *   1. slackWebhookRateLimiter — per-IP 30 req/min. Sits in front of the
 *      cryptographic check to discourage forged-payload spam cheaply.
 *   2. slackWebhookMiddleware — captures the raw body (Slack signs the
 *      bytes BEFORE parsing), verifies HMAC-SHA256, then re-parses
 *      `req.body` as JSON or x-www-form-urlencoded for the handler.
 *   3. Handlers — `handleInteractive` for Block Kit buttons,
 *      `handleSlashCommand` for `/checkin`, `/checkout`, `/status`.
 *
 * Mounted at `/api/v1/slack/*` by `src/routes/index.ts`.
 */

const router = Router();

router.use(slackWebhookRateLimiter);
router.use(slackWebhookMiddleware);

router.post('/interactive', handleInteractive);
router.post('/commands/:command', handleSlashCommand);
router.post('/events', handleSlackEvents);

export default router;
