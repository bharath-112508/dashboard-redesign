/**
 * Auth / security policy constants (Company_Management_Plan.md §7).
 *
 *  - bcrypt cost:            12 rounds
 *  - password policy:        10–12 chars with upper + lower + digit + special
 *  - login lockout:          5 failed attempts → 15 min lock
 *  - MFA session TTL:        5 min (used in Step 3)
 */

export const BCRYPT_ROUNDS = 12;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 12;
export const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^\da-zA-Z]).{10,12}$/;

export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

export const MFA_SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Password reset tokens (Data_Model.md §1.3 / API_Contract §2.5–2.6).
 *
 *  - 32 random bytes → ~43-char base64url token in the email link.
 *  - Stored as SHA-256(token) so a DB leak can't replay links.
 *  - 1-hour TTL + single-use; requesting a new one invalidates older unused tokens.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const RESET_TOKEN_BYTES = 32;
