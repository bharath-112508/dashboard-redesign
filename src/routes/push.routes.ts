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

// M21 — `POST /push/unsubscribe` is the canonical revoke verb.
// `DELETE /push/subscribe` is kept as an alias for in-flight clients
// still on the old shape; both handlers go through the same service
// call so a one-deploy cutover is safe. The DELETE-with-body pattern
// is fragile across fetch implementations (Service Worker `fetch`,
// some CDN edges, certain interceptors silently strip DELETE bodies),
// which is what motivated the swap.
router.post(
    '/unsubscribe',
    validate({ body: unsubscribePushBodySchema }),
    asyncHandler(ctrl.deleteSubscribe)
);

router.delete(
    '/subscribe',
    validate({ body: unsubscribePushBodySchema }),
    asyncHandler(ctrl.deleteSubscribe)
);

export default router;
