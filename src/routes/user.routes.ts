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
import {
    finalizeBodySchema as profilePhotoFinalizeBodySchema,
    uploadUrlBodySchema as profilePhotoUploadUrlBodySchema,
} from '../validators/profile-photo.validator.js';

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

// ─── Profile photo (Step 22) ──────────────────────────────────────────────
//
// `/me` endpoints — caller is always the subject. No authorize() needed
// beyond `authenticate` (set at the router root above): every active user
// can manage their own avatar. Spec keeps this path as POST (mint via
// POST /upload-url, finalize via POST), aligning with task-attachments.

router.post(
    '/me/profile-photo-upload-url',
    validate({ body: profilePhotoUploadUrlBodySchema }),
    asyncHandler(users.postProfilePhotoUploadUrl)
);

router.post(
    '/me/profile-photo',
    validate({ body: profilePhotoFinalizeBodySchema }),
    asyncHandler(users.postProfilePhotoFinalize)
);

router.delete('/me/profile-photo', asyncHandler(users.deleteProfilePhoto));

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
