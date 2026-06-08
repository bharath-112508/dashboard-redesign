import { Router } from 'express';

import * as users from '../controllers/user.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate, requirePermission, requirePermissionOrSelf } from '../middlewares/auth.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import { PERMISSIONS } from '../constants/permissions.js';
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
    requirePermission(PERMISSIONS.USER_READ),
    validate({ query: listUsersQuerySchema }),
    asyncHandler(users.getListUsers)
);

router.post(
    '/',
    requirePermission(PERMISSIONS.USER_WRITE),
    validate({ body: createUserBodySchema }),
    asyncHandler(users.postCreateUser)
);

// ─── Profile photo (Step 22) ──────────────────────────────────────────────
//
// `/me` endpoints — caller is always the subject. No `requirePermission`
// needed beyond `authenticate` (set at the router root above): every
// active user can manage their own avatar. Spec keeps this path as POST
// (mint via POST /upload-url, finalize via POST), aligning with
// task-attachments.

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

// M2 — gate at the route layer in addition to the service-layer guard
// (`isAdminLike(caller) || isSelf`). Pre-M2 this route had NO
// `requirePermission`, leaving service-side `isAdmin || isSelf` as the
// sole defence — fine today, fragile if anyone ever refactors the
// service and drops that check. `requirePermissionOrSelf` mirrors the
// same policy at the edge.
router.patch(
    '/:id',
    requirePermissionOrSelf(PERMISSIONS.USER_WRITE),
    validate({ params: userIdParamSchema, body: updateUserBodySchema }),
    asyncHandler(users.patchUser)
);

router.post(
    '/:id/deactivate',
    requirePermission(PERMISSIONS.USER_DEACTIVATE),
    validate({ params: userIdParamSchema, body: deactivateUserBodySchema }),
    asyncHandler(users.postDeactivateUser)
);

router.post(
    '/:id/reactivate',
    requirePermission(PERMISSIONS.USER_DEACTIVATE),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.postReactivateUser)
);

router.post(
    '/:id/change-role',
    requirePermission(PERMISSIONS.USER_ROLE_CHANGE),
    validate({ params: userIdParamSchema, body: changeRoleBodySchema }),
    asyncHandler(users.postChangeUserRole)
);

// Deferred admin-triggered password reset (needs email service).
router.post(
    '/:id/reset-password',
    requirePermission(PERMISSIONS.USER_WRITE),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.postAdminResetPassword)
);

// ─── Admin profile photo (per-id resource) ────────────────────────────────
//
// Mirrors the `/me/profile-photo*` set but acts on another user. Gated on
// `USER_WRITE` (same as `PATCH /:id`) so the same admin/manager surface
// that can edit profile fields can also manage the avatar.

router.post(
    '/:id/profile-photo-upload-url',
    requirePermission(PERMISSIONS.USER_WRITE),
    validate({ params: userIdParamSchema, body: profilePhotoUploadUrlBodySchema }),
    asyncHandler(users.adminPostProfilePhotoUploadUrl)
);

router.post(
    '/:id/profile-photo',
    requirePermission(PERMISSIONS.USER_WRITE),
    validate({ params: userIdParamSchema, body: profilePhotoFinalizeBodySchema }),
    asyncHandler(users.adminPostProfilePhotoFinalize)
);

router.delete(
    '/:id/profile-photo',
    requirePermission(PERMISSIONS.USER_WRITE),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.adminDeleteProfilePhoto)
);

// ─── GDPR DSAR + erasure (BACKEND_AUDIT.md P1-8) ───────────────────────────
// Admin-only. Two distinct permissions so an org can grant export
// access to legal/HR without granting the destructive erasure flow.

router.get(
    '/:id/data-export',
    requirePermission(PERMISSIONS.USER_DATA_EXPORT),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.getUserDataExport)
);

router.post(
    '/:id/data-erasure',
    requirePermission(PERMISSIONS.USER_DATA_ERASURE),
    validate({ params: userIdParamSchema }),
    asyncHandler(users.postUserDataErasure)
);

export default router;
