import { Router } from 'express';

import * as ctrl from '../controllers/command-palette.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { commandPaletteQuerySchema } from '../validators/command-palette.validator.js';

/**
 * Command-palette route (Phase 4 Step 49).
 *
 * Single unified endpoint `GET /command-palette[?q=...]` that
 * returns `{actions, items}`. Action filtering is in-memory
 * (constant catalog scoped per caller permissions); item lookup
 * delegates to `search.service` so visibility scoping stays in one
 * place. The route itself only requires authentication — the
 * per-action `permission` filter happens inside the service so a
 * user with zero permissions still gets the navigation entries.
 */

const router = Router();

router.use(authenticate);

router.get('/', validate({ query: commandPaletteQuerySchema }), asyncHandler(ctrl.getCommandPalette));

export default router;
