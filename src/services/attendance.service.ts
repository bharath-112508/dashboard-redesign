import { Types } from 'mongoose';

import {
    AttendanceRecord,
    type AttendanceRecordDocument,
    type AttendancePunch,
    type AttendanceSegment,
    type BreakSession,
} from '../models/attendance-record.model.js';
import {
    AttendanceCorrectionRequest,
    type AttendanceCorrectionRequestDocument,
} from '../models/attendance-correction-request.model.js';
import { OfficeLocation } from '../models/office-location.model.js';
import { TimesheetEntry } from '../models/timesheet-entry.model.js';
import { User } from '../models/user.model.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from '../utils/app-error.js';
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from '../utils/date.js';
import { getOrInitSettings } from './settings.service.js';
import {
    notifyAttendanceCorrectionDecided,
    notifyAttendanceCorrectionSubmitted,
} from './notification-dispatcher.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import {
    haversineDistanceMeters,
    ATTENDANCE_REVIEW_ROLES,
    BREAK_TYPES,
    type BreakType,
    type BreakSource,
} from '../constants/attendance.js';
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

const breakMinutes = (b: BreakSession): number => {
    if (!b.end) return 0; // open break — not counted yet
    return Math.max(0, Math.round((b.end.time.getTime() - b.start.time.getTime()) / 60_000));
};

/** Closed-break minutes inside one segment. */
export const segmentBreakMinutes = (s: AttendanceSegment): number =>
    (s.breaks ?? []).reduce((acc, b) => acc + breakMinutes(b), 0);

/** Total + per-type closed-break minutes across all segments. */
export const breakTotalsAcrossSegments = (
    segments: AttendanceSegment[]
): { total_break_minutes: number; break_minutes_by_type: Record<BreakType, number> } => {
    const by_type: Record<BreakType, number> = { lunch: 0, tea: 0, other: 0 };
    for (const s of segments ?? []) {
        for (const b of s.breaks ?? []) {
            if (!b.end) continue;
            by_type[b.break_type] += breakMinutes(b);
        }
    }
    const total = BREAK_TYPES.reduce((acc, k) => acc + by_type[k], 0);
    return { total_break_minutes: total, break_minutes_by_type: by_type };
};

export const computeWorkedAcrossSegments = async (
    segments: AttendanceSegment[]
): Promise<{
    total_worked_minutes: number;
    overtime_minutes: number;
    total_break_minutes: number;
    break_minutes_by_type: Record<BreakType, number>;
}> => {
    const settings = await getOrInitSettings();
    const expectedMinutes = (settings.work_schedule.daily_expected_hours ?? 8) * 60;
    // Net worked per closed segment = gross - its closed breaks (never < 0).
    const total = (segments ?? []).reduce((acc, s) => acc + Math.max(0, segmentMinutes(s) - segmentBreakMinutes(s)), 0);
    const overtime = Math.max(0, total - expectedMinutes);
    const breaks = breakTotalsAcrossSegments(segments);
    return { total_worked_minutes: total, overtime_minutes: overtime, ...breaks };
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
            segments: [{ check_in: punch, check_out: null, breaks: [] }],
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
                    throw AppError.conflict('Already checked in for today', ERROR_CODES.ALREADY_CHECKED_IN);
                }
                if (segs.length === 0) {
                    // EOD placeholder row — seed the first segment.
                    existing.segments = [{ check_in: punch, check_out: null, breaks: [] }];
                } else {
                    // All previous segments are closed — append a fresh one.
                    existing.segments.push({ check_in: punch, check_out: null, breaks: [] });
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
    // Auto-end any open break at the check-out instant so the math is right.
    const openB = (lastSeg.breaks ?? []).find((b) => !b.end);
    if (openB) openB.end = { time: now, source: 'app' };
    lastSeg.check_out = {
        time: now,
        method: body.method,
        location_id,
        ip: clientIp,
    };

    const computed = await computeWorkedAcrossSegments(record.segments);
    record.total_worked_minutes = computed.total_worked_minutes;
    record.overtime_minutes = computed.overtime_minutes;
    record.total_break_minutes = computed.total_break_minutes;
    record.break_minutes_by_type = computed.break_minutes_by_type;
    syncAliasesFromSegments(record);
    // Mongoose doesn't always notice in-place mutations of nested subdocs
    // (lastSeg.check_out = …). Explicitly mark the path dirty so the save
    // persists the new check_out.
    record.markModified('segments');

    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── Shared helper: recompute totals onto a record doc ───────────────────

const persistTotals = async (record: AttendanceRecordDocument): Promise<void> => {
    const computed = await computeWorkedAcrossSegments(record.segments);
    record.total_worked_minutes = computed.total_worked_minutes;
    record.overtime_minutes = computed.overtime_minutes;
    record.total_break_minutes = computed.total_break_minutes;
    record.break_minutes_by_type = computed.break_minutes_by_type;
};

// ─── POST /attendance/break/start ────────────────────────────────────────

export const startBreak = async (
    user_id: Types.ObjectId,
    break_type: BreakType,
    source: BreakSource
): Promise<Record<string, unknown>> => {
    const local_date = todayLocalDate();
    const record = await AttendanceRecord.findOne({ user_id, local_date });
    const segs = record?.segments ?? [];
    const lastSeg = segs.length > 0 ? segs[segs.length - 1] : null;
    if (!record || !lastSeg || lastSeg.check_out) {
        throw AppError.conflict('Not checked in for today', ERROR_CODES.NOT_CHECKED_IN);
    }
    const breaks = lastSeg.breaks ?? [];
    if (breaks.some((b) => !b.end)) {
        throw AppError.conflict('Already on a break', ERROR_CODES.ALREADY_ON_BREAK);
    }
    lastSeg.breaks = [...breaks, { break_type, start: { time: new Date(), source }, end: null }];
    record.markModified('segments');
    await persistTotals(record); // open break → totals unchanged, but keeps fields fresh
    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── POST /attendance/break/end ──────────────────────────────────────────

export const endBreak = async (user_id: Types.ObjectId, source: BreakSource): Promise<Record<string, unknown>> => {
    const local_date = todayLocalDate();
    const record = await AttendanceRecord.findOne({ user_id, local_date });
    const segs = record?.segments ?? [];
    // Find the latest open break across segments (scan from the end).
    let openBreak: { end: { time: Date; source: BreakSource } | null } | null = null;
    for (let i = segs.length - 1; i >= 0 && !openBreak; i -= 1) {
        const bs = segs[i]!.breaks ?? [];
        for (let j = bs.length - 1; j >= 0; j -= 1) {
            if (!bs[j]!.end) {
                openBreak = bs[j]!;
                break;
            }
        }
    }
    if (!record || !openBreak) {
        throw AppError.conflict('Not on a break', ERROR_CODES.NOT_ON_BREAK);
    }
    openBreak.end = { time: new Date(), source };
    record.markModified('segments');
    await persistTotals(record);
    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── PUT /attendance/me/breaks ───────────────────────────────────────────
//
// Replace today's break list on the caller's OWN record with manual times.
// Adding/removing a break only changes the caller's own day and (by excluding
// break time) never inflates worked minutes, so it applies immediately — no
// manager correction. Each break is attached to the segment whose window
// contains its start (single check-in/out → the one segment).

export const setMyBreaks = async (
    user_id: Types.ObjectId,
    breaks: { break_type: BreakType; start: string; end: string | null }[]
): Promise<Record<string, unknown>> => {
    const local_date = todayLocalDate();
    const record = await AttendanceRecord.findOne({ user_id, local_date });
    const segs = record?.segments ?? [];
    if (!record || segs.length === 0) {
        throw AppError.conflict('Check in before adding a break', ERROR_CODES.NOT_CHECKED_IN);
    }
    const now = Date.now();
    for (const s of segs) s.breaks = [];
    for (const b of breaks) {
        if (b.end && new Date(b.start).getTime() >= new Date(b.end).getTime()) {
            throw AppError.badRequest('A break must end after it starts');
        }
        const startMs = new Date(b.start).getTime();
        let idx = segs.findIndex((s) => {
            const inMs = s.check_in.time.getTime();
            const outMs = s.check_out ? s.check_out.time.getTime() : now;
            return startMs >= inMs && startMs <= outMs;
        });
        if (idx < 0) idx = segs.length - 1;
        segs[idx]!.breaks.push({
            break_type: b.break_type,
            start: { time: new Date(b.start), source: 'app' },
            end: b.end ? { time: new Date(b.end), source: 'app' } : null,
        });
    }
    record.markModified('segments');
    await persistTotals(record);
    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── POST /attendance/me/times ───────────────────────────────────────────
//
// Edit the caller's OWN check-in / check-out times for today, applied
// immediately (no manager correction). This is the Today-page self-service
// edit; the approval-gated correction flow on the Attendance page is for
// past days / when an approver should sign off. Sets the first segment's
// check-in and/or the last segment's check-out, then recomputes totals.

export const setMyTimes = async (
    user_id: Types.ObjectId,
    times: { check_in?: string; check_out?: string | null }
): Promise<Record<string, unknown>> => {
    const local_date = todayLocalDate();
    const record = await AttendanceRecord.findOne({ user_id, local_date });
    const segs = record?.segments ?? [];
    if (!record || segs.length === 0) {
        throw AppError.conflict('Check in before editing your times', ERROR_CODES.NOT_CHECKED_IN);
    }
    // Edit the CURRENT (latest) segment — its check-in and check-out. After a
    // resume that's the active session, so a check-in edit changes the session
    // the user is in, not the day's first arrival.
    const last = segs[segs.length - 1]!;

    // A punch can't be in the future. Allow a small grace so client/server
    // clock skew doesn't reject an edit set to "now".
    const futureLimit = Date.now() + 2 * 60 * 1000;
    if (times.check_in !== undefined && new Date(times.check_in).getTime() > futureLimit) {
        throw AppError.badRequest('Check-in cannot be in the future');
    }
    if (times.check_out && new Date(times.check_out).getTime() > futureLimit) {
        throw AppError.badRequest('Check-out cannot be in the future');
    }

    if (times.check_in !== undefined) {
        last.check_in.time = new Date(times.check_in);
    }
    if (times.check_out !== undefined) {
        if (times.check_out === null) {
            last.check_out = null;
        } else if (last.check_out) {
            last.check_out.time = new Date(times.check_out);
        } else {
            last.check_out = { time: new Date(times.check_out), method: 'manual', location_id: null, ip: '' };
        }
    }

    // Each segment must read in < out, and a still-open break can't precede
    // a check-out we just moved before it.
    for (const s of segs) {
        if (s.check_out && s.check_in.time.getTime() >= s.check_out.time.getTime()) {
            throw AppError.badRequest('Check-in must be earlier than check-out');
        }
    }

    // Closing the day promotes an incomplete record to present; reopening it
    // (clearing the check-out) drops it back to incomplete.
    if (last.check_out) {
        if (record.status === 'incomplete') record.status = 'present';
    } else {
        record.status = 'incomplete';
    }

    syncAliasesFromSegments(record);
    record.markModified('segments');
    await persistTotals(record);
    await record.save();
    return record.toJSON() as unknown as Record<string, unknown>;
};

// ─── Timesheet split join (billable / non-billable / idle per day) ────────

/**
 * Attaches a `timesheet_totals` aggregate to each attendance row's JSON,
 * summed from that user's `timesheet_entries` for the same `local_date`.
 * Attendance carries no billable data of its own — the split lives only on
 * timesheets, keyed independently by (user_id, local_date). `null` = the day
 * had no timesheet entries. Mutates `rows` in place.
 */
const attachTimesheetTotals = async (user_id: Types.ObjectId, rows: Record<string, unknown>[]): Promise<void> => {
    const dates = rows.map((r) => r.local_date).filter((d): d is string => typeof d === 'string');
    if (dates.length === 0) return;

    const agg = await TimesheetEntry.aggregate<{
        _id: string;
        billable: number;
        non_billable: number;
        idle: number;
    }>([
        { $match: { user_id, local_date: { $in: dates } } },
        {
            $group: {
                _id: '$local_date',
                billable: { $sum: '$billable_total_minutes' },
                non_billable: { $sum: '$non_billable_total_minutes' },
                idle: { $sum: '$idle_total_minutes' },
            },
        },
    ]);

    const byDate = new Map(agg.map((a) => [a._id, a]));
    for (const row of rows) {
        const t = typeof row.local_date === 'string' ? byDate.get(row.local_date) : undefined;
        row.timesheet_totals = t
            ? {
                  billable_minutes: t.billable,
                  non_billable_minutes: t.non_billable,
                  idle_minutes: t.idle,
              }
            : null;
    }
};

// ─── GET /attendance/me/today ────────────────────────────────────────────

export const getMyToday = async (user_id: Types.ObjectId): Promise<Record<string, unknown> | null> => {
    const local_date = todayLocalDate();
    const rec = await AttendanceRecord.findOne({ user_id, local_date });
    if (!rec) return null;
    const json = rec.toJSON() as unknown as Record<string, unknown>;
    await attachTimesheetTotals(user_id, [json]);
    return json;
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

    const data = rows.map((r) => r.toJSON() as unknown as Record<string, unknown>);
    await attachTimesheetTotals(user_id, data);

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

/**
 * Roster view for a single day (`include_absent=true`, `from_date === to_date`):
 * real attendance rows + a synthetic `absent` row for every active non-client
 * employee with no record that day. Filtering + pagination run in memory — a
 * single day is at most ~headcount rows.
 */
const listAttendanceRoster = async (
    query: ListAttendanceQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const date = query.from_date as string;
    const userFilter = query.user_id ? new Types.ObjectId(query.user_id) : null;

    const recordFilter: Record<string, unknown> = { local_date: date };
    if (userFilter) recordFilter.user_id = userFilter;

    const [records, employees, totalInternalActive] = await Promise.all([
        AttendanceRecord.find(recordFilter).sort({ _id: -1 }),
        User.find({
            status: USER_STATUSES.ACTIVE,
            role: { $ne: ROLES.CLIENT },
            ...(userFilter ? { _id: userFilter } : {}),
        })
            .select('_id full_name')
            .lean<{ _id: Types.ObjectId; full_name: string }[]>(),
        User.countDocuments({ status: USER_STATUSES.ACTIVE, role: { $ne: ROLES.CLIENT } }),
    ]);

    // Real rows (with user display). Records for non-employees (e.g. a client
    // who checked in) still surface here on their own row.
    const userMap = await loadUserDisplays(
        Array.from(new Set(records.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id))
    );
    const realRows: Record<string, unknown>[] = records.map((r) => {
        const obj = r.toJSON() as unknown as Record<string, unknown>;
        obj.user = userMap.get(r.user_id.toString()) ?? { id: r.user_id.toString(), full_name: null };
        return obj;
    });

    // Synthetic absent rows for active non-client employees with no record.
    const recordedIds = new Set(records.map((r) => r.user_id.toString()));
    const absentRows: Record<string, unknown>[] = employees
        .filter((u) => !recordedIds.has(u._id.toString()))
        .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))
        .map((u) => ({
            id: `absent:${u._id.toString()}`,
            user_id: u._id.toString(),
            user: { id: u._id.toString(), full_name: u.full_name ?? null },
            local_date: date,
            status: 'absent',
            check_in: null,
            check_out: null,
            segments: [],
            total_worked_minutes: null,
            total_break_minutes: 0,
            flagged_for_correction: false,
            is_synthetic: true,
        }));

    let combined = [...realRows, ...absentRows];
    if (query.status) combined = combined.filter((r) => r.status === query.status);
    if (query.flagged_for_correction !== undefined) {
        combined = combined.filter((r) => Boolean(r.flagged_for_correction) === query.flagged_for_correction);
    }

    const total = combined.length;
    const skip = (query.page - 1) * query.limit;
    return {
        data: combined.slice(skip, skip + query.limit),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
            total_internal_active: totalInternalActive,
        },
    };
};

export const listAttendance = async (
    query: ListAttendanceQuery
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    // Single-day roster mode — surface the FULL active non-client workforce for
    // the day: real records for whoever has one, plus a synthetic `absent` row
    // for every active non-client employee who hasn't checked in. The FE only
    // requests this on working, non-holiday, non-future days.
    if (query.include_absent && query.from_date && query.from_date === query.to_date) {
        return listAttendanceRoster(query);
    }

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
    const [rows, total, totalInternalActive] = await Promise.all([
        AttendanceRecord.find(filter).sort({ local_date: -1, _id: -1 }).skip(skip).limit(query.limit),
        AttendanceRecord.countDocuments(filter),
        // Active non-client headcount — the canonical "workforce" denominator
        // shared with the dashboard's attendance card. Clients are excluded;
        // any client attendance still surfaces as its own row in `data`.
        User.countDocuments({ status: USER_STATUSES.ACTIVE, role: { $ne: ROLES.CLIENT } }),
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
            total_internal_active: totalInternalActive,
        },
    };
};

// ─── PATCH /attendance/:id (direct correction) ──────────────────────────

export const patchAttendance = async (
    id: Types.ObjectId,
    patch: PatchAttendanceBody,
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    if (!ATTENDANCE_REVIEW_ROLES.includes(caller.role)) {
        throw AppError.forbidden();
    }

    const record = await AttendanceRecord.findById(id);
    if (!record) {
        throw AppError.notFound('Attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }

    // C1 — snapshot the mutating fields BEFORE the patch is applied
    // so the audit `before` block captures the pre-edit state. We
    // deep-clone via `.toObject()` so subsequent in-place mutations
    // (segments, status, notes) don't leak into the snapshot.
    const beforeSnapshot = {
        segments: (record.toObject().segments ?? []) as unknown,
        status: record.status,
        notes: record.notes,
        flagged_for_correction: record.flagged_for_correction,
    };

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
            record.segments = [{ check_in: newIn, check_out: null, breaks: [] }];
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
        record.total_break_minutes = computed.total_break_minutes;
        record.break_minutes_by_type = computed.break_minutes_by_type;
        record.flagged_for_correction = false;
    }

    record.last_corrected_by = caller.id;
    record.last_corrected_at = new Date();
    await record.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.ATTENDANCE_PATCH,
            target: { kind: AUDIT_TARGET_KINDS.ATTENDANCE_RECORD, id: record._id },
            before: beforeSnapshot as Record<string, unknown>,
            after: {
                segments: record.toObject().segments ?? [],
                status: record.status,
                notes: record.notes,
                flagged_for_correction: record.flagged_for_correction,
            },
            metadata: {
                user_id: record.user_id.toString(),
                local_date: record.local_date,
            },
        });
    }
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
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const user_id = caller.id;
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
                      breaks: s.breaks
                          ? s.breaks.map((b) => ({
                                break_type: b.break_type,
                                start: new Date(b.start),
                                end: b.end ? new Date(b.end) : null,
                            }))
                          : undefined,
                  }))
                : undefined,
            check_in: body.requested_changes.check_in ? new Date(body.requested_changes.check_in) : null,
            check_out: body.requested_changes.check_out ? new Date(body.requested_changes.check_out) : null,
            reason: body.requested_changes.reason,
        },
    });

    await notifyAttendanceCorrectionSubmitted({
        request_id: created._id,
        requester_id: user_id,
        local_date: record.local_date,
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.CORRECTION_SUBMIT,
            target: { kind: AUDIT_TARGET_KINDS.CORRECTION_REQUEST, id: created._id },
            after: {
                status: created.status,
                requested_changes: created.toObject().requested_changes,
            },
            metadata: {
                attendance_record_id: record._id.toString(),
                local_date: record.local_date,
            },
        });
    }

    return created.toJSON() as unknown as Record<string, unknown>;
};

// ─── GET /attendance/correction-requests ─────────────────────────────────

/**
 * Visibility:
 *  - Reviewers (managers / team leads / admins) see everyone's requests
 *    EXCEPT their own (a reviewer can't action their own request), unless they
 *    pass an explicit `user_id` filter. Optional `status` filter applies too.
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
    } else {
        // A reviewer can never review their OWN correction request, so it must
        // not appear in their approvals queue — always exclude self (mirrors
        // the leave approvals queue). They can still look up their own via an
        // explicit `user_id` filter.
        filter.user_id = { $ne: caller_id };
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
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const reviewer_id = caller.id;
    assertCanReviewCorrections(caller.role);

    const reqDoc = await loadPendingCorrection(id);
    // Separation of duties: a reviewer can never approve their OWN correction
    // request — it must be actioned by someone above them (mirrors leaves).
    if (reqDoc.user_id.equals(reviewer_id)) {
        throw AppError.forbidden('You cannot review your own correction request');
    }
    const record = await AttendanceRecord.findById(reqDoc.attendance_record_id);
    if (!record) {
        throw AppError.notFound('Underlying attendance record not found', ERROR_CODES.ATTENDANCE_RECORD_NOT_FOUND);
    }

    // C1 — pre-edit snapshot of the record being mutated. The audit's
    // `before` block reflects the attendance record's state before the
    // approval applied the requested changes.
    const recordBeforeSnapshot = {
        segments: (record.toObject().segments ?? []) as unknown,
        status: record.status,
    };

    const changes = reqDoc.requested_changes;

    // BUG-040 — multi-segment proposal path. When the request carries
    // `segments[]` it replaces the record's segments wholesale (the
    // employee submitted a fully-specified day). Existing punch
    // metadata (method, location_id, ip) is preserved per index where
    // possible so geofence/QR audit trails don't get clobbered by a
    // manual time correction.
    const proposedSegments = changes.segments;
    // H1 — `length >= 0` was always true when defined, so an empty array
    // wiped `record.segments` without touching `local_date`. Empty
    // proposals are now blocked at the validator (`.min(1)` on
    // requested_changes.segments); the `> 0` here is belt-and-braces.
    if (proposedSegments && proposedSegments.length > 0) {
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
                // Proposed breaks (manual break correction) replace this
                // segment's breaks; otherwise the existing breaks are kept.
                breaks: p.breaks
                    ? p.breaks.map((b) => ({
                          break_type: b.break_type,
                          start: { time: b.start, source: 'app' as const },
                          end: b.end ? { time: b.end, source: 'app' as const } : null,
                      }))
                    : (old?.breaks ?? []),
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
                record.segments = [{ check_in: newIn, check_out: null, breaks: [] }];
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
    // Break totals only count CLOSED breaks, so they're valid even while the
    // day is still open — recompute unconditionally after a correction (a
    // manual break added to an open day must reflect in the totals).
    const breakTotals = breakTotalsAcrossSegments(record.segments ?? []);
    record.total_break_minutes = breakTotals.total_break_minutes;
    record.break_minutes_by_type = breakTotals.break_minutes_by_type;
    if (record.check_in && record.check_out) {
        const computed = await computeWorkedAcrossSegments(record.segments ?? []);
        record.total_worked_minutes = computed.total_worked_minutes;
        record.overtime_minutes = computed.overtime_minutes;
        record.total_break_minutes = computed.total_break_minutes;
        record.break_minutes_by_type = computed.break_minutes_by_type;
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

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.CORRECTION_APPROVE,
            target: { kind: AUDIT_TARGET_KINDS.CORRECTION_REQUEST, id: reqDoc._id },
            before: {
                request_status: 'pending',
                record: recordBeforeSnapshot,
            },
            after: {
                request_status: reqDoc.status,
                reviewer_remarks: reqDoc.reviewer_remarks,
                record: {
                    segments: record.toObject().segments ?? [],
                    status: record.status,
                },
            },
            metadata: {
                attendance_record_id: record._id.toString(),
                requester_id: reqDoc.user_id.toString(),
                local_date: record.local_date,
            },
        });
    }

    return {
        request: reqDoc.toJSON(),
        record: record.toJSON(),
    };
};

// ─── POST /attendance/correction-requests/:id/reject ────────────────────

export const rejectCorrection = async (
    id: Types.ObjectId,
    body: ReviewCorrectionBody,
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const reviewer_id = caller.id;
    assertCanReviewCorrections(caller.role);

    const reqDoc = await loadPendingCorrection(id);
    // Separation of duties: a reviewer can never reject their OWN correction
    // request — it must be actioned by someone above them (mirrors leaves).
    if (reqDoc.user_id.equals(reviewer_id)) {
        throw AppError.forbidden('You cannot review your own correction request');
    }
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

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.CORRECTION_REJECT,
            target: { kind: AUDIT_TARGET_KINDS.CORRECTION_REQUEST, id: reqDoc._id },
            before: { status: 'pending' },
            after: {
                status: reqDoc.status,
                reviewer_remarks: reqDoc.reviewer_remarks,
            },
            metadata: {
                attendance_record_id: reqDoc.attendance_record_id.toString(),
                requester_id: reqDoc.user_id.toString(),
                local_date: record?.local_date ?? null,
            },
        });
    }

    return reqDoc.toJSON() as unknown as Record<string, unknown>;
};

// ─── POST /attendance/correction-requests/:id/cancel ─────────────────────

/**
 * M49 — owner-only withdraw of a pending correction request.
 *
 * Pre-M49 there was no cancel verb; an employee who realised their
 * proposal was wrong was stuck. Re-submitting tripped
 * `CORRECTION_REQUEST_ALREADY_PENDING` (one pending per record) and
 * the only paths to clear it were reviewer approve or reject —
 * neither appropriate.
 *
 * Authorization: the request OWNER only. Reviewers don't need this
 * verb (they have approve/reject); admins shouldn't be cancelling
 * someone else's request silently. The existence-hiding 404 pattern
 * used elsewhere applies here too so nobody can probe other people's
 * requests by id.
 */
export const cancelCorrection = async (
    id: Types.ObjectId,
    caller: { id: Types.ObjectId; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const reqDoc = await loadPendingCorrection(id);
    if (!reqDoc.user_id.equals(caller.id)) {
        // Hide existence — surface as not-found so cross-user probes
        // can't enumerate.
        throw AppError.notFound('Correction request not found', ERROR_CODES.CORRECTION_REQUEST_NOT_FOUND);
    }
    reqDoc.status = 'cancelled';
    reqDoc.acted_at = new Date();
    await reqDoc.save();

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.CORRECTION_CANCEL,
            target: { kind: AUDIT_TARGET_KINDS.CORRECTION_REQUEST, id: reqDoc._id },
            before: { status: 'pending' },
            after: { status: reqDoc.status },
            metadata: {
                attendance_record_id: reqDoc.attendance_record_id.toString(),
            },
        });
    }

    return reqDoc.toJSON() as unknown as Record<string, unknown>;
};

// M16 — BUG-040 `migrateAttendanceSegments` removed. The one-time
// backfill (legacy single-`check_in` rows → `segments[]`) ran on
// every boot even after the DB was long-since migrated. Deleted to
// stop the wasted cursor scan. If a future env genuinely needs the
// backfill again, the function is preserved in git history and
// should be re-introduced behind a deliberate boot flag rather than
// running unconditionally.

// ─── Slack Home dashboard — today's attendance snapshot ──────────────────

export interface TodayAttendanceSummary {
    headcount: number;
    present: number;
    incomplete: number;
    on_leave: number;
    not_in_count: number;
    not_in_roster: Array<{ id: string; full_name: string | null }>;
}

/**
 * Org-wide snapshot of *today's* attendance for the Slack Home dashboard
 * (read_team viewers only — the caller gates on the permission).
 *
 * Counts come from the AttendanceRecord rows that exist for today; "not in"
 * is the set of active internal users (role != client) with no row yet. The
 * on_leave/incomplete counts reflect finalized rows (the EOD finalizer fills
 * placeholders), so during the day on_leave may read 0 — the dashboard's
 * separate "Who's out" section is the authoritative leave view.
 */
export const getTodayAttendanceSummary = async (rosterCap: number): Promise<TodayAttendanceSummary> => {
    const local_date = todayLocalDate();

    const [users, rows] = await Promise.all([
        User.find({ status: USER_STATUSES.ACTIVE, role: { $ne: ROLES.CLIENT } })
            .select('_id full_name')
            .lean<{ _id: Types.ObjectId; full_name: string }[]>(),
        AttendanceRecord.find({ local_date })
            .select('user_id status check_in')
            .lean<{ user_id: Types.ObjectId; status: string; check_in: { time: Date } | null }[]>(),
    ]);

    const byUser = new Map(rows.map((r) => [r.user_id.toString(), r]));
    let present = 0;
    let incomplete = 0;
    let on_leave = 0;
    for (const r of rows) {
        if (r.status === 'incomplete') incomplete += 1;
        else if (r.status === 'on_leave') on_leave += 1;
        else if (r.check_in) present += 1;
    }

    const not_in = users.filter((u) => !byUser.has(u._id.toString()));
    return {
        headcount: users.length,
        present,
        incomplete,
        on_leave,
        not_in_count: not_in.length,
        not_in_roster: not_in.slice(0, rosterCap).map((u) => ({ id: u._id.toString(), full_name: u.full_name })),
    };
};

// Re-exports for the helper callers (test fixtures, future cron).
export { todayLocalDate };

/** Type-only re-export so the controller can pin a return shape. */
export type AttendanceRecordSnapshot = AttendanceRecordDocument['toJSON'] extends () => infer R
    ? R
    : Record<string, unknown>;
