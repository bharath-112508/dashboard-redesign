import { z } from 'zod';

import { COMMAND_PALETTE_MAX_QUERY_LENGTH, COMMAND_PALETTE_MIN_QUERY_LENGTH } from '../constants/command-palette.js';

/**
 * `GET /command-palette[?q=...]` — Step 49.
 *
 * Single Cmd-K endpoint. Returns `{actions, items}` together so the
 * FE makes one HTTP call to render the modal. `q` is optional: an
 * empty Cmd-K (no query yet) returns the full caller-permitted
 * action catalog with items buckets empty; once the user starts
 * typing, the same endpoint scopes both layers.
 *
 * Bounds: `[1, 100]` chars. Items are fetched lazily by the service
 * only when `q` ≥ `SEARCH_MIN_QUERY_LENGTH` (currently 2) — a single-
 * character `q` filters actions but doesn't pay a Mongo round-trip
 * to search 4 collections for a substring that's almost certainly
 * too vague to be useful.
 *
 * `.strict()` rejects unknown keys to surface FE typos early.
 */
export const commandPaletteQuerySchema = z
    .object({
        q: z.string().trim().min(COMMAND_PALETTE_MIN_QUERY_LENGTH).max(COMMAND_PALETTE_MAX_QUERY_LENGTH).optional(),
    })
    .strict();

export type CommandPaletteQuery = z.infer<typeof commandPaletteQuerySchema>;
