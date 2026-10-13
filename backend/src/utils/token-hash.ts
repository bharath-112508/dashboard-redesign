import { createHash } from 'node:crypto';

/**
 * Deterministic SHA-256 hex digest.
 *
 * Used for `refresh_tokens.token_hash` — we never persist the raw refresh
 * token, only its hash. Reconstruction from the hash is infeasible, but
 * lookups by hash are O(1) given the unique index.
 */
export const sha256Hex = (input: string): string => {
    return createHash('sha256').update(input).digest('hex');
};
