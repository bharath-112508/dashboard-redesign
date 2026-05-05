import { Router } from 'express';

import * as ctrl from '../controllers/share-link.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    createShareLinkBodySchema,
    listShareLinksQuerySchema,
    projectIdPathSchema,
    shareLinkIdPathSchema,
    shareLinkTokenPathSchema,
} from '../validators/share-link.validator.js';

/**
 * Project share-link routes (Step 24; API_Contract.md §7.5–7.6).
 *
 * Three routers because the resource is split:
 *
 *   1. `projectShareLinksNestedRouter` — nested under `/projects` so
 *      `/projects/:project_id/share-links{,/}` is the manager+admin
 *      surface. Authenticated.
 *   2. `shareLinksRouter` — top-level `/share-links/:id/revoke` for
 *      admin-only revokes. Authenticated.
 *   3. `publicShareLinksRouter` — top-level `/share-links/resolve/:token`.
 *      **No authentication.** The token IS the credential. The global
 *      rate limiter on `/api/*` is what stops token guessing.
 *
 * All three are mounted in `routes/index.ts`. The public router is
 * mounted last + on its own prefix so the auth-required routers can't
 * accidentally shadow it.
 */

// ─── Nested under /projects/:project_id/share-links ─────────────────────

export const projectShareLinksNestedRouter = (): Router => {
    const router = Router({ mergeParams: true });
    router.use(authenticate);

    router.get(
        '/:project_id/share-links',
        requirePermission(PERMISSIONS.SHARE_LINK_WRITE),
        validate({ params: projectIdPathSchema, query: listShareLinksQuerySchema }),
        asyncHandler(ctrl.getList)
    );

    router.post(
        '/:project_id/share-links',
        requirePermission(PERMISSIONS.SHARE_LINK_WRITE),
        validate({ params: projectIdPathSchema, body: createShareLinkBodySchema }),
        asyncHandler(ctrl.postCreate)
    );

    return router;
};

// ─── Top-level /share-links/:id/revoke ──────────────────────────────────

export const shareLinksRouter = (): Router => {
    const router = Router();
    router.use(authenticate);

    router.post(
        '/:id/revoke',
        requirePermission(PERMISSIONS.SHARE_LINK_WRITE),
        validate({ params: shareLinkIdPathSchema }),
        asyncHandler(ctrl.postRevoke)
    );

    return router;
};

// ─── Public /share-links/resolve/:token ─────────────────────────────────

export const publicShareLinksRouter = (): Router => {
    const router = Router();
    // **No `authenticate` middleware.** The token IS the credential.
    router.get('/resolve/:token', validate({ params: shareLinkTokenPathSchema }), asyncHandler(ctrl.getResolve));
    return router;
};
