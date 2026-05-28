import { z } from 'zod';
import dayjs from 'dayjs';

import {
    ATTENDANCE_DATE_RANGE_MAX_DAYS,
    ATTENDANCE_NOTES_MAX,
    ATTENDANCE_STATUSES,
    CHECK_METHODS,
    CORRECTION_REASON_MAX,
    CORRECTION_REASON_MIN,
    CORRECTION_REMARKS_MAX,
    CORRECTION_REQUEST_STATUSES,
} from '../constants/attendance.js';

/**
 * Zod schemas for `/attendance` (API_Contract.md §6).
 *
 * Conventions:
 *  - Body shapes are method-discriminated (`{method:"manual"}` vs
 *    `{method:"qr", qr_token:"..."}`) so each branch can require its own
 *    fields without leaking optional locks for the other.
 *  - Geofence / WiFi fields are optional on the body; the service decides
 *    whether they're *required* based on `system_settings.attendance.*`.
 *    That way the validator stays role-agnostic and we don't have to
 *    re-fetch settings inside the schema.
 *  - Date-range queries cap span at `ATTENDANCE_DATE_RANGE_MAX_DAYS` so a
 *    single caller can't pull a year of records in one shot.
 */

const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

const isoDateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');

const isoDateTime = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Must be a valid ISO timestamp');

const latitudeSchema = z.number().gte(-90).lte(90);
const longitudeSchema = z.number().gte(-180).lte(180);

// Convenience: enforce from <= to and span <= cap.
const dateRangeRefine = <T extends { from_date?: string; to_date?: string }>(schema: z.ZodType<T>) =>
    schema.superRefine((data, ctx) => {
        if (!data.from_date || !data.to_date) return;
        const from = dayjs(data.from_date, 'YYYY-MM-DD', true);
        const to = dayjs(data.to_date, 'YYYY-MM-DD', true);
        if (!from.isValid() || !to.isValid()) return;
        if (from.isAfter(to)) {
            ctx.addIssue({
                code: 'custom',
                message: 'from_date must be on or before to_date',
                path: ['from_date'],
            });
            return;
        }
        if (to.diff(from, 'day') > ATTENDANCE_DATE_RANGE_MAX_DAYS) {
            ctx.addIssue({
                code: 'custom',
                message: `Range exceeds ${ATTENDANCE_DATE_RANGE_MAX_DAYS} days`,
                path: ['to_date'],
            });
        }
    });

// ─── POST /attendance/check-in ───────────────────────────────────────────

const manualCheckInBody = z.object({
    method: z.literal('manual'),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    wifi_ssid: z.string().min(1).max(64).optional(),
});

const qrCheckInBody = z.object({
    method: z.literal('qr'),
    qr_token: z.string().min(8).max(128),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    wifi_ssid: z.string().min(1).max(64).optional(),
});

export const checkInBodySchema = z.discriminatedUnion('method', [manualCheckInBody, qrCheckInBody]);
export type CheckInBody = z.infer<typeof checkInBodySchema>;

// ─── POST /attendance/check-out ──────────────────────────────────────────
// Same shape as check-in — geofence/wifi may be re-checked by the service.

export const checkOutBodySchema = checkInBodySchema;
export type CheckOutBody = z.infer<typeof checkOutBodySchema>;

// ─── POST /attendance/qr-verify ──────────────────────────────────────────

export const qrVerifyBodySchema = z.object({
    qr_token: z.string().min(8).max(128),
});
export type QrVerifyBody = z.infer<typeof qrVerifyBodySchema>;

// ─── GET /attendance/me ──────────────────────────────────────────────────

export const myAttendanceQuerySchema = dateRangeRefine(
    z.object({
        from_date: isoDateOnly.optional(),
        to_date: isoDateOnly.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(31),
    })
);
export type MyAttendanceQuery = z.infer<typeof myAttendanceQuerySchema>;

// ─── GET /attendance (manager / admin) ───────────────────────────────────

export const listAttendanceQuerySchema = dateRangeRefine(
    z.object({
        user_id: objectIdSchema.optional(),
        status: z.enum(ATTENDANCE_STATUSES).optional(),
        flagged_for_correction: z
            .union([z.literal('true'), z.literal('false'), z.boolean()])
            .transform((v) => (typeof v === 'boolean' ? v : v === 'true'))
            .optional(),
        from_date: isoDateOnly.optional(),
        to_date: isoDateOnly.optional(),
        page: z.coerce.number().int().min(1).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
    })
);
export type ListAttendanceQuery = z.infer<typeof listAttendanceQuerySchema>;

// ─── PATCH /attendance/:id (manager / admin direct correction) ───────────

export const patchAttendanceBodySchema = z
    .object({
        check_in: z
            .object({
                time: isoDateTime,
                method: z.enum(CHECK_METHODS).optional(),
                location_id: objectIdSchema.nullable().optional(),
            })
            .optional(),
        check_out: z
            .object({
                time: isoDateTime,
                method: z.enum(CHECK_METHODS).optional(),
                location_id: objectIdSchema.nullable().optional(),
            })
            .optional(),
        status: z.enum(ATTENDANCE_STATUSES).optional(),
        notes: z.string().max(ATTENDANCE_NOTES_MAX).optional(),
    })
    .refine((d) => Object.keys(d).length > 0, {
        message: 'At least one field must be supplied',
    });
export type PatchAttendanceBody = z.infer<typeof patchAttendanceBodySchema>;

// ─── POST /attendance/correction-requests ────────────────────────────────

// BUG-040 — multi-segment correction. `segments[]` is the canonical
// shape going forward; `check_in` / `check_out` are kept as legacy
// fallbacks for older clients that haven't been upgraded yet.
const requestedSegmentSchema = z.object({
    check_in: isoDateTime,
    check_out: isoDateTime.nullable().optional(),
});

export const submitCorrectionBodySchema = z
    .object({
        attendance_record_id: objectIdSchema,
        requested_changes: z.object({
            segments: z.array(requestedSegmentSchema).optional(),
            check_in: isoDateTime.nullable().optional(),
            check_out: isoDateTime.nullable().optional(),
            reason: z.string().trim().min(CORRECTION_REASON_MIN).max(CORRECTION_REASON_MAX),
        }),
    })
    .superRefine((d, ctx) => {
        const c = d.requested_changes;
        const hasSegments = Array.isArray(c.segments);
        const hasIn = c.check_in !== undefined && c.check_in !== null;
        const hasOut = c.check_out !== undefined && c.check_out !== null;

        if (hasSegments) {
            // Segments-mode: every entry must have a check_in; check_out
            // may be null only for the LAST entry (an open session).
            // Segments must be sorted and non-overlapping in time.
            if (c.segments!.length === 0) {
                // Empty array is a "delete-all" request. Allow it —
                // admins can approve to clear the day. But require a
                // reason that explains why.
                return;
            }
            const segs = c.segments!;
            for (let i = 0; i < segs.length; i += 1) {
                const seg = segs[i]!;
                if (seg.check_out !== null && seg.check_out !== undefined) {
                    if (seg.check_in >= seg.check_out) {
                        ctx.addIssue({
                            code: 'custom',
                            message: 'check_in must be earlier than check_out',
                            path: ['requested_changes', 'segments', i, 'check_in'],
                        });
                    }
                } else if (i !== segs.length - 1) {
                    // Only the latest segment may be open.
                    ctx.addIssue({
                        code: 'custom',
                        message: 'Only the final segment may have a null check_out',
                        path: ['requested_changes', 'segments', i, 'check_out'],
                    });
                }
                if (i > 0) {
                    const prev = segs[i - 1]!;
                    if (prev.check_out === null || prev.check_out === undefined) {
                        // can't happen given the gate above, but kept
                        // as a defensive check.
                        continue;
                    }
                    if (prev.check_out > seg.check_in) {
                        ctx.addIssue({
                            code: 'custom',
                            message: 'Segments must be in chronological order without overlap',
                            path: ['requested_changes', 'segments', i, 'check_in'],
                        });
                    }
                }
            }
            return;
        }

        // Legacy single-pair path.
        if (!hasIn && !hasOut) {
            ctx.addIssue({
                code: 'custom',
                message: 'Provide at least one of requested_changes.check_in or check_out',
                path: ['requested_changes'],
            });
            return;
        }
        if (hasIn && hasOut && c.check_in! >= c.check_out!) {
            ctx.addIssue({
                code: 'custom',
                message: 'check_in must be earlier than check_out',
                path: ['requested_changes', 'check_in'],
            });
        }
    });
export type SubmitCorrectionBody = z.infer<typeof submitCorrectionBodySchema>;

// ─── GET /attendance/correction-requests ─────────────────────────────────

export const listCorrectionsQuerySchema = z.object({
    user_id: objectIdSchema.optional(),
    status: z.enum(CORRECTION_REQUEST_STATUSES).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();
export type ListCorrectionsQuery = z.infer<typeof listCorrectionsQuerySchema>;

// ─── POST /attendance/correction-requests/:id/{approve,reject} ──────────

export const reviewCorrectionBodySchema = z
    .object({
        reviewer_remarks: z.string().trim().max(CORRECTION_REMARKS_MAX).optional(),
    })
    .partial();
export type ReviewCorrectionBody = z.infer<typeof reviewCorrectionBodySchema>;

// ─── Path params ─────────────────────────────────────────────────────────

export const attendanceIdParamSchema = z.object({ id: objectIdSchema });
export type AttendanceIdParam = z.infer<typeof attendanceIdParamSchema>;

export const correctionRequestIdParamSchema = z.object({ id: objectIdSchema });
export type CorrectionRequestIdParam = z.infer<typeof correctionRequestIdParamSchema>;
