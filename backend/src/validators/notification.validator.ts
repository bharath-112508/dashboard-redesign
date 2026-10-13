import { z } from 'zod';

import {
    NOTIFICATION_LIST_DEFAULT_LIMIT,
    NOTIFICATION_LIST_MAX_LIMIT,
    NOTIFICATION_TYPE_VALUES,
} from '../constants/notification.js';
import { booleanish } from './_shared.js';

/**
 * Zod validators for the notifications API (API_Contract §11).
 *
 * Conventions:
 *   - Pagination matches API_Contract §1.6: `page` (default 1, min 1),
 *     `limit` (default 20, max 100). Sorting is hard-coded to
 *     `created_at desc` server-side — there is no useful "sort by title"
 *     query for a bell list.
 *   - `is_read` accepts query strings ("true" / "false") and booleans, so
 *     both fetch styles work without ceremony at the FE.
 *   - All endpoints are owner-scoped at the service layer; the validator
 *     does not accept a `user_id` filter (admins use the user-management
 *     surfaces, not the notification list, to inspect other users).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

// ─── GET /notifications ────────────────────────────────────────────────────

export const listNotificationsQuerySchema = z
    .object({
        is_read: booleanish.optional(),
        type: z.enum(NOTIFICATION_TYPE_VALUES as [string, ...string[]]).optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(NOTIFICATION_LIST_MAX_LIMIT).default(NOTIFICATION_LIST_DEFAULT_LIMIT),
    })
    .strict();

export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;

// ─── ID param (POST /:id/read, DELETE /:id) ───────────────────────────────

export const notificationIdParamSchema = z.object({
    id: objectIdSchema,
});

export type NotificationIdParam = z.infer<typeof notificationIdParamSchema>;
