import { Router } from 'express';

import * as ctrl from '../controllers/notification.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { listNotificationsQuerySchema, notificationIdParamSchema } from '../validators/notification.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────
//
// Notifications are inherently owner-scoped — every read/write filters by
// the caller's user_id at the service layer, so `authenticate` is the only
// gate needed (the legacy `authorize(...NOTIFICATION_READ_ROLES)` listed
// every authenticated role and was a no-op).

router.get('/', validate({ query: listNotificationsQuerySchema }), asyncHandler(ctrl.getList));

// `/unread-count` and `/read-all` MUST be declared before the `/:id` patterns
// so Express doesn't try to parse those literal strings as ObjectIds.
router.get('/unread-count', asyncHandler(ctrl.getUnreadCount));

router.post('/read-all', asyncHandler(ctrl.postMarkAllRead));

// ─── Item routes ──────────────────────────────────────────────────────────

router.post('/:id/read', validate({ params: notificationIdParamSchema }), asyncHandler(ctrl.postMarkRead));

router.delete('/:id', validate({ params: notificationIdParamSchema }), asyncHandler(ctrl.deleteOne));

export default router;
