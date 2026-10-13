import { z } from 'zod';

import { TIMELINE_RANGE_MAX_DAYS } from '../constants/timeline.js';

/**
 * Zod validators for `GET /projects/:project_id/timeline` (Phase 4 Step 41).
 *
 * The cross-field refine (range cap + ordering) mirrors the Step-29
 * report validators — the platform's "always validate the date pair
 * together" pattern.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD date');

const dateRangeMessage = `from_date must be on or before to_date and the window cannot exceed ${TIMELINE_RANGE_MAX_DAYS} days`;

export const projectIdParamSchema = z.object({ project_id: objectIdSchema });
export type ProjectIdParam = z.infer<typeof projectIdParamSchema>;

export const timelineQuerySchema = z
    .object({
        from_date: isoDateSchema,
        to_date: isoDateSchema,
        sprint_id: objectIdSchema.optional(),
        story_id: objectIdSchema.optional(),
        // When false (default), tasks with `status: 'done'` are excluded
        // — the typical Gantt view focuses on what's left to do. The
        // FE flips this on for retro / "completed work" views.
        include_completed: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .default(false),
    })
    .strict()
    .refine(
        (q) => {
            if (q.from_date > q.to_date) return false;
            const span = (Date.parse(q.to_date) - Date.parse(q.from_date)) / 86_400_000;
            return span <= TIMELINE_RANGE_MAX_DAYS;
        },
        { message: dateRangeMessage, path: ['to_date'] }
    );
export type TimelineQuery = z.infer<typeof timelineQuerySchema>;
