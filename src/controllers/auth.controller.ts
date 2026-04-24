import { Request, Response } from 'express';
import { Types } from 'mongoose';

import * as authService from '../services/auth.service.js';
import * as passwordResetService from '../services/password-reset.service.js';
import { ok, noContent } from '../utils/api-response.js';
import { AppError } from '../utils/app-error.js';
import { buildAuditContext } from '../utils/audit-context.js';
import type {
    LoginBody,
    RefreshBody,
    LogoutBody,
    ChangePasswordBody,
    ForgotPasswordBody,
    ResetPasswordBody,
} from '../validators/auth.validator.js';

const clientIp = (req: Request): string => {
    // `trust proxy` is set in index.ts → req.ip is the client IP, not the proxy's.
    return req.ip ?? req.socket.remoteAddress ?? '';
};

const userAgent = (req: Request): string => {
    return (req.headers['user-agent'] ?? '').toString().slice(0, 256);
};

const requireAuthUserId = (req: Request): Types.ObjectId => {
    if (!req.user?.user_id) {
        throw AppError.unauthenticated();
    }
    return new Types.ObjectId(req.user.user_id);
};

export const postLogin = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as LoginBody;
    const result = await authService.login({
        email: body.email,
        password: body.password,
        device_info: userAgent(req),
        ip_address: clientIp(req),
    });
    return ok(res, result);
};

export const postRefresh = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as RefreshBody;
    const result = await authService.refreshTokens({
        refresh_token: body.refresh_token,
        device_info: userAgent(req),
        ip_address: clientIp(req),
    });
    return ok(res, result);
};

export const postLogout = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as LogoutBody;
    await authService.logout(body.refresh_token);
    return noContent(res);
};

export const postLogoutAll = async (req: Request, res: Response): Promise<Response> => {
    const user_id = requireAuthUserId(req);
    await authService.logoutAll(user_id);
    return noContent(res);
};

export const postChangePassword = async (req: Request, res: Response): Promise<Response> => {
    const user_id = requireAuthUserId(req);
    const body = req.body as ChangePasswordBody;
    await authService.changePassword({
        user_id,
        old_password: body.old_password,
        new_password: body.new_password,
        audit: buildAuditContext(req),
    });
    return ok(res, { message: 'Password changed. Please login again on all devices.' });
};

export const getAuthMe = async (req: Request, res: Response): Promise<Response> => {
    const user_id = requireAuthUserId(req);
    const me = await authService.getMe(user_id);
    return ok(res, me);
};

// Always returns the same generic success regardless of whether the email
// matches an account — this is the contract's enumeration guard.
const FORGOT_PASSWORD_GENERIC_RESPONSE = {
    message: 'If this email is registered, a reset link has been sent.',
};

export const postForgotPassword = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as ForgotPasswordBody;
    await passwordResetService.requestPasswordReset(body.email);
    return ok(res, FORGOT_PASSWORD_GENERIC_RESPONSE);
};

export const postResetPassword = async (req: Request, res: Response): Promise<Response> => {
    const body = req.body as ResetPasswordBody;
    await passwordResetService.resetPassword({
        token: body.token,
        new_password: body.new_password,
        // The token validates the actor inside the service — pass a base
        // context with `unauthenticated` actor; the service overrides
        // `actor_id` + `actor_role` once the token is verified.
        audit: buildAuditContext(req),
    });
    return ok(res, { message: 'Password reset successful.' });
};
