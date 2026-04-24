import { Router } from 'express';

import * as users from '../controllers/user.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, authorize } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { ROLES } from '../constants/roles.js';
import {
    assignableQuerySchema,
    changeRoleBodySchema,
    createUserBodySchema,
    deactivateUserBodySchema,
    listUsersQuerySchema,
    updateUserBodySchema,
    userIdParamSchema,
} from '../validators/user.validator.js';

const router = Router();

// Every endpoint under /users requires an access token.
router.use(authenticate);

// ─── Collection routes ─────────────────────────────────────────────────────

router.get('/assignable', validate({ query: assignableQuerySchema }), asyncHandler(users.getAssignableUsers));

router.get(
    '/',
    authorize(ROLES.ADMIN, ROLES.MANAGER),
    validate({ query: listUsersQuerySchema }),
    asyncHandler(users.getListUsers)
);

router.post('/', authorize(ROLES.ADMIN), validate({ body: createUserBodySchema }), asyncHandler(users.postCreateUser));

// ─── Deferred profile-photo surface (returns 501) ──────────────────────────

router.post('/me/profile-photo', asyncHandler(users.notImplemented));
router.get('/me/profile-photo-upload-url', asyncHandler(users.notImplemented));

// ─── Item routes — id param must appear AFTER the named collection routes ──

router.get('/:id', validate({ params: userIdParamSchema }), asyncHandler(users.getUserById));

router.patch(
    '/:id',
    validate({ params: userIdParamSchema, body: updateUserBodySchema }),
    asyncHandler(users.patchUser)
);

router.post(
    '/:id/deactivate',
    authorize(ROLES.ADMIN),
    validate({ params: userIdParamSchema, body: deactivateUserBodySchema }),
    asyncHandler(users.postDeactivateUser)
);

router.post(
    '/:id/reactivate',
    authorize(ROLES.ADMIN),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.postReactivateUser)
);

router.post(
    '/:id/change-role',
    authorize(ROLES.ADMIN),
    validate({ params: userIdParamSchema, body: changeRoleBodySchema }),
    asyncHandler(users.postChangeUserRole)
);

// Deferred admin-triggered password reset (needs email service).
router.post('/:id/reset-password', authorize(ROLES.ADMIN), asyncHandler(users.notImplemented));

export default router;
