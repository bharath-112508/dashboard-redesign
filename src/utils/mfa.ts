import { randomBytes } from 'node:crypto';

import { generateSecret, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import bcrypt from 'bcrypt';

import { MFA_ISSUER } from '../config/server.config.js';
import { BCRYPT_ROUNDS } from '../constants/auth.js';

/**
 * MFA primitives — TOTP (RFC 6238) with a ±30 s clock-drift tolerance and
 * single-use backup codes. No state is kept here; all callers hand in the
 * secret / hashes stored on the user document.
 *
 * Design notes:
 *  - Defaults: SHA1 / 6 digits / 30 s period — the settings every mainstream
 *    authenticator app (Google, 1Password, Authy, Microsoft) assumes.
 *  - `epochTolerance: 30` accepts the previous and next 30 s codes to account
 *    for clock drift between the phone and the server.
 *  - Backup codes are bcrypt-hashed (same cost as passwords). We compare
 *    against *every* stored hash on verify; the list is bounded to 10 so the
 *    extra cost is acceptable.
 */

const TOTP_EPOCH_TOLERANCE = 30;

// ─── TOTP ───────────────────────────────────────────────────────────────────

export const generateTotpSecret = (): string => generateSecret({ length: 20 });

export const buildOtpAuthUrl = (email: string, secret: string): string => {
    return generateURI({ issuer: MFA_ISSUER, label: email, secret, strategy: 'totp' });
};

export const generateQrDataUrl = async (otpauth: string): Promise<string> => {
    return QRCode.toDataURL(otpauth, { errorCorrectionLevel: 'M', margin: 1 });
};

export const verifyTotp = (code: string, secret: string): boolean => {
    try {
        const result = verifySync({
            token: code,
            secret,
            strategy: 'totp',
            epochTolerance: TOTP_EPOCH_TOLERANCE,
        });
        return result.valid === true;
    } catch {
        return false;
    }
};

// ─── Backup codes ───────────────────────────────────────────────────────────

const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_BYTES = 5; // 5 bytes → 10 hex chars → ~1.1 trillion combinations

/**
 * Returns { plain, hashed } — the plain array is shown to the user exactly
 * once and thrown away immediately; only `hashed` is persisted.
 */
export const generateBackupCodes = async (): Promise<{ plain: string[]; hashed: string[] }> => {
    const plain: string[] = [];
    const hashed: string[] = [];

    for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
        const raw = randomBytes(BACKUP_CODE_BYTES).toString('hex').toUpperCase();
        const formatted = `${raw.slice(0, 5)}-${raw.slice(5)}`;
        plain.push(formatted);
        hashed.push(await bcrypt.hash(formatted, BCRYPT_ROUNDS));
    }

    return { plain, hashed };
};

/**
 * Searches for a matching hash in `hashed`, compares using bcrypt.compare.
 * Returns the matching index (to remove on success) or -1.
 *
 * Normalisation: we uppercase + trim the submitted code and strip dashes so
 * user variants ("ab12c-d34ef", "AB12CD34EF", "AB12C-D34EF") all match the
 * canonical "AB12C-D34EF" hash.
 */
export const findMatchingBackupCodeIndex = async (submitted: string, hashed: string[]): Promise<number> => {
    const canonical = normaliseBackupCode(submitted);
    for (let i = 0; i < hashed.length; i++) {
        if (await bcrypt.compare(canonical, hashed[i])) {
            return i;
        }
    }
    return -1;
};

const normaliseBackupCode = (input: string): string => {
    const cleaned = input.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    if (cleaned.length !== BACKUP_CODE_BYTES * 2) return input; // fall through; will fail compare
    return `${cleaned.slice(0, 5)}-${cleaned.slice(5)}`;
};
