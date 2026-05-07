import { Router } from 'express';

import * as ctrl from '../controllers/command-palette.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { commandPaletteRateLimiter } from '../middlewares/rate-limit.middleware.js';
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
 *
 * Rate limit (H3): per-user 60/min via `commandPaletteRateLimiter`.
 * The endpoint reuses the search service's regex `$or` queries when
 * `q.length >= 2`, so it shares the same per-call cost as `/search`.
 * Pre-H3 the palette had no limiter and could be used to bypass the
 * search budget by routing identical queries through here. The new
 * limiter is a SEPARATE bucket from `searchRateLimiter` so users
 * hitting both surfaces get the full 60/min on each — the FE's
 * Cmd-K palette and the (future) search page don't compete.
 */

const router = Router();

router.use(authenticate);
router.use(commandPaletteRateLimiter);

router.get('/', validate({ query: commandPaletteQuerySchema }), asyncHandler(ctrl.getCommandPalette));

export default router;
