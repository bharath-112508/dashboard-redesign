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
    listRepresentativesQuerySchema,
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

// 🔴 These two are READS and are gated on `COMPANY_READ` as well as
// `REPRESENTATIVE_WRITE`. They used to require the WRITE bit alone, which
// meant a Manager — who holds `company.read`, passes the `/:id` gate, and is
// routed to the company detail page by the frontend — opened that page and
// got "Couldn't load people / Insufficient permissions" on the Representatives
// tab. Reading who works at a client is a read; gating it on a write
// permission was the bug. The mutating routes below correctly keep
// `REPRESENTATIVE_WRITE` alone.
router.get(
    '/:id/representatives',
    requirePermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyIdParamSchema, query: listRepresentativesQuerySchema }),
    asyncHandler(ctrl.getRepresentatives)
);

/**
 * One person of the company.
 *
 * Exists because the list above is paginated — the profile page can't find
 * someone on page 2 by scanning a 10-row response. Same gate as the list.
 * Declared BEFORE the `POST`/`DELETE` on the same prefix is irrelevant (they
 * differ by verb), but it must not shadow anything: `:user_id` is an id, and
 * there are no literal sub-paths under `/representatives`.
 */
router.get(
    '/:id/representatives/:user_id',
    requirePermission(PERMISSIONS.COMPANY_READ, PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyRepresentativeParamSchema }),
    asyncHandler(ctrl.getRepresentative)
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
/**
 * Put a removed person back.
 *
 * Same gate as removal (`representative.write`), deliberately NOT
 * `user.deactivate` — that bit also governs reactivating ANY user, so a
 * Client holding it could revive a deactivated admin. The service restricts
 * a non-admin to `representative`s within their own company.
 */
router.post(
    '/:id/representatives/:user_id/restore',
    requirePermission(PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyRepresentativeParamSchema }),
    asyncHandler(ctrl.postRestoreRepresentative)
);

router.delete(
    '/:id/representatives/:user_id',
    requirePermission(PERMISSIONS.REPRESENTATIVE_WRITE),
    validate({ params: companyRepresentativeParamSchema }),
    asyncHandler(ctrl.deleteRepresentative)
);

export default router;
