import { Router } from 'express';

import * as ctrl from '../controllers/company.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    companyIdParamSchema,
    createCompanyBodySchema,
    createRepresentativeBodySchema,
    listCompaniesQuerySchema,
    patchCompanyBodySchema,
} from '../validators/company.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection ──────────────────────────────────────────────────────────

// Read is `company.read` (admin + manager). A `client` also reaches these
// via COMPANY_READ? No — they don't hold it. They reach their OWN company
// through the item routes below, which are scope-checked in the service.
router.get(
    '/',
    requirePermission(PERMISSIONS.COMPANY_READ),
    validate({ query: listCompaniesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.COMPANY_WRITE),
    validate({ body: createCompanyBodySchema }),
    asyncHandler(ctrl.postCreate)
);

// ─── Item ────────────────────────────────────────────────────────────────

router.get(
    '/:id',
    requirePermission(PERMISSIONS.COMPANY_READ),
    validate({ params: companyIdParamSchema }),
    asyncHandler(ctrl.getById)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.COMPANY_WRITE),
    validate({ params: companyIdParamSchema, body: patchCompanyBodySchema }),
    asyncHandler(ctrl.patchById)
);

// Archive, not delete — projects reference `company_id` and historic
// references must stay resolvable.
router.post(
    '/:id/archive',
    requirePermission(PERMISSIONS.COMPANY_WRITE),
    validate({ params: companyIdParamSchema }),
    asyncHandler(ctrl.postArchive)
);

// ─── Representatives ─────────────────────────────────────────────────────

router.get(
    '/:id/representatives',
    requirePermission(PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyIdParamSchema }),
    asyncHandler(ctrl.getRepresentatives)
);

/**
 * Create a representative.
 *
 * Gated on `representative.write` — deliberately NOT `user.write`.
 * `user.write` is the admin-wide bit; granting it to a Client so they could
 * add their own people would also let them create admins. This route
 * hard-codes `role: 'representative'` and takes `company_id` from the URL
 * (scope-checked against the caller's own company in the service), so
 * neither can be driven from the request body.
 */
router.post(
    '/:id/representatives',
    requirePermission(PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyIdParamSchema, body: createRepresentativeBodySchema }),
    asyncHandler(ctrl.postRepresentative)
);

export default router;
