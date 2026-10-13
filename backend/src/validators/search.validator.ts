import { z } from 'zod';

import {
    SEARCH_DEFAULT_LIMIT,
    SEARCH_MAX_LIMIT,
    SEARCH_MAX_QUERY_LENGTH,
    SEARCH_MIN_QUERY_LENGTH,
    SEARCH_TYPES,
} from '../constants/search.js';

/**
 * Zod schema for `GET /search` (Step 32; API_Contract §13).
 *
 * `types` is a comma-separated list (`?types=users,projects,tasks`).
 * That's how URLs traditionally encode multi-value flags and is what
 * the contract example shows. We split + dedupe + validate against
 * the enum here so the service receives a clean `Set<SearchType>`.
 *
 * When `types` is absent, the service treats the request as "all four
 * types" — the schema preserves `undefined` so the service can
 * distinguish "no preference" from "explicit empty list". An empty list
 * (e.g. `?types=`) is rejected so the FE can't accidentally fire a
 * zero-bucket request that returns an empty response shape but still
 * hits the DB four times.
 */

const searchTypesSchema = z
    .string()
    .min(1, 'types must be a non-empty comma-separated list')
    .transform((raw, ctx) => {
        const parts = raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
        if (parts.length === 0) {
            ctx.addIssue({
                code: 'custom',
                message: 'types must contain at least one value',
            });
            return z.NEVER;
        }
        const known: (typeof SEARCH_TYPES)[number][] = [];
        for (const p of parts) {
            if ((SEARCH_TYPES as readonly string[]).includes(p)) {
                if (!known.includes(p as (typeof SEARCH_TYPES)[number])) {
                    known.push(p as (typeof SEARCH_TYPES)[number]);
                }
            } else {
                ctx.addIssue({
                    code: 'custom',
                    message: `Unknown type "${p}". Allowed: ${SEARCH_TYPES.join(', ')}`,
                });
                return z.NEVER;
            }
        }
        return known;
    });

export const searchQuerySchema = z
    .object({
        q: z
            .string()
            .trim()
            .min(SEARCH_MIN_QUERY_LENGTH, `q must be at least ${SEARCH_MIN_QUERY_LENGTH} characters`)
            .max(SEARCH_MAX_QUERY_LENGTH, `q must be at most ${SEARCH_MAX_QUERY_LENGTH} characters`),
        types: searchTypesSchema.optional(),
        limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).default(SEARCH_DEFAULT_LIMIT),
    })
    .strict();

export type SearchQuery = z.infer<typeof searchQuerySchema>;
