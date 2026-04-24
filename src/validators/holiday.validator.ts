import { z } from 'zod';
import dayjs from 'dayjs';

import { BULK_INSERT_MAX, ISO_DATE_REGEX, LIST_MAX_RANGE_YEARS, NAME_MAX } from '../constants/holiday.js';

/**
 * Zod schemas for `/holidays` (API_Contract.md §4.3, Data_Model.md §2.3).
 *
 * Conventions:
 *  - All dates are strict `YYYY-MM-DD` (Asia/Kolkata local). The leave segment
 *    generator and attendance finalizer compare on string equality, so any
 *    timezone drift in the input would silently mis-match downstream.
 *  - List supports the union of `{from_date, to_date}` and `year`. If `year`
 *    is supplied it expands to that calendar's full Jan 1 → Dec 31 in the
 *    service layer. Mixing both is allowed: explicit `from_date` / `to_date`
 *    win, `year` is ignored when either is present.
 *  - Bulk-create caps at `BULK_INSERT_MAX` so a 10K-row CSV paste can't blow
 *    up the request body / DB write batch.
 *  - Duplicate dates inside a single bulk request are rejected at the
 *    validator layer (cheaper than catching the DB error and rolling back).
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const isoDate = z
    .string()
    .regex(ISO_DATE_REGEX, 'Must be YYYY-MM-DD')
    .refine((v) => dayjs(v, 'YYYY-MM-DD', true).isValid(), 'Must be a real calendar date');

const nameSchema = z.string().trim().min(1).max(NAME_MAX);

// ─── POST /holidays ────────────────────────────────────────────────────────

export const createHolidayBodySchema = z.object({
    date: isoDate,
    name: nameSchema,
    is_optional: z.boolean().optional(),
});

export type CreateHolidayBody = z.infer<typeof createHolidayBodySchema>;

// ─── POST /holidays/bulk ──────────────────────────────────────────────────

export const bulkCreateHolidaysBodySchema = z
    .object({
        items: z.array(createHolidayBodySchema).min(1).max(BULK_INSERT_MAX),
    })
    .superRefine((data, ctx) => {
        const seen = new Set<string>();
        data.items.forEach((item, idx) => {
            if (seen.has(item.date)) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Duplicate date in payload: ${item.date}`,
                    path: ['items', idx, 'date'],
                });
            }
            seen.add(item.date);
        });
    });

export type BulkCreateHolidaysBody = z.infer<typeof bulkCreateHolidaysBodySchema>;

// ─── PATCH /holidays/:id ──────────────────────────────────────────────────

export const patchHolidayBodySchema = z
    .object({
        date: isoDate,
        name: nameSchema,
        is_optional: z.boolean(),
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one field must be supplied',
    });

export type PatchHolidayBody = z.infer<typeof patchHolidayBodySchema>;

// ─── GET /holidays ─────────────────────────────────────────────────────────

export const listHolidaysQuerySchema = z
    .object({
        from_date: isoDate.optional(),
        to_date: isoDate.optional(),
        year: z.coerce.number().int().gte(1970).lte(9999).optional(),
        is_optional: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
    })
    .superRefine((data, ctx) => {
        if (data.from_date && data.to_date) {
            const from = dayjs(data.from_date, 'YYYY-MM-DD', true);
            const to = dayjs(data.to_date, 'YYYY-MM-DD', true);
            if (from.isAfter(to)) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'from_date must be on or before to_date',
                    path: ['from_date'],
                });
                return;
            }
            if (to.diff(from, 'year', true) > LIST_MAX_RANGE_YEARS) {
                ctx.addIssue({
                    code: 'custom',
                    message: `Range exceeds ${LIST_MAX_RANGE_YEARS} years`,
                    path: ['to_date'],
                });
            }
        } else if (data.from_date && !data.to_date) {
            ctx.addIssue({
                code: 'custom',
                message: 'to_date required when from_date is set',
                path: ['to_date'],
            });
        } else if (data.to_date && !data.from_date) {
            ctx.addIssue({
                code: 'custom',
                message: 'from_date required when to_date is set',
                path: ['from_date'],
            });
        }
    });

export type ListHolidaysQuery = z.infer<typeof listHolidaysQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const holidayIdParamSchema = z.object({
    id: objectIdSchema,
});

export type HolidayIdParam = z.infer<typeof holidayIdParamSchema>;
