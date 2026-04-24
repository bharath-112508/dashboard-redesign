import { z } from 'zod';

/**
 * Zod schemas for /auth/mfa/* routes. Kept intentionally loose on the code
 * field because the same endpoint accepts either a 6-digit TOTP code or a
 * dashed backup code; the service layer chooses its verification path based
 * on `is_backup_code`.
 */

const codeField = z.string().min(6, 'code is required').max(32);

export const mfaVerifyBodySchema = z.object({
    mfa_session_token: z.string().min(1, 'mfa_session_token is required'),
    code: codeField,
    is_backup_code: z.boolean().default(false),
});

export const mfaSetupConfirmBodySchema = z.object({
    code: codeField,
});

export const mfaDisableBodySchema = z.object({
    password: z.string().min(1, 'password is required'),
    code: codeField,
});

export const mfaRegenerateBodySchema = z.object({
    code: codeField,
});

export type MfaVerifyBody = z.infer<typeof mfaVerifyBodySchema>;
export type MfaSetupConfirmBody = z.infer<typeof mfaSetupConfirmBodySchema>;
export type MfaDisableBody = z.infer<typeof mfaDisableBodySchema>;
export type MfaRegenerateBody = z.infer<typeof mfaRegenerateBodySchema>;
