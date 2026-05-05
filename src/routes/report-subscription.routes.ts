import { Router } from 'express';

import * as ctrl from '../controllers/report-subscription.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { REPORT_SUBSCRIPTION_ROLES } from '../constants/report-subscription.js';
import {
    createReportSubscriptionBodySchema,
    listReportSubscriptionsQuerySchema,
    patchReportSubscriptionBodySchema,
    reportSubscriptionIdParamSchema,
} from '../validators/report-subscription.validator.js';

/**
 * Report-subscription routes (Phase 4 Step 43).
 *
 * Owner-scoped CRUD + admin/manager role gate. The 404-not-403
 * mapping on cross-user access happens inside the service.
 */
const router = Router();

router.use(authenticate);
router.use(authorize(...REPORT_SUBSCRIPTION_ROLES));

router.get('/', validate({ query: listReportSubscriptionsQuerySchema }), asyncHandler(ctrl.getList));
router.post('/', validate({ body: createReportSubscriptionBodySchema }), asyncHandler(ctrl.postCreate));
router.get('/:id', validate({ params: reportSubscriptionIdParamSchema }), asyncHandler(ctrl.getOne));
router.patch(
    '/:id',
    validate({ params: reportSubscriptionIdParamSchema, body: patchReportSubscriptionBodySchema }),
    asyncHandler(ctrl.patchOne)
);
router.delete('/:id', validate({ params: reportSubscriptionIdParamSchema }), asyncHandler(ctrl.deleteOne));

export default router;
