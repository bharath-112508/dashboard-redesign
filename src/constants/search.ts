/**
 * Global-search constants (Step 32; API_Contract §13).
 *
 * One endpoint surfaces all four searchable collections. The contract
 * deliberately keeps the surface small — no fuzzy matching, no full-
 * text indexing in v1 — because the volume is bounded (a single-org
 * deployment) and case-insensitive regex against the indexed prefix
 * fields is comfortably under the 500 ms p95 target documented in
 * BUILD_PROGRESS Step 32 for <10 k docs per collection.
 *
 * Phase-4 upgrade path:
 *   - Add a text index on each searchable collection
 *     (`{name: 'text', code: 'text', ...}`)
 *   - Switch `buildRegex` callers to `{$text: {$search: q}}`
 *   - Or graduate to Atlas Search if/when fuzzy/typo-tolerance lands
 *     on the roadmap.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── RBAC ───────────────────────────────────────────────────────────────
//
// Every authenticated role reaches the endpoint; the *response* is
// scoped per-role inside the service. Role-level access is broad
// (everyone gets typeahead) so the gate just checks authentication —
// nothing more. Per-bucket rules live in `search.service`.

export const SEARCH_READ_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE, ROLES.CLIENT];

// ─── Searchable types ──────────────────────────────────────────────────
//
// Ordered so the response keys come out the same way every time (some
// FE serialisers rely on key order for diffing). Mirrors API_Contract
// §13 verbatim.

export const SEARCH_TYPES = ['users', 'projects', 'sprints', 'tasks'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

// ─── Limits ─────────────────────────────────────────────────────────────
//
// Per-bucket cap. The FE's typical surface is a 5–10-row autocomplete;
// 50 is the upper bound for a "more results" inline expander.

export const SEARCH_DEFAULT_LIMIT = 10;
export const SEARCH_MAX_LIMIT = 50;

// ─── Query-length floor ────────────────────────────────────────────────
//
// `q` must be at least 2 chars — single-letter queries match too
// many rows on a directory of any size and are usually a typeahead
// firing too early. The FE can debounce; the server enforces.

export const SEARCH_MIN_QUERY_LENGTH = 2;
export const SEARCH_MAX_QUERY_LENGTH = 100;
