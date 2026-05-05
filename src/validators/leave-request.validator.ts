import { z } from 'zod';
// Use the platform-configured dayjs singleton so the `customParseFormat`
// plugin is loaded — required for the strict-parse third-arg to actually
// be strict (otherwise `dayjs('2026-13-01', 'YYYY-MM-DD', true)` lenient-
// parses to a rolled-over valid date and the .refine below becomes a no-op).
import dayjs from '../utils/date.js';

import {
    APPROVER_REMARKS_MAX,
    ADDITIONAL_APPROVAL_REASON_MAX,
    ADDITIONAL_APPROVAL_REASON_MIN,
    CANCELLATION_REASON_MAX,
    HALF_DAY_SLOTS,
    ISO_DATE_REGEX,
    LEAVE_REQUEST_MAX_DAYS,
    LEAVE_REQUEST_STATUSES,
    REASON_MAX,
} from '../constants/leave.js';

/**
 * Zod schemas for `/leaves` (API_Contract.md §5.3–5.8).
 *
 * Half-day rule: when `is_half_day=true`, `start_date` and `end_date` must be
 * the same day, and `half_day_slot` must be one of `first_half|second_half`.
 * Anything else returns 422 at the validator layer (engine never sees it).
 *
 * `LEAVE_REQUEST_MAX_DAYS` caps the calendar span — the server still
 * computes per-segment days excluding weekends/holidays, but a cap stops
 * pathological 5-year requests from hitting the engine.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const isoDate = z
    .string()
    .regex(ISO_DATE_REGEX, 'Must be YYYY-MM-DD')
    .refine((v) => dayjs(v, 'YYYY-MM-DD', true).isValid(), 'Must be a real calendar date');

// ─── POST /leaves + POST /leaves/preview-split (shared body) ──────────────

export const applyLeaveBodySchema = z
    .object({
        leave_type_id: objectIdSchema,
        start_date: isoDate,
        end_date: isoDate,
        is_half_day: z.boolean().default(false),
        half_day_slot: z.enum([HALF_DAY_SLOTS.FIRST_HALF, HALF_DAY_SLOTS.SECOND_HALF]).nullable().optional(),
        reason: z.string().trim().min(1).max(REASON_MAX),
        attachment_url: z.string().url().nullable().optional(),
    })
    .superRefine((data, ctx) => {
        const start = dayjs(data.start_date, 'YYYY-MM-DD', true);
        const end = dayjs(data.end_date, 'YYYY-MM-DD', true);
        if (start.isAfter(end)) {
            ctx.addIssue({
                code: 'custom',
                message: 'start_date must be on or before end_date',
                path: ['start_date'],
            });
            return;
        }

        const span = end.diff(start, 'day') + 1;
        if (span > LEAVE_REQUEST_MAX_DAYS) {
            ctx.addIssue({
                code: 'custom',
                message: `Request span exceeds maximum of ${LEAVE_REQUEST_MAX_DAYS} days`,
                path: ['end_date'],
            });
            return;
        }

        if (data.is_half_day) {
            if (data.start_date !== data.end_date) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'Half-day requests must have start_date == end_date',
                    path: ['end_date'],
                });
            }
            if (!data.half_day_slot) {
                ctx.addIssue({
                    code: 'custom',
                    message: 'half_day_slot is required when is_half_day is true',
                    path: ['half_day_slot'],
                });
            }
        } else if (data.half_day_slot) {
            ctx.addIssue({
                code: 'custom',
                message: 'half_day_slot is only valid when is_half_day is true',
                path: ['half_day_slot'],
            });
        }
    });

export type ApplyLeaveBody = z.infer<typeof applyLeaveBodySchema>;

// ─── POST /leaves/:id/approve ─────────────────────────────────────────────

export const approveLeaveBodySchema = z
    .object({
        approver_remarks: z.string().trim().max(APPROVER_REMARKS_MAX).optional().default(''),
        additional_approval_reason: z
            .string()
            .trim()
            .min(ADDITIONAL_APPROVAL_REASON_MIN)
            .max(ADDITIONAL_APPROVAL_REASON_MAX)
            .optional(),
    })
    .strict();

export type ApproveLeaveBody = z.infer<typeof approveLeaveBodySchema>;

// ─── POST /leaves/:id/reject ──────────────────────────────────────────────

export const rejectLeaveBodySchema = z
    .object({
        approver_remarks: z.string().trim().min(1).max(APPROVER_REMARKS_MAX),
    })
    .strict();

export type RejectLeaveBody = z.infer<typeof rejectLeaveBodySchema>;

// ─── POST /leaves/:id/cancel ──────────────────────────────────────────────

export const cancelLeaveBodySchema = z
    .object({
        cancellation_reason: z.string().trim().min(1).max(CANCELLATION_REASON_MAX),
    })
    .strict();

export type CancelLeaveBody = z.infer<typeof cancelLeaveBodySchema>;

// ─── GET /leaves ──────────────────────────────────────────────────────────

export const listLeavesQuerySchema = z
    .object({
        status: z.enum(Object.values(LEAVE_REQUEST_STATUSES) as [string, ...string[]]).optional(),
        user_id: objectIdSchema.optional(),
        from_date: isoDate.optional(),
        to_date: isoDate.optional(),
        requires_additional_approval: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
        page: z.coerce.number().int().positive().optional().default(1),
        limit: z.coerce.number().int().positive().max(200).optional().default(50),
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
            }
        }
    });

export type ListLeavesQuery = z.infer<typeof listLeavesQuerySchema>;

// ─── GET /leaves/calendar ────────────────────────────────────────────────

export const calendarLeavesQuerySchema = z
    .object({
        from_date: isoDate,
        to_date: isoDate,
    })
    .superRefine((data, ctx) => {
        const from = dayjs(data.from_date, 'YYYY-MM-DD', true);
        const to = dayjs(data.to_date, 'YYYY-MM-DD', true);
        if (from.isAfter(to)) {
            ctx.addIssue({
                code: 'custom',
                message: 'from_date must be on or before to_date',
                path: ['from_date'],
            });
        }
        if (to.diff(from, 'day') > 366) {
            ctx.addIssue({
                code: 'custom',
                message: 'Calendar range cannot exceed 366 days',
                path: ['to_date'],
            });
        }
    });

export type CalendarLeavesQuery = z.infer<typeof calendarLeavesQuerySchema>;

// ─── Path params ──────────────────────────────────────────────────────────

export const leaveIdParamSchema = z.object({ id: objectIdSchema });
export type LeaveIdParam = z.infer<typeof leaveIdParamSchema>;
