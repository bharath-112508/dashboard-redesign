import { Router } from 'express';

import * as ctrl from '../controllers/comp-off.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { COMP_OFF_ADJUST_ROLES, COMP_OFF_LIST_ROLES } from '../constants/leave.js';
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
    authorize(...COMP_OFF_LIST_ROLES),
    validate({ query: listCompOffQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/adjust',
    authorize(...COMP_OFF_ADJUST_ROLES),
    validate({ body: adjustCompOffBodySchema }),
    asyncHandler(ctrl.postAdjust)
);

export default router;
