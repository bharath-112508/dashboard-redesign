import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { StatusCodes } from 'http-status-codes';

import appRoutes from '../../routes/index.js';
import slackRoutes from '../../routes/slack.routes.js';
import { globalErrorHandler } from '../../middlewares/error-handler.middleware.js';
import { generalRateLimiter } from '../../middlewares/rate-limit.middleware.js';
import { API_PREFIX, ERROR_CODES } from '../../constants/index.js';
import { ok } from '../../utils/api-response.js';
import { recordHttp } from '../../utils/metrics.js';

/**
 * In-process integration harness (BACKEND_AUDIT.md P3-18).
 *
 * Builds an Express instance shaped like the production boot path in
 * `src/index.ts`, MINUS the bits that aren't testable in-process:
 *   - No `connectDB` — tests mock the model layer.
 *   - No `startScheduler` — cron should not fire in tests.
 *   - No `app.listen` — supertest binds to a random port internally.
 *   - No pino-http — keeps test output clean.
 *
 * Usage:
 *   ```ts
 *   import { buildTestApp } from './_helpers/build-app.js';
 *   import request from 'supertest';
 *
 *   const app = buildTestApp();
 *   const res = await request(app).get('/health');
 *   expect(res.status).toBe(200);
 *   ```
 *
 * Authenticated endpoints: `vi.mock` the relevant model
 * (`models/user.model.js`, etc.) at the top of the test file with
 * `vi.hoisted`, the same pattern unit tests already use. The harness
 * itself is auth-naive — it just wires routes + middleware.
 */

export const buildTestApp = (): Express => {
    const app = express();

    // Helmet — same shape as production but compression disabled (test
    // payloads are tiny; skipping compression keeps the response body
    // string-readable for snapshot assertions).
    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'none'"],
                    baseUri: ["'none'"],
                    frameAncestors: ["'none'"],
                    formAction: ["'none'"],
                    upgradeInsecureRequests: [],
                },
            },
            crossOriginEmbedderPolicy: false,
            crossOriginOpenerPolicy: { policy: 'same-origin' },
            crossOriginResourcePolicy: { policy: 'cross-origin' },
        })
    );

    app.use(cors());
    app.use(compression());

    // Slack webhook routes — MUST be mounted BEFORE the global body
    // parsers. Slack signs the raw request bytes; once express.json /
    // express.urlencoded consume the stream, the bytes are gone and
    // signature verification fails. The slack router has its own raw-
    // body parser inside (`slackWebhookMiddleware`) that captures the
    // buffer, verifies HMAC, then re-parses req.body for the handler.
    // The central `appRoutes` router no longer mounts /slack to avoid
    // a double-mount fighting these parsers from below.
    app.use(`${API_PREFIX}/slack`, slackRoutes);

    // Tighter parser on /auth then global default (mirrors prod ordering).
    app.use(`${API_PREFIX}/auth`, express.json({ limit: '4kb' }));
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));

    app.use((req, res, next) => {
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
            recordHttp(req, res, durationSec);
        });
        next();
    });

    app.use(API_PREFIX, generalRateLimiter);

    app.get('/health', (_req, res) => {
        return ok(res, { status: 'ok', env: 'test' });
    });

    app.use(API_PREFIX, appRoutes);

    app.use('/{*path}', (_req, res) => {
        return res
            .status(StatusCodes.NOT_FOUND)
            .json({ error: { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Route not found' } });
    });

    app.use(globalErrorHandler);

    return app;
};
