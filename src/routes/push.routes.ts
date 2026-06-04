import { Router } from 'express';

import * as ctrl from '../controllers/push.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
    subscribePushBodySchema,
    unsubscribePushBodySchema,
} from '../validators/push-subscription.validator.js';

/**
 * Web Push routes (V2-BE-10).
 *
 * Two endpoints, both owner-scoped at the service layer — no admin
 * variant. The VAPID public key isn't exposed via a route; it's
 * baked into the FE build via `VITE_VAPID_PUBLIC_KEY` at build time,
 * which keeps one fewer round-trip on first subscribe.
 */

const router = Router();
router.use(authenticate);

router.post(
    '/subscribe',
    validate({ body: subscribePushBodySchema }),
    asyncHandler(ctrl.postSubscribe)
);

router.delete(
    '/subscribe',
    validate({ body: unsubscribePushBodySchema }),
    asyncHandler(ctrl.deleteSubscribe)
);

export default router;
