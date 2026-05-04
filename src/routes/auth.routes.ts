import { Router } from 'express';

import * as auth from '../controllers/auth.controller.js';
import * as mfa from '../controllers/mfa.controller.js';
import { asyncHandler } from '../utils/async-handler.js';
import { authenticate } from '../middlewares/auth.middleware.js';
import { authRateLimiter } from '../middlewares/rate-limit.middleware.js';
import { validate } from '../middlewares/validate.middleware.js';
import {
    loginBodySchema,
    refreshBodySchema,
    logoutBodySchema,
    changePasswordBodySchema,
    forgotPasswordBodySchema,
    resetPasswordBodySchema,
} from '../validators/auth.validator.js';
import {
    mfaDisableBodySchema,
    mfaRegenerateBodySchema,
    mfaSetupConfirmBodySchema,
    mfaVerifyBodySchema,
} from '../validators/mfa.validator.js';
import { sessionIdPathSchema } from '../validators/session.validator.js';

const router = Router();

// ─── Public (brute-force protected) ─────────────────────────────────────────
router.post('/login', authRateLimiter, validate({ body: loginBodySchema }), asyncHandler(auth.postLogin));

router.post('/refresh', authRateLimiter, validate({ body: refreshBodySchema }), asyncHandler(auth.postRefresh));

// Logout accepts the refresh token in the body — also public, but cheap.
router.post('/logout', validate({ body: logoutBodySchema }), asyncHandler(auth.postLogout));

// ─── Password reset (public) ───────────────────────────────────────────────
// Both endpoints are rate-limited: forgot to prevent mailbox spam / enumeration
// probing, reset to prevent brute-forcing the opaque token.
router.post(
    '/forgot-password',
    authRateLimiter,
    validate({ body: forgotPasswordBodySchema }),
    asyncHandler(auth.postForgotPassword)
);

router.post(
    '/reset-password',
    authRateLimiter,
    validate({ body: resetPasswordBodySchema }),
    asyncHandler(auth.postResetPassword)
);

// ─── Authenticated ─────────────────────────────────────────────────────────
router.post('/logout-all', authenticate, asyncHandler(auth.postLogoutAll));

router.post(
    '/change-password',
    authenticate,
    authRateLimiter,
    validate({ body: changePasswordBodySchema }),
    asyncHandler(auth.postChangePassword)
);

router.get('/me', authenticate, asyncHandler(auth.getAuthMe));

// ─── Session management (Step 27) ──────────────────────────────────────────
//
// Both endpoints are caller-only — `authenticate` plus the service-layer
// `user_id` filter prevent cross-account access. The list takes no params
// (no pagination — typical user has < 10 active devices); the revoke
// endpoint accepts a single ObjectId path param. A per-user-id GET is
// deferred to a Phase-3 admin tool (Step 31 audit-viewer territory).

router.get('/sessions', authenticate, asyncHandler(auth.getAuthSessions));

router.post(
    '/sessions/:id/revoke',
    authenticate,
    validate({ params: sessionIdPathSchema }),
    asyncHandler(auth.postRevokeSession)
);

// ─── MFA ────────────────────────────────────────────────────────────────────
// /mfa/verify is "public" in that it does not require an access token —
// the mfa_session_token travels in the body and is brute-force-protected.
router.post('/mfa/verify', authRateLimiter, validate({ body: mfaVerifyBodySchema }), asyncHandler(mfa.postMfaVerify));

router.post('/mfa/setup/init', authenticate, asyncHandler(mfa.postMfaSetupInit));

router.post(
    '/mfa/setup/confirm',
    authenticate,
    authRateLimiter,
    validate({ body: mfaSetupConfirmBodySchema }),
    asyncHandler(mfa.postMfaSetupConfirm)
);

router.post(
    '/mfa/disable',
    authenticate,
    authRateLimiter,
    validate({ body: mfaDisableBodySchema }),
    asyncHandler(mfa.postMfaDisable)
);

router.post(
    '/mfa/backup-codes/regenerate',
    authenticate,
    authRateLimiter,
    validate({ body: mfaRegenerateBodySchema }),
    asyncHandler(mfa.postMfaRegenerateBackupCodes)
);

export default router;
