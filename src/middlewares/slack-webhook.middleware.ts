import type { RequestHandler } from 'express';
import express from 'express';

import { SLACK_SIGNING_SECRET } from '../config/server.config.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import logger from '../utils/logger.js';
import { verifySlackSignature } from '../utils/slack-signature.js';

/**
 * Phase 0 — Slack webhook middleware.
 *
 * Slack signs the EXACT raw body (before any parsing), so we capture
 * the buffer first, verify the signature, then re-parse `req.body`
 * for downstream handlers. Mount AHEAD of all other body parsers on
 * `/api/v1/slack/*`:
 *
 *     app.use('/api/v1/slack', slackWebhookRateLimiter);
 *     app.use('/api/v1/slack', slackWebhookMiddleware);
 *     app.use('/api/v1/slack', slackRoutes);
 *
 * After this middleware, downstream handlers see:
 *   - `req.rawBody`   — original Buffer (kept for debugging / audit)
 *   - `req.body`      — parsed object (JSON or x-www-form-urlencoded)
 *
 * On reject:
 *   - 401  — bad signature
 *   - 503  — SLACK_SIGNING_SECRET unset (interactive routes mounted but
 *            env wasn't configured — operator error, not Slack's fault)
 *   - 400  — malformed JSON body
 *
 * Never logs the body or headers — both contain Slack secrets when
 * misconfigured. The `code: SLACK_INTERACTIVE_REJECTED` tag lets
 * operators grep for rejected webhooks without seeing payloads.
 */

declare module 'express-serve-static-core' {
    interface Request {
        /** Slack signs the raw body — we keep a buffer of it so handlers
         *  that need to re-hash (e.g. for additional verification) can. */
        rawBody?: Buffer;
    }
}

const rawBodyParser = express.raw({ type: '*/*' });

export const slackWebhookMiddleware: RequestHandler = (req, res, next) => {
    rawBodyParser(req, res, (parseErr) => {
        if (parseErr) {
            logger.warn(
                { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'raw_parse_failed' },
                'Slack webhook raw-body parse failed'
            );
            res.status(400).json({ message: 'Bad request' });
            return;
        }

        // After `express.raw`, `req.body` is the Buffer.
        const buf = req.body as Buffer;
        const bodyStr = buf?.length ? buf.toString('utf8') : '';
        const signature = req.header('x-slack-signature') ?? '';
        const timestamp = req.header('x-slack-request-timestamp') ?? '';

        if (!SLACK_SIGNING_SECRET) {
            logger.warn(
                { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'no_secret' },
                'SLACK_SIGNING_SECRET not configured but /slack route hit'
            );
            res.status(503).json({ message: 'Slack interactive not configured' });
            return;
        }

        const ok = verifySlackSignature({
            secret: SLACK_SIGNING_SECRET,
            signature,
            timestamp,
            body: bodyStr,
        });
        if (!ok) {
            logger.warn(
                { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'bad_signature' },
                'Slack webhook signature verification failed'
            );
            res.status(401).json({ message: 'Unauthorized' });
            return;
        }

        // Stash raw + re-parse the body the way downstream handlers expect.
        req.rawBody = buf;
        const ct = (req.header('content-type') ?? '').toLowerCase();
        if (ct.includes('application/json')) {
            try {
                req.body = bodyStr ? JSON.parse(bodyStr) : {};
            } catch {
                logger.warn(
                    { code: ERROR_CODES.SLACK_INTERACTIVE_REJECTED, reason: 'json_parse_failed' },
                    'Slack JSON body parse failed'
                );
                res.status(400).json({ message: 'Bad request' });
                return;
            }
        } else if (ct.includes('application/x-www-form-urlencoded')) {
            // Slack sends slash-command + interactive payloads as
            // urlencoded — decode into a flat object. URLSearchParams
            // does the URL-decoding step for us.
            const parsed = new URLSearchParams(bodyStr);
            req.body = Object.fromEntries(parsed.entries());
        } else {
            // Unknown content type — pass the raw string through.
            req.body = bodyStr;
        }
        next();
    });
};
