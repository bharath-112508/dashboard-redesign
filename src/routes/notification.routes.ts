import { Router } from 'express';

import * as ctrl from '../controllers/notification.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { NOTIFICATION_READ_ROLES } from '../constants/notification.js';
import { listNotificationsQuerySchema, notificationIdParamSchema } from '../validators/notification.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────
//
// All endpoints are owner-scoped server-side; we still call `authorize` with
// the full role set so unauthenticated tokens (e.g. mfa_session tokens) get a
// clean 401/403 instead of slipping through.

router.get(
    '/',
    authorize(...NOTIFICATION_READ_ROLES),
    validate({ query: listNotificationsQuerySchema }),
    asyncHandler(ctrl.getList)
);

// `/unread-count` and `/read-all` MUST be declared before the `/:id` patterns
// so Express doesn't try to parse those literal strings as ObjectIds.
router.get('/unread-count', authorize(...NOTIFICATION_READ_ROLES), asyncHandler(ctrl.getUnreadCount));

router.post('/read-all', authorize(...NOTIFICATION_READ_ROLES), asyncHandler(ctrl.postMarkAllRead));

// ─── Item routes ──────────────────────────────────────────────────────────

router.post(
    '/:id/read',
    authorize(...NOTIFICATION_READ_ROLES),
    validate({ params: notificationIdParamSchema }),
    asyncHandler(ctrl.postMarkRead)
);

router.delete(
    '/:id',
    authorize(...NOTIFICATION_READ_ROLES),
    validate({ params: notificationIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;
