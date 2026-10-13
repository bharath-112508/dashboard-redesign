/**
 * Auth / security policy constants (Company_Management_Plan.md §7).
 *
 *  - bcrypt cost:            12 rounds
 *  - password policy:        10–12 chars with upper + lower + digit + special
 *  - login lockout:          5 failed attempts → 15 min lock
 *  - MFA session TTL:        5 min (used in Step 3)
 */

export const BCRYPT_ROUNDS = 12;

/**
 * Hard ceiling on any configurable password max-length.
 *
 * bcrypt hashes at most 72 BYTES and silently discards the rest, so two
 * different passwords sharing a 72-byte prefix would both unlock the account.
 * Letting an admin set a maximum above this would advertise strength the
 * hashing can't deliver.
 */
export const PASSWORD_LENGTH_CEILING = 72;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 12;
// PASSWORD_REGEX lived here and hardcoded the whole rule (`{10,12}` plus all
// four character classes), which is why the six Settings → Security password
// fields did nothing. The rule is now assembled per-request from those
// settings in `utils/password-policy.ts`. The two constants above survive only
// as the fallback for a settings row that predates the fields.

export const MAX_LOGIN_ATTEMPTS = 5;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

export const MFA_SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Per-user active refresh-token cap (BACKEND_AUDIT.md P2-14).
 *
 * Each successful login / refresh writes a new `refresh_tokens` row.
 * Without a cap, a user who never explicitly revokes accumulates one
 * row per device they ever logged in on; over months this turns into
 * a long-tail of stale rows that the user can't see in `/auth/sessions`
 * (those filter to active rows only) but DO sit in Mongo forever.
 *
 * Behaviour: when a fresh login would make the active count exceed
 * `MAX_ACTIVE_SESSIONS_PER_USER`, the oldest active row is revoked
 * BEFORE the new one is written. Refresh-token rotation (which
 * already revokes the prior row) is unaffected — the cap is only
 * checked at the login boundary.
 *
 * 20 is generous: a heavy user with phone + tablet + 2 laptops + 2
 * browsers = 6 sessions; 20 leaves room for stale-but-not-expired
 * rows from device replacement before the cap kicks in.
 */
export const MAX_ACTIVE_SESSIONS_PER_USER = 20;

/**
 * Password reset tokens (Data_Model.md §1.3 / API_Contract §2.5–2.6).
 *
 *  - 32 random bytes → ~43-char base64url token in the email link.
 *  - Stored as SHA-256(token) so a DB leak can't replay links.
 *  - 1-hour TTL + single-use; requesting a new one invalidates older unused tokens.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
export const RESET_TOKEN_BYTES = 32;
/** A new contact's "set your password" link lasts longer than a reset link: they may not open it the same day. */
export const SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
