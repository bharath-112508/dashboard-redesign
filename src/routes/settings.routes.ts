import { Router } from 'express';

import * as settings from '../controllers/settings.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { ROLES } from '../constants/roles.js';
import { patchSettingsBodySchema } from '../validators/settings.validator.js';

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
    authorize(ROLES.ADMIN),
    validate({ body: patchSettingsBodySchema }),
    asyncHandler(settings.patchSettings)
);

export default router;
