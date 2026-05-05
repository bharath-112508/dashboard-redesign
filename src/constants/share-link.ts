/**
 * Project share-link constants (Data_Model.md §5.8 / API_Contract.md §7.5
 * + 7.6 / BUILD_PROGRESS.md Step 24).
 *
 * Share links are read-only public URLs that let a client view a project
 * without logging in. Each link can be issued for a specific client
 * (`owner_client_id`) so the auto-revoke cascade on user deactivation
 * has a clear target, or as a generic share (`owner_client_id = null`)
 * which only an admin revoke can disable.
 *
 * Token shape:
 *  - 32 random bytes → 43-char base64url string. ~256 bits of entropy.
 *    Birthday-collision against 1 M issued links is ~1e-65 — collision
 *    handling is just for completeness, not a real expectation.
 */

// ─── Token generation ───────────────────────────────────────────────────

export const SHARE_LINK_TOKEN_BYTES = 32;
/**
 * Maximum retries on the unique-index collision before we surface a
 * 500. With 256 bits of entropy this loop should never iterate more
 * than once — the bound is a paranoia ceiling, not a regular path.
 */
export const SHARE_LINK_TOKEN_MAX_ATTEMPTS = 5;

// ─── Revoke reasons (stored verbatim on the row) ────────────────────────

export const SHARE_LINK_REVOKE_REASONS = {
    MANUAL: 'manual',
    CLIENT_DEACTIVATED: 'client_deactivated',
} as const;
export type ShareLinkRevokeReason = (typeof SHARE_LINK_REVOKE_REASONS)[keyof typeof SHARE_LINK_REVOKE_REASONS];

// ─── Pagination ─────────────────────────────────────────────────────────

export const SHARE_LINK_LIST_DEFAULT_LIMIT = 20;
export const SHARE_LINK_LIST_MAX_LIMIT = 100;

// Step 47: route gate is `requirePermission(share_link.write)` for
// list / create / revoke. The resolve endpoint is **public** (no
// `authenticate` middleware) — the token IS the auth.
