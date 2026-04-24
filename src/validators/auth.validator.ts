import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_REGEX } from '../constants/auth.js';

/**
 * Zod schemas for `/auth/*` routes. Every schema is parsed by the `validate`
 * middleware, which on failure throws `AppError.validation(...)` with details
 * shaped per API_Contract §1.5.
 */

const passwordPolicyMessage =
    `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters ` +
    'and include upper, lower, number, and special character.';

export const passwordPolicy = z
    .string()
    .min(PASSWORD_MIN_LENGTH, passwordPolicyMessage)
    .max(PASSWORD_MAX_LENGTH, passwordPolicyMessage)
    .regex(PASSWORD_REGEX, passwordPolicyMessage);

export const loginBodySchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    // login accepts ANY non-empty string — we never echo policy hints to anonymous callers.
    password: z.string().min(1, 'Password is required'),
});

export const refreshBodySchema = z.object({
    refresh_token: z.string().min(1, 'refresh_token is required'),
});

export const logoutBodySchema = z.object({
    refresh_token: z.string().min(1, 'refresh_token is required'),
});

export const changePasswordBodySchema = z
    .object({
        old_password: z.string().min(1, 'old_password is required'),
        new_password: passwordPolicy,
    })
    .refine((data) => data.old_password !== data.new_password, {
        message: 'new_password must differ from old_password',
        path: ['new_password'],
    });

export const forgotPasswordBodySchema = z.object({
    email: z.string().trim().toLowerCase().email(),
});

export const resetPasswordBodySchema = z.object({
    // Base64url tokens decode from 32 raw bytes → ~43 chars. Keep bounds loose
    // so future token size changes don't require a validator change.
    token: z.string().min(20, 'token is required').max(256),
    new_password: passwordPolicy,
});

export type LoginBody = z.infer<typeof loginBodySchema>;
export type RefreshBody = z.infer<typeof refreshBodySchema>;
export type LogoutBody = z.infer<typeof logoutBodySchema>;
export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;
export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
