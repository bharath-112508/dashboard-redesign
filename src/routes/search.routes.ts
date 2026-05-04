import { Router } from 'express';

import * as ctrl from '../controllers/search.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { SEARCH_READ_ROLES } from '../constants/search.js';
import { searchQuerySchema } from '../validators/search.validator.js';

/**
 * Global-search routes (Step 32; API_Contract §13).
 *
 * One endpoint, all authenticated roles. Per-bucket visibility scoping
 * happens inside `search.service` — the route gate is just "are you
 * logged in?". Authorize is included for symmetry with other routers
 * (and so a future role addition that should NOT have search access
 * forces a deliberate edit here).
 */
const router = Router();

router.use(authenticate);
router.use(authorize(...SEARCH_READ_ROLES));

router.get('/', validate({ query: searchQuerySchema }), asyncHandler(ctrl.getSearch));

export default router;
