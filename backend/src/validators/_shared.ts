import { z } from 'zod';

/**
 * Shared Zod helpers for validators across the API.
 *
 * `booleanish` — safe boolean coercion for query params.
 *
 *   `z.coerce.boolean()` is `Boolean(value)`, which makes ANY non-empty
 *   string truthy — `Boolean("false") === true`. So a query param
 *   `?active_only=false` arrives at the server as the string `"false"`
 *   and `coerce.boolean` flips it to `true`. Net effect: every
 *   FE/curl/Postman caller passing the literal string `"false"` gets
 *   the OPPOSITE of what they asked for, silently. The bug surfaced
 *   on three validators during Phase 15 / 17 rechecks (share-link
 *   `active_only`, comment + attachment `include_deleted`); H4 fixed
 *   them with this helper.
 *
 *   `booleanish` accepts the strings "true"/"false" or a real boolean,
 *   then transforms to a real boolean. Anything else (`"yes"`, `"1"`,
 *   `"0"`) fails validation with a 400 — fail-loud is correct here, we
 *   don't want silent guesses about user intent.
 */
export const booleanish = z
    .union([z.literal('true'), z.literal('false'), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true'));
