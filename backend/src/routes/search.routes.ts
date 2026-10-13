import { Router } from 'express';

import * as ctrl from '../controllers/search.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { searchRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { searchQuerySchema } from '../validators/search.validator.js';

/**
 * Global-search routes (Step 32; API_Contract §13).
 *
 * One endpoint, all authenticated roles. Per-bucket visibility scoping
 * happens inside `search.service` — the route gate is just "are you
 * logged in?". Step 47 dropped the explicit role gate (legacy
 * `authorize(...SEARCH_READ_ROLES)` listed all four legacy roles, so
 * the authentication check alone has the same effect; future roles
 * that should NOT have search access need an explicit deny in the
 * service layer's per-bucket scoping).
 */
const router = Router();

router.use(authenticate);
// Per-user limiter (BACKEND_AUDIT.md P2-9): 60 searches / minute / user.
// Search hits a regex `$or` across multiple collections — fine
// individually, pathological in a tight loop.
router.use(searchRateLimiter);

router.get('/', validate({ query: searchQuerySchema }), asyncHandler(ctrl.getSearch));

export default router;
