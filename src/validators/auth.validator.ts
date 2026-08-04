import { z } from 'zod';

/**
 * Zod schemas for `/auth/*` routes. Every schema is parsed by the `validate`
 * middleware, which on failure throws `AppError.validation(...)` with details
 * shaped per API_Contract §1.5.
 */

/**
 * Structural only — the real rule lives in `utils/password-policy.ts` and is
 * read from `system_settings.security` at request time.
 *
 * This used to be `.min(10).max(12).regex(...)` built from module-scope
 * constants, which is why the six Settings → Security fields did nothing: a
 * static Zod schema is frozen at import and cannot see a value an admin
 * changes at runtime. Enforcement moved down to the service layer, where it
 * can `await` the settings. Don't reintroduce length/character rules here —
 * a second definition is exactly the drift this removed.
 */
export const passwordPolicy = z.string().min(1, 'Password is required');

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
