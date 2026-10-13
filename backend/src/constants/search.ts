/**
 * Global-search constants (Step 32; API_Contract §13).
 *
 * One endpoint surfaces all four searchable collections. Phase-4 (this
 * file's current state) implements the hybrid `regex` + `$text` path:
 *
 *   - **q.length < `TEXT_SEARCH_MIN_QUERY_LENGTH`** (1-2 chars) →
 *     case-insensitive regex on the legacy single-field set
 *     (`name`/`code`/`title`). Required for typeahead — Mongo's
 *     `$text` tokenises by whitespace so `proj` won't match
 *     `project`. Regex is the only way to match prefix substrings.
 *   - **q.length ≥ `TEXT_SEARCH_MIN_QUERY_LENGTH`** → `$text:$search`
 *     against the per-collection text index (Step 33). Faster on
 *     large collections (text indexes use word tries); also gains
 *     stemming + stopword handling from Mongo.
 *
 * `users` bucket stays regex-only at every length: $text on users
 * spans `full_name + email + employee_id + job_title`, but the
 * Step-32 PII contract forbids matching on email — switching to
 * $text would silently widen the surface. Custom per-field $text
 * isn't a thing in Mongo, so regex is the only correct option.
 *
 * Future-graduation path: Atlas Search / Elasticsearch once fuzzy
 * matching, typo tolerance, or per-field $text become must-haves.
 */

// Step 47: route gate is just `authenticate` — every authenticated
// role reaches the endpoint. Per-bucket scoping lives in
// `search.service`.

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

// ─── $text vs regex threshold ──────────────────────────────────────────
//
// Above this length we route through Mongo's text index; below it we
// stay on regex (typeahead UX). 3 is the smallest length where stemming
// + whole-word matching produce useful hits without too many false
// negatives. A 2-char query like "al" can't be a meaningful $text token
// — Mongo tokenises by whitespace and won't match "al" against "alice".

export const TEXT_SEARCH_MIN_QUERY_LENGTH = 3;
