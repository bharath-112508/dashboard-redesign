import { Router } from 'express';

import * as settings from '../controllers/settings.controller.js';
import * as slackSettings from '../controllers/slack-settings.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { patchSettingsBodySchema } from '../validators/settings.validator.js';
import { patchSlackSettingsBodySchema, testMessageBodySchema } from '../validators/slack-settings.validator.js';

const router = Router();

// ─── Public ────────────────────────────────────────────────────────────────
// Branding-only endpoint for the login page (API_Contract §4.1).
// MUST be declared before the `authenticate` block below — Express matches in
// registration order and we need this to skip the auth middleware.
router.get('/public', asyncHandler(settings.getPublicSettings));

// ─── Authenticated reads ───────────────────────────────────────────────────
router.get('/', authenticate, asyncHandler(settings.getSettings));

// ─── Admin writes ──────────────────────────────────────────────────────────
router.patch(
    '/',
    authenticate,
    requirePermission(PERMISSIONS.SETTINGS_WRITE),
    validate({ body: patchSettingsBodySchema }),
    asyncHandler(settings.patchSettings)
);

// ─── Slack admin surface (Step 25) ────────────────────────────────────────
//
// Dedicated routes for the FE's Slack settings screen — they accept a
// flat Slack payload instead of `{slack: {...}}` and the `test-message`
// endpoint surfaces synchronous delivery success/failure (the dispatcher
// elsewhere swallows failures per `SLACK_DISPATCH_FAILED` policy).

router.get(
    '/slack',
    authenticate,
    requirePermission(PERMISSIONS.SETTINGS_SLACK_WRITE),
    asyncHandler(slackSettings.getSlack)
);

router.patch(
    '/slack',
    authenticate,
    requirePermission(PERMISSIONS.SETTINGS_SLACK_WRITE),
    validate({ body: patchSlackSettingsBodySchema }),
    asyncHandler(slackSettings.patchSlack)
);

router.post(
    '/slack/test-message',
    authenticate,
    requirePermission(PERMISSIONS.SETTINGS_SLACK_WRITE),
    validate({ body: testMessageBodySchema }),
    asyncHandler(slackSettings.postTestMessage)
);

export default router;
