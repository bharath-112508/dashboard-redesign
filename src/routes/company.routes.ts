import { Router } from 'express';

import * as ctrl from '../controllers/company.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    companyIdParamSchema,
    companyRepresentativeParamSchema,
    createCompanyBodySchema,
    createRepresentativeBodySchema,
    listCompaniesQuerySchema,
    patchCompanyBodySchema,
} from '../validators/company.validator.js';

const router = Router();

router.use(authenticate);

// ─── Collection ──────────────────────────────────────────────────────────

// `requirePermission` is OR-semantics across its args.
//
// `company.read` (admin + manager) is the full directory. A `client` holds
// only `representative.write` and must reach their OWN company — the service
// narrows their result set to it. Gating on COMPANY_READ alone made that
// narrowing UNREACHABLE: the route 403'd before the service ever ran, so the
// client-scoping branch in `listCompanies` was dead code.
router.get(
    '/',
    requirePermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.REPRESENTATIVE_WRITE),
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

// Same as the list: a `client` reads their own company here, and
// `assertCallerOwnsCompany` in the service is what pins it to theirs.
// COMPANY_READ alone made that assertion unreachable too.
router.get(
    '/:id',
    requirePermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.REPRESENTATIVE_WRITE),
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

/**
 * Remove someone from the company — deactivates them.
 *
 * Gated on `representative.write`, NOT `user.deactivate`: that bit is
 * admin-wide and would let a Client deactivate any user, admins included.
 * The service additionally restricts a non-admin caller to removing
 * `representative`s within their own company.
 */
router.delete(
    '/:id/representatives/:user_id',
    requirePermission(PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyRepresentativeParamSchema }),
    asyncHandler(ctrl.deleteRepresentative)
);

export default router;
