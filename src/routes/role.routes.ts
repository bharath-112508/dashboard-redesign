import { Router } from 'express';

import * as ctrl from '../controllers/role.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
import {
    assignRolesBodySchema,
    createRoleBodySchema,
    listRolesQuerySchema,
    patchRoleBodySchema,
    roleIdParamSchema,
    updateExtraPermissionsBodySchema,
    userIdParamSchema,
} from '../validators/role.validator.js';

/**
 * Role-CRUD routes (Step 47 Phase C).
 *
 *  - `GET /roles`          — list (read permission)
 *  - `GET /roles/:id`      — detail
 *  - `POST /roles`         — create custom role (write permission)
 *  - `PATCH /roles/:id`    — update display/description/permissions
 *  - `DELETE /roles/:id`   — delete custom role (delete permission;
 *                            system roles + in-use roles refused)
 *
 * The user-assignment endpoint lives on its own router because it
 * mounts under `/users/:user_id/roles` rather than `/roles`. The
 * permission gate is `USER_ROLE_CHANGE` (existing perm — same one
 * the legacy `POST /users/:id/change-role` used).
 */

const router = Router();

router.use(authenticate);

router.get(
    '/',
    requirePermission(PERMISSIONS.ROLE_READ),
    validate({ query: listRolesQuerySchema }),
    asyncHandler(ctrl.getList)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.ROLE_WRITE),
    validate({ body: createRoleBodySchema }),
    asyncHandler(ctrl.postCreate)
);

router.get(
    '/:id',
    requirePermission(PERMISSIONS.ROLE_READ),
    validate({ params: roleIdParamSchema }),
    asyncHandler(ctrl.getOne)
);

router.patch(
    '/:id',
    requirePermission(PERMISSIONS.ROLE_WRITE),
    validate({ params: roleIdParamSchema, body: patchRoleBodySchema }),
    asyncHandler(ctrl.patchOne)
);

router.delete(
    '/:id',
    requirePermission(PERMISSIONS.ROLE_DELETE),
    validate({ params: roleIdParamSchema }),
    asyncHandler(ctrl.deleteOne)
);

export default router;

/**
 * Sibling router for `PATCH /users/:user_id/roles` and
 * `PATCH /users/:user_id/extra-permissions`. Both mount on `/users`
 * in `routes/index.ts` so the URLs match the natural resource
 * hierarchy (users → roles / extra-permissions), separate from the
 * `/roles` surface above. `requirePermission(USER_ROLE_CHANGE)` is
 * the same gate the legacy `POST /users/:id/change-role` endpoint
 * uses; Pattern B grants are admin-equivalent in blast radius so
 * they share the gate.
 */
export const userRolesAssignRouter = (): Router => {
    const r = Router({ mergeParams: true });
    r.use(authenticate);

    r.patch(
        '/:user_id/roles',
        requirePermission(PERMISSIONS.USER_ROLE_CHANGE),
        validate({ params: userIdParamSchema, body: assignRolesBodySchema }),
        asyncHandler(ctrl.patchUserRoles)
    );

    r.patch(
        '/:user_id/extra-permissions',
        requirePermission(PERMISSIONS.USER_ROLE_CHANGE),
        validate({ params: userIdParamSchema, body: updateExtraPermissionsBodySchema }),
        asyncHandler(ctrl.patchUserExtraPermissions)
    );

    return r;
};
