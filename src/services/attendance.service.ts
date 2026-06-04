import { Types } from 'mongoose';

import {
    AttendanceRecord,
    type AttendanceRecordDocument,
    type AttendancePunch,
    type AttendanceSegment,
} from '../models/attendance-record.model.js';
import {
    AttendanceCorrectionRequest,
    type AttendanceCorrectionRequestDocument,
} from '../models/attendance-correction-request.model.js';
import { OfficeLocation } from '../models/office-location.model.js';
import { User } from '../models/user.model.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from '../utils/app-error.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { getOrInitSettings } from './settings.service.js';
import {
    notifyAttendanceCorrectionDecided,
    notifyAttendanceCorrectionSubmitted,
} from './notification-dispatcher.service.js';
import { haversineDistanceMeters, ATTENDANCE_REVIEW_ROLES } from '../constants/attendance.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    CheckInBody,
    CheckOutBody,
    ListAttendanceQuery,
    ListCorrectionsQuery,
    MyAttendanceQuery,
    PatchAttendanceBody,
    ReviewCorrectionBody,
    SubmitCorrectionBody,
} from '../validators/attendance.validator.js';

/**
 * Attendance service (API_Contract.md §6, Data_Model.md §4).
 *
 *  - `local_date` is computed in the system default timezone (`Asia/Kolkata`
 *    today). Per-user TZ overrides are a future v1.5 concern; hard-coding the
 *    system value keeps daily uniqueness aligned with the working day for
 *    every user in v1.
 *  - The `{user_id, local_date}` unique compound index is the actual source
 *    of truth for "one record per day". The service-level guard converts the
 *    E11000 into a friendly `ALREADY_CHECKED_IN` (409) and avoids creating
 *    a second row under race.
 *  - Geofence + WiFi gating reads `system_settings.attendance.*`. Both flags
 *    default to `false`, so the seam is inert until an admin enables them.
 *  - Comp-off ledger writes triggered by overtime are owned by the
 *    Leave Management module (Step 10 — shipped). Attendance computes
 *    `overtime_minutes` and the leave module reads it when posting
 *    `attendance_overtime` rows to `comp_off_ledger`.
 *
 * Authorization helpers:
 *  - `assertCanReviewCorrections` for approve/reject/list-all surface.
 *  - `applyCorrectionVisibility` collapses the visibility rule for
 *    `GET /correction-requests` (managers/admins see all; employees see only
 *    their own — auto-filtered by user_id in the same shape as `/users`).
 */

// ─── Helpers ──────────────────────────────────────────────────────────────

const todayLocalDate = (): string => dayjs().tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

const utcDateToLocalDate = (d: Date): string => dayjs(d).tz(DEFAULT_TIMEZONE).format(DATE_FORMAT);

interface ResolvedLocation {
    location_id: Types.ObjectId | null;
    location: { id: string; name: string; address: string } | null;
}

/** Resolve a QR token to an ACTIVE office_location, else 400 INVALID_QR_TOKEN. */
const resolveLocation = async (qr_token: string): Promise<ResolvedLocation> => {
    const loc = await OfficeLocation.findOne({ qr_code_token: qr_token, is_active: true });
    if (!loc) {
        throw AppError.badRequest('Invalid or inactive QR token', ERROR_CODES.INVALID_QR_TOKEN);
    }
    return {
        location_id: loc._id,
        location: { id: String(loc._id), name: loc.name, address: loc.address },
    };
};

/**
 * Validate the body against `system_settings.attendance.{geofence,wifi_restriction}`.
 * Both flags default to `false`; when off we return immediately. When on,
 * a missing/mismatched coordinate or IP/SSID raises `LOCATION_NOT_ALLOWED` (403).
 *
 * NOTE: ipv6 wifi_restriction.allowed_ip_ranges matching uses a *prefix* check
 * (e.g. "::1" allows "::1/128", "10.0.0.0/24" allows "10.0.0.X"). A full CIDR
 * matcher lands with Step 35 (Phase 4 — geofence + wifi enforcement). The
 * fields shipped here are the API surface; production tightening is tracked
 * in `Build_Decisions §Geofence`.
 */
const enforceLocationPolicies = async (body: CheckInBody | CheckOutBody, clientIp: string): Promise<void> => {
    const settings = await getOrInitSettings();
    const att = settings.attendance;

    if (att.geofence?.enabled) {
        if (
            typeof body.latitude !== 'number' ||
            typeof body.longitude !== 'number' ||
            att.geofence.center_latitude === null ||
            att.geofence.center_longitude === null
        ) {
            throw AppError.forbidden(
                'Check-in requires a valid coordinate for this site',
                ERROR_CODES.LOCATION_NOT_ALLOWED
            );
        }
        const dist = haversineDistanceMeters(
            body.latitude,
            body.longitude,
            att.geofence.center_latitude,
            att.geofence.center_longitude
        );
        if (dist > att.geofence.radius_meters) {
            throw AppError.forbidden(
                `Outside the configured ${att.geofence.radius_meters}m radius`,
                ERROR_CODES.LOCATION_NOT_ALLOWED
            );
        }
    }

    if (att.wifi_restriction?.enabled) {
        const ipPrefixes = att.wifi_restriction.allowed_ip_ranges
            .map((r) => r.split('/')[0])
            .filter((p): p is string => Boolean(p));
        const ipMatch = ipPrefixes.some((p) => clientIp.startsWith(p));

        const ssidMatch = body.wifi_ssid && att.wifi_restriction.allowed_ssids.includes(body.wifi_ssid);

        if (!ipMatch && !ssidMatch) {
            throw AppError.forbidden('Network not on the allow-list for this site', ERROR_CODES.LOCATION_NOT_ALLOWED);
        }
    }
};

/**
 * BUG-040 — sum worked minutes across every CLOSED segment. Open
 * segments (a current in-progress session) don't contribute until
 * they're closed; the FE shows the live elapsed time separately.
 * Overtime is everything beyond the configured `daily_expected_hours`.
 */
const segmentMinutes = (s: AttendanceSegment): number => {
    if (!s.check_out) return 0;
    return Math.max(0, Math.round((s.check_out.time.getTime() - s.check_in.time.getTime()) / 60_000));
};

const computeWorkedAcrossSegments = async (
    segments: AttendanceSegment[]
): Promise<{ total_worked_minutes: number; overtime_minutes: number }> => {
    const settings = await getOrInitSettings();
    const expectedMinutes = (settings.work_schedule.daily_expected_hours ?? 8) * 60;
    const total = segments.reduce((acc, s) => acc + segmentMinutes(s), 0);
    const overtime = Math.max(0, total - expectedMinutes);
    return { total_worked_minutes: total, overtime_minutes: overtime };
};

/**
 * BUG-040 — keep the top-level `check_in` / `check_out` aliases in
 * lock-step with the segments[] source of truth, so every legacy
 * reader (reports, exports, FE banner, admin patch flow) keeps
 * working unchanged.
 *
 *   check_in  = segments[0].check_in           (first arrival)
 *   check_out = segments[last].check_out       (null while open)
 */
const syncAliasesFromSegments = (record: AttendanceRecordDocument): void => {
    const segs = record.segments ?? [];
    if (segs.length === 0) {
        record.check_in = null;
        record.check_out = null;
        return;
    }
    record.check_in = segs[0]!.check_in;
    record.check_out = segs[segs.length - 1]!.check_out;
};

const assertCanReviewCorrections = (caller_role: RoleType) => {
    if (!ATTENDANCE_REVIEW_ROLES.includes(caller_role)) {
        throw AppError.forbidden();
    }
};

// ─── POST /attendance/check-in ───────────────────────────────────────────

export const checkIn = async (
    body: CheckInBody,
    user_id: Types.ObjectId,
    clientIp: string
): Promise<Record<string, unknown>> => {
    await enforceLocationPolicies(body, clientIp);

    let location_id: Types.ObjectId | null = null;
    if (body.method === 'qr') {
        const resolved = await resolveLocation(body.qr_token);
        location_id = resolved.location_id;
    }

    const local_date = todayLocalDate();
    const now = new Date();

    const punch: AttendancePunch = {
        time: now,
        method: body.method,
        location_id,
        ip: clientIp,
    };

    // BUG-040 — three valid entry points to a check-in:
    //   (a) brand-new day for this user                 → create row with one segment
    //   (b) row exists but no segments yet (EOD placeholder) → seed first segment
    //   (c) row exists and the LATEST segment is closed → append a new segment
    //                                                     (re-check-in after lunch / errand)
    // The only refusal is "latest segment still open" → ALREADY_CHECKED_IN.
    try {
        const created = await AttendanceRecord.create({
            user_id,
            local_date,
            segments: [{ check_in: punch, check_out: null }],
            check_in: punch,
            check_out: null,
            status: 'present',
            flagged_for_correction: false,
            wfh: false,
            overtime_minutes: 0,
        });
        return created.toJSON() as unknown as Record<string, unknown>;
    } catch (err: unknown) {
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            const existing = await AttendanceRecord.findOne({ user_id, local_date });
            if (existing) {
                const segs = existing.segments ?? [];
                const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
                if (lastSeg && !lastSeg.check_out) {
                    throw AppError.conflict(
                        'Already checked in for today',
                        ERROR_CODES.ALREADY_CHECKED_IN
                    );
                }
                if (segs.length === 0) {
                    // EOD placeholder row — seed the first segment.
                    existing.segments = [{ check_in: punch, check_out: null }];
                } else {
                    // All previous segments are closed — append a fresh one.
                    existing.segments.push({ check_in: punch, check_out: null });
                }
                existing.status = 'present';
                existing.flagged_for_correction = false;
                syncAliasesFromSegments(existing);
                await existing.save();
                return existing.toJSON() as unknown as Record<string, unknown>;
            }
        }
        throw err;
    }
};

// ─── POST /attendance/check-out ──────────────────────────────────────────

export const checkOut = async (
    body: CheckOutBody,
    user_id: Types.ObjectId,
    clientIp: string
): Promise<Record<string, unknown>> => {
    await enforceLocationPolicies(body, clientIp);

    let location_id: Types.ObjectId | null = null;
    if (body.method === 'qr') {
        const resolved = await resolveLocation(body.qr_token);
        location_id = resolved.location_id;
    }

    const local_date = todayLocalDate();
    const record = await AttendanceRecord.findOne({ user_id, local_date });

    // BUG-040 — operate on the LATEST segment. If there's no open segment,
    // the user hasn't checked in (NOT_CHECKED_IN). If all segments are
    // already closed, treat the same — they need a fresh check-in first.
    const segs = record?.segments ?? [];
    const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
    if (!record || !lastSeg) {
        throw AppError.conflict('Not checked in for today', ERROR_CODES.NOT_CHECKED_IN);
    }
    if (lastSeg.check_out) {
        // Every segment already closed — user must check in again before
        // they can check out. NOT_CHECKED_IN is the precise signal (the
        // legacy ALREADY_CHECKED_OUT code is preserved in the constants
        // for older clients but is no longer thrown by this service).
        throw AppError.conflict('Not checked in for today', ERROR_CODES.NOT_CHECKED_IN);
    }

    const now = new Date();
    lastSeg.check_out = {
        time: now,
        method: body.method,
        location_id,
        ip: clientIp,
    };

    const computed = await computeWorkedAcrossSegments(record.segments);
    record.total_worked_minutes = computed.total_worked_minutes;
    record.overtime_minutes = computed.overtime_minutes;
    syncAliasesFromSegments(record);
    // Mongoose doesn't always notice in-place mutations of nested subdocs
    // (lastSeg.check_out = …). Explicitly mark the path dirty so the save
    // persists the new check_out.
    record.markModified('segments');

    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── GET /attendance/me/today ────────────────────────────────────────────

export const getMyToday = async (user_id: Types.ObjectId): Promise<Record<string, unknown> | null> => {
    const local_date = todayLocalDate();
    const rec = await AttendanceRecord.findOne({ user_id, local_date });
    return rec ? (rec.toJSON() as unknown as Record<string, unknown>) : null;
};

// ─── GET /attendance/me ──────────────────────────────────────────────────

export const listMyAttendance = async (
    user_id: Types.ObjectId,
    query: MyAttendanceQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = { user_id };
    if (query.from_date || query.to_date) {
        const range: Record<string, string> = {};
        if (query.from_date) range.$gte = query.from_date;
        if (query.to_date) range.$lte = query.to_date;
        filter.local_date = range;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        AttendanceRecord.find(filter).sort({ local_date: -1 }).skip(skip).limit(query.limit),
        AttendanceRecord.countDocuments(filter),
    ]);

    return {
        data: rows.map((r) => r.toJSON() as unknown as Record<string, unknown>),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /attendance (manager / admin) ───────────────────────────────────

/**
 * Per-page user-display hydration — mirrors the audit-log
 * `loadActorDisplays` pattern so the FE doesn't have to N+1 against
 * `/users/:id` to render names on the team-attendance table.
 *
 * `full_name` is nullable to cover the rare "user has been hard-deleted
 * since the attendance row was written" case; we preserve the id for
 * traceability and let the FE render a placeholder.
 */
interface UserDisplay {
    id: string;
    full_name: string | null;
}

const loadUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, UserDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), full_name: r.full_name }]));
};

export const listAttendance = async (
    query: ListAttendanceQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    if (query.status) filter.status = query.status;
    if (query.flagged_for_correction !== undefined) {
        filter.flagged_for_correction = query.flagged_for_correction;
    }
    if (query.from_date || query.to_date) {
        const range: Record<string, string> = {};
        if (query.from_date) range.$gte = query.from_date;
        if (query.to_date) range.$lte = query.to_date;
        filter.local_date = range;
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        AttendanceRecord.find(filter).sort({ local_date: -1, _id: -1 }).skip(skip).limit(query.limit),
        AttendanceRecord.countDocuments(filter),
    ]);

    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const userMap = await loadUserDisplays(userIds);

    return {
        data: rows.map((r) => {
            const obj = r.toJSON() as unknown as Record<string, unknown>;
            obj.user = userMap.get(r.user_id.toString()) ?? {
                id: r.user_id.toString(),
                full_name: null,
            };
            return obj;
        }),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── PATCH /attendance/:id (direct correction) ──────────────────────────

export const patchAttendance = async (
    id: Types.ObjectId,
    patch: PatchAttendanceBody,
    actor_id: Types.ObjectId,
    actor_role: RoleType
): Promise<Record<string, unknown>> => {
    if (!ATTENDANCE_REVIEW_ROLES.includes(actor_role)) {
        throw AppError.forbidden();
    }

    const record = await AttendanceRecord.findById(id);
    if (!record) {
        throw AppError.notFound('Attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }

    // BUG-040 — segments[] is the source of truth. When an admin patches
    // check_in / check_out at the top level, we route the change into
    // segments[0].check_in and segments[last].check_out so the canonical
    // shape stays consistent. If there's no segment yet (EOD placeholder
    // being filled in by an admin), seed one.
    if (patch.check_in?.time) {
        const newIn: AttendancePunch = {
            time: new Date(patch.check_in.time),
            method: patch.check_in.method ?? record.check_in?.method ?? 'manual',
            location_id: patch.check_in.location_id
                ? new Types.ObjectId(patch.check_in.location_id)
                : (record.check_in?.location_id ?? null),
            ip: record.check_in?.ip ?? '',
        };
        if (record.segments && record.segments.length > 0) {
            record.segments[0]!.check_in = newIn;
            record.markModified('segments');
        } else {
            record.segments = [{ check_in: newIn, check_out: null }];
        }
    }
    if (patch.check_out?.time) {
        const newOut: AttendancePunch = {
            time: new Date(patch.check_out.time),
            method: patch.check_out.method ?? record.check_out?.method ?? 'manual',
            location_id: patch.check_out.location_id
                ? new Types.ObjectId(patch.check_out.location_id)
                : (record.check_out?.location_id ?? null),
            ip: record.check_out?.ip ?? '',
        };
        const segs = record.segments ?? [];
        if (segs.length > 0) {
            segs[segs.length - 1]!.check_out = newOut;
            record.markModified('segments');
        }
        // If there's no segment at all, patching only check_out is an
        // invalid state; leave it to validation upstream (the historical
        // PATCH path required check_in to exist first).
    }
    if (patch.status) record.status = patch.status;
    if (patch.notes !== undefined) record.notes = patch.notes;

    syncAliasesFromSegments(record);

    if (record.check_in && record.check_out) {
        const computed = await computeWorkedAcrossSegments(record.segments ?? []);
        record.total_worked_minutes = computed.total_worked_minutes;
        record.overtime_minutes = computed.overtime_minutes;
        record.flagged_for_correction = false;
    }

    record.last_corrected_by = actor_id;
    record.last_corrected_at = new Date();
    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── POST /attendance/qr-verify ──────────────────────────────────────────

export const verifyQr = async (qr_token: string): Promise<Record<string, unknown>> => {
    const { location } = await resolveLocation(qr_token);
    return { location };
};

// ─── POST /attendance/correction-requests ────────────────────────────────

export const submitCorrection = async (
    body: SubmitCorrectionBody,
    user_id: Types.ObjectId
): Promise<Record<string, unknown>> => {
    const record = await AttendanceRecord.findById(body.attendance_record_id);
    if (!record) {
        throw AppError.notFound('Attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }
    if (!record.user_id.equals(user_id)) {
        // Hide existence from the cross-user case so nobody can probe other
        // people's records by ID. 404 with the same code as "missing".
        throw AppError.notFound('Attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }

    const existingPending = await AttendanceCorrectionRequest.findOne({
        attendance_record_id: record._id,
        status: 'pending',
    });
    if (existingPending) {
        throw AppError.conflict(
            'A pending correction request already exists for this record',
            ERROR_CODES.CORRECTION_REQUEST_ALREADY_PENDING
        );
    }

    // BUG-040 — preserve `segments` when the client sends it. Legacy
    // single-pair clients still get their fields persisted as-is so
    // the approve path can keep handling old pending requests.
    const requestedSegments = body.requested_changes.segments;
    const created = await AttendanceCorrectionRequest.create({
        user_id,
        attendance_record_id: record._id,
        requested_changes: {
            segments: requestedSegments
                ? requestedSegments.map((s) => ({
                      check_in: new Date(s.check_in),
                      check_out: s.check_out ? new Date(s.check_out) : null,
                  }))
                : undefined,
            check_in: body.requested_changes.check_in
                ? new Date(body.requested_changes.check_in)
                : null,
            check_out: body.requested_changes.check_out
                ? new Date(body.requested_changes.check_out)
                : null,
            reason: body.requested_changes.reason,
        },
    });

    await notifyAttendanceCorrectionSubmitted({
        request_id: created._id,
        requester_id: user_id,
        local_date: record.local_date,
    });

    return created.toJSON() as unknown as Record<string, unknown>;
};

// ─── GET /attendance/correction-requests ─────────────────────────────────

/**
 * Visibility:
 *  - Managers / admins see everything (subject to optional `user_id`/`status`
 *    filters).
 *  - Employees see only their own correction requests (auto-filtered by
 *    `user_id`, ignoring any value in the query).
 */
export const listCorrections = async (
    query: ListCorrectionsQuery,
    caller_id: Types.ObjectId,
    caller_role: RoleType
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Record<string, unknown> = {};
    if (caller_role === ROLES.EMPLOYEE) {
        filter.user_id = caller_id;
    } else if (query.user_id) {
        filter.user_id = new Types.ObjectId(query.user_id);
    }
    if (query.status) filter.status = query.status;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        AttendanceCorrectionRequest.find(filter).sort({ created_at: -1 }).skip(skip).limit(query.limit),
        AttendanceCorrectionRequest.countDocuments(filter),
    ]);

    // Batch-load the requester's display name in one round-trip so the
    // admin correction queue can render names without N+1 lookups. We
    // emit `user_full_name` as a flat field on each row (matching the
    // FE's `CorrectionRequestRecord` shape). `null` means the user has
    // actually been hard-deleted — the FE renders "deleted user" only
    // in that case. Without this join, every row arrived without a
    // name and the FE assumed everyone was deleted.
    const uniqueUserIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map(
        (id) => new Types.ObjectId(id)
    );
    const userRows = uniqueUserIds.length
        ? await User.find({ _id: { $in: uniqueUserIds } })
              .select('_id full_name')
              .lean<{ _id: Types.ObjectId; full_name: string }[]>()
        : [];
    const nameById = new Map(userRows.map((u) => [u._id.toString(), u.full_name]));

    const data = rows.map((r) => {
        const json = r.toJSON() as unknown as Record<string, unknown>;
        json.user_full_name = nameById.get(r.user_id.toString()) ?? null;
        return json;
    });

    return {
        data,
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── Internal: load + assert request is pending ──────────────────────────

const loadPendingCorrection = async (id: Types.ObjectId): Promise<AttendanceCorrectionRequestDocument> => {
    const req = await AttendanceCorrectionRequest.findById(id);
    if (!req) {
        throw AppError.notFound('Correction request not found', ERROR_CODES.CORRECTION_REQUEST_NOT_FOUND);
    }
    if (req.status !== 'pending') {
        throw AppError.conflict(
            `Correction request is already ${req.status}`,
            ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING
        );
    }
    return req;
};

// ─── POST /attendance/correction-requests/:id/approve ───────────────────

export const approveCorrection = async (
    id: Types.ObjectId,
    body: ReviewCorrectionBody,
    reviewer_id: Types.ObjectId,
    reviewer_role: RoleType
): Promise<Record<string, unknown>> => {
    assertCanReviewCorrections(reviewer_role);

    const reqDoc = await loadPendingCorrection(id);
    const record = await AttendanceRecord.findById(reqDoc.attendance_record_id);
    if (!record) {
        throw AppError.notFound('Underlying attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }

    const changes = reqDoc.requested_changes;

    // BUG-040 — multi-segment proposal path. When the request carries
    // `segments[]` it replaces the record's segments wholesale (the
    // employee submitted a fully-specified day). Existing punch
    // metadata (method, location_id, ip) is preserved per index where
    // possible so geofence/QR audit trails don't get clobbered by a
    // manual time correction.
    const proposedSegments = changes.segments;
    if (proposedSegments && proposedSegments.length >= 0) {
        const oldSegments = record.segments ?? [];
        record.segments = proposedSegments.map((p, i) => {
            const old = oldSegments[i];
            const inMeta = old?.check_in;
            const outMeta = old?.check_out;
            return {
                check_in: {
                    time: p.check_in,
                    method: inMeta?.method ?? 'manual',
                    location_id: inMeta?.location_id ?? null,
                    ip: inMeta?.ip ?? '',
                },
                check_out: p.check_out
                    ? {
                          time: p.check_out,
                          method: outMeta?.method ?? 'manual',
                          location_id: outMeta?.location_id ?? null,
                          ip: outMeta?.ip ?? '',
                      }
                    : null,
            };
        });
        record.markModified('segments');
        // local_date follows the first segment's check_in so the row
        // continues to live on the right business day after a shift.
        if (record.segments.length > 0) {
            record.local_date = utcDateToLocalDate(record.segments[0]!.check_in.time);
        }
    } else {
        // Legacy single-pair correction.
        if (changes.check_in) {
            const newIn: AttendancePunch = {
                time: changes.check_in,
                method: record.check_in?.method ?? 'manual',
                location_id: record.check_in?.location_id ?? null,
                ip: record.check_in?.ip ?? '',
            };
            if (record.segments && record.segments.length > 0) {
                record.segments[0]!.check_in = newIn;
                record.markModified('segments');
            } else {
                record.segments = [{ check_in: newIn, check_out: null }];
            }
            record.local_date = utcDateToLocalDate(changes.check_in);
        }
        if (changes.check_out) {
            const newOut: AttendancePunch = {
                time: changes.check_out,
                method: record.check_out?.method ?? 'manual',
                location_id: record.check_out?.location_id ?? null,
                ip: record.check_out?.ip ?? '',
            };
            const segs = record.segments ?? [];
            if (segs.length > 0) {
                segs[segs.length - 1]!.check_out = newOut;
                record.markModified('segments');
            }
        }
    }

    syncAliasesFromSegments(record);
    if (record.check_in && record.check_out) {
        const computed = await computeWorkedAcrossSegments(record.segments ?? []);
        record.total_worked_minutes = computed.total_worked_minutes;
        record.overtime_minutes = computed.overtime_minutes;
        if (record.status === 'incomplete') record.status = 'present';
        record.flagged_for_correction = false;
    }
    record.last_corrected_by = reviewer_id;
    record.last_corrected_at = new Date();
    await record.save();

    reqDoc.status = 'approved';
    reqDoc.reviewer_id = reviewer_id;
    reqDoc.reviewer_remarks = body.reviewer_remarks ?? '';
    reqDoc.acted_at = new Date();
    await reqDoc.save();

    await notifyAttendanceCorrectionDecided({
        request_id: reqDoc._id,
        requester_id: reqDoc.user_id,
        local_date: record.local_date,
        decision: 'approved',
        actor: { id: reviewer_id },
        remarks: body.reviewer_remarks ?? null,
    });

    return {
        request: reqDoc.toJSON(),
        record: record.toJSON(),
    };
};

// ─── POST /attendance/correction-requests/:id/reject ────────────────────

export const rejectCorrection = async (
    id: Types.ObjectId,
    body: ReviewCorrectionBody,
    reviewer_id: Types.ObjectId,
    reviewer_role: RoleType
): Promise<Record<string, unknown>> => {
    assertCanReviewCorrections(reviewer_role);

    const reqDoc = await loadPendingCorrection(id);
    reqDoc.status = 'rejected';
    reqDoc.reviewer_id = reviewer_id;
    reqDoc.reviewer_remarks = body.reviewer_remarks ?? '';
    reqDoc.acted_at = new Date();
    await reqDoc.save();

    // Look up the underlying record only for `local_date` — the rest of the
    // notification payload is already on `reqDoc`. If the record vanished
    // (extremely unlikely; correction targets are immutable) fall back to a
    // placeholder string so the dispatcher never throws.
    const record = await AttendanceRecord.findById(reqDoc.attendance_record_id).select('local_date');
    await notifyAttendanceCorrectionDecided({
        request_id: reqDoc._id,
        requester_id: reqDoc.user_id,
        local_date: record?.local_date ?? 'unknown',
        decision: 'rejected',
        actor: { id: reviewer_id },
        remarks: body.reviewer_remarks ?? null,
    });

    return reqDoc.toJSON() as unknown as Record<string, unknown>;
};

// ─── BUG-040 — one-time backfill of segments[] ──────────────────────────

/**
 * Walk every AttendanceRecord that has a top-level `check_in` but an
 * empty `segments[]` array, and seed `segments: [{ check_in, check_out }]`
 * from the legacy embed. Records that already have segments (post-fix
 * writes) are left untouched, making this idempotent.
 *
 * Called once on server boot from `index.ts`, alongside the existing
 * role-bootstrap migration. Logs the backfilled count so the operator
 * can see it run; never blocks boot on failure.
 */
export const migrateAttendanceSegments = async (): Promise<{ backfilled: number }> => {
    // Match docs that have a check_in punch but no segments yet. Mongo
    // matches missing or zero-length arrays via `$size: 0` + `$exists`
    // — the OR covers pre-segments documents and documents where the
    // field defaulted to []. We only need a basic projection to update.
    const cursor = AttendanceRecord.find({
        check_in: { $ne: null },
        $or: [{ segments: { $exists: false } }, { segments: { $size: 0 } }],
    }).cursor();

    let backfilled = 0;
    for await (const record of cursor) {
        if (!record.check_in) continue;
        record.segments = [
            { check_in: record.check_in, check_out: record.check_out ?? null },
        ];
        await record.save();
        backfilled += 1;
    }
    return { backfilled };
};

// Re-exports for the helper callers (test fixtures, future cron).
export { todayLocalDate };

/** Type-only re-export so the controller can pin a return shape. */
export type AttendanceRecordSnapshot = AttendanceRecordDocument['toJSON'] extends () => infer R
    ? R
    : Record<string, unknown>;
