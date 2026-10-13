import { Router } from 'express';

import * as ctrl from '../controllers/comp-off.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    adjustCompOffBodySchema,
    listCompOffQuerySchema,
    myCompOffQuerySchema,
} from '../validators/comp-off.validator.js';

const router = Router();
router.use(authenticate);

router.get('/me', validate({ query: myCompOffQuerySchema }), asyncHandler(ctrl.getMine));

router.get(
    '/',
    requirePermission(PERMISSIONS.COMP_OFF_READ),
    validate({ query: listCompOffQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/adjust',
    requirePermission(PERMISSIONS.COMP_OFF_WRITE),
    validate({ body: adjustCompOffBodySchema }),
    asyncHandler(ctrl.postAdjust)
);

export default router;
