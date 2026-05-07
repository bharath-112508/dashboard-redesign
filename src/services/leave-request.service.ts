import { Types } from 'mongoose';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';

import { LeaveRequest, type LeaveRequestDocument, type LeaveSegment } from '../models/leave-request.model.js';
import { LeaveBalance, recomputeAvailable } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { Holiday } from '../models/holiday.model.js';
import { SlMonthlyForfeiture } from '../models/sl-monthly-forfeiture.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import {
    LEAVE_CODES,
    LEAVE_REQUEST_STATUSES,
    LEAVE_TIMEZONE,
    type LeaveCode,
    type LeaveRequestStatus,
} from '../constants/leave.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { getOrInitSettings } from './settings.service.js';
import { findOrInitBalance, initializeBalancesForUserYear } from './leave-balance.service.js';
import { generateSegments, type ComputedSegment, type SegmentEngineResult } from './leave-segment.engine.js';
import { notifyLeaveDecided, notifyLeaveSubmitted } from './notification-dispatcher.service.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { withTransaction } from '../utils/with-transaction.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type {
    ApplyLeaveBody,
    ApproveLeaveBody,
    CalendarLeavesQuery,
    CancelLeaveBody,
    ListLeavesQuery,
    RejectLeaveBody,
} from '../validators/leave-request.validator.js';

dayjs.extend(customParseFormat);
dayjs.extend(utcPlugin);
dayjs.extend(timezonePlugin);

/**
 * Leave-request service (API_Contract.md §5.4–5.8, Data_Model.md §3.3).
 *
 * Lifecycle (`leave_requests.status`):
 *
 *   pending ──approve──▶ approved ──cancel──▶ cancelled (refund used)
 *      │                                ▲
 *      ├──reject──▶ rejected            │
 *      └──cancel──▶ cancelled (refund pending)
 *
 * Concurrency:
 *  - Apply does atomic conditional updates on each `(user, type, year)`
 *    balance row (`available >= n` guard for non-CL types). Failure of any
 *    leg rolls back prior reservations for the same request.
 *  - Approve/reject/cancel-after-approval use
 *    `findOneAndUpdate({ _id, status: <expected> })` so the loser of any
 *    race sees a 409 instead of double-mutating balances.
 *
 * SL handling:
 *  - Apply-time engine reads the SL "already used / forfeited" map for the
 *    user across both `leave_segments` and `sl_monthly_forfeitures`.
 *  - Engine outputs `code` segments; this service resolves them to
 *    `leave_type_id` against the active types map.
 */

type Filter = Record<string, unknown>;

const ACTIVE_LEAVE_STATUSES: LeaveRequestStatus[] = [LEAVE_REQUEST_STATUSES.PENDING, LEAVE_REQUEST_STATUSES.APPROVED];

// ─── Authorisation helpers ────────────────────────────────────────────────

/**
 * Step 47: Team Lead is a first-line approver — `leave_request.approve`
 * is in their permission bundle. The legacy approval path was admin /
 * manager only; team_lead now joins them. Reporting-chain narrowing
 * (only own reports' requests) is a future enhancement; for now, all
 * three roles are eligible to approve any pending leave they can see
 * — same posture as the legacy manager+ design.
 */
const isReviewer = (role: RoleType): boolean =>
    role === ROLES.ADMIN || role === ROLES.MANAGER || role === ROLES.TEAM_LEAD;

const ensureCanReadRequest = (req: LeaveRequestDocument, caller: { id: Types.ObjectId; role: RoleType }) => {
    if (caller.id.equals(req.user_id)) return;
    if (isReviewer(caller.role)) return;
    throw AppError.forbidden();
};

const ensureCanReviewRequest = (req: LeaveRequestDocument, caller: { id: Types.ObjectId; role: RoleType }) => {
    if (!isReviewer(caller.role)) {
        throw AppError.forbidden('Only managers or admins can review leave requests');
    }
    if (caller.id.equals(req.user_id)) {
        throw AppError.forbidden('You cannot review your own leave request');
    }
};

// ─── Settings / context loaders ───────────────────────────────────────────

interface ApplyContext {
    workingDays: readonly number[];
    holidayDates: ReadonlySet<string>;
    activeTypes: LeaveTypeDocument[];
    typesByCode: Map<LeaveCode | string, LeaveTypeDocument>;
    typesById: Map<string, LeaveTypeDocument>;
    clNoticeDays: number;
    timezone: string;
}

const loadApplyContext = async (spanFrom: string, spanTo: string): Promise<ApplyContext> => {
    const settings = await getOrInitSettings();
    const workingDays = settings.work_schedule?.working_days ?? [1, 2, 3, 4, 5];
    const clNoticeDays = settings.leave_policy?.cl_advance_notice_days ?? 14;

    const [holidays, types] = await Promise.all([
        Holiday.find({ date: { $gte: spanFrom, $lte: spanTo } }).select({ date: 1, _id: 0 }),
        LeaveType.find({ is_active: true }),
    ]);

    return {
        workingDays,
        holidayDates: new Set(holidays.map((h) => h.date)),
        activeTypes: types,
        typesByCode: new Map(types.map((t) => [t.code, t])),
        typesById: new Map(types.map((t) => [t._id.toString(), t])),
        clNoticeDays,
        timezone: settings.default_timezone || LEAVE_TIMEZONE,
    };
};

// ─── SL "already used this month" map (engine input) ──────────────────────

const buildSlMonthUsedMap = async (params: {
    user_id: Types.ObjectId;
    sl_type_id: Types.ObjectId;
    yearsTouched: number[];
}): Promise<Map<string, number>> => {
    const out = new Map<string, number>();
    if (params.yearsTouched.length === 0) return out;

    // Existing SL segments (pending + approved) — sum days per month, keyed
    // off the request's start_date month so SL cannot retroactively be split
    // across months by a future request.
    const reqs = await LeaveRequest.find({
        user_id: params.user_id,
        status: { $in: [LEAVE_REQUEST_STATUSES.PENDING, LEAVE_REQUEST_STATUSES.APPROVED] },
        'leave_segments.leave_type_id': params.sl_type_id,
        'leave_segments.year': { $in: params.yearsTouched },
    });
    for (const r of reqs) {
        const month = Number.parseInt(r.start_date.slice(5, 7), 10);
        for (const seg of r.leave_segments) {
            if (!seg.leave_type_id.equals(params.sl_type_id)) continue;
            if (!params.yearsTouched.includes(seg.year)) continue;
            const key = `${seg.year}-${month}`;
            out.set(key, (out.get(key) ?? 0) + seg.days);
        }
    }

    // Plus forfeitures for the years touched.
    const fft = await SlMonthlyForfeiture.find({
        user_id: params.user_id,
        year: { $in: params.yearsTouched },
    });
    for (const f of fft) {
        const key = `${f.year}-${f.month}`;
        out.set(key, (out.get(key) ?? 0) + (f.forfeited_days || 0));
    }

    return out;
};

// ─── Core: convert engine result → DB-ready segments ─────────────────────

const resolveSegments = (
    engine: SegmentEngineResult,
    typesByCode: Map<LeaveCode | string, LeaveTypeDocument>
): LeaveSegment[] => {
    return engine.leave_segments.map((s: ComputedSegment) => {
        const lt = typesByCode.get(s.leave_type_code);
        if (!lt) {
            throw AppError.internal(`Leave type "${s.leave_type_code}" missing from active types`);
        }
        return {
            leave_type_id: lt._id,
            year: s.year,
            days: s.days,
        };
    });
};

// ─── Public: preview (dry run) ────────────────────────────────────────────

export const previewSplit = async (
    body: ApplyLeaveBody,
    caller: { id: Types.ObjectId }
): Promise<{
    total_days: number;
    leave_segments: Array<{ leave_type_id: string; leave_type_code: string; year: number; days: number }>;
    requires_additional_approval: boolean;
    warnings: { code: string; message: string }[];
}> => {
    const ctx = await loadApplyContext(body.start_date, body.end_date);
    const requestedType = ctx.typesById.get(body.leave_type_id);
    if (!requestedType) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (!requestedType.is_active) {
        throw AppError.validation('Leave type is inactive');
    }
    const sl = ctx.typesByCode.get(LEAVE_CODES.SL);

    // Enumerate years touched for the SL "already used" probe.
    const span = enumerateYears(body.start_date, body.end_date);
    const slMonthUsed = sl
        ? await buildSlMonthUsedMap({
              user_id: caller.id,
              sl_type_id: sl._id,
              yearsTouched: span,
          })
        : new Map();

    // Available snapshot — only hydrate years/types we'll touch.
    const availableMap = await loadAvailableMap({
        user_id: caller.id,
        years: span,
        types: ctx.activeTypes,
    });

    const engine = generateSegments({
        requested_code: requestedType.code as LeaveCode,
        start_date: body.start_date,
        end_date: body.end_date,
        is_half_day: body.is_half_day ?? false,
        half_day_slot: body.half_day_slot ?? null,
        working_days: ctx.workingDays,
        holidays: ctx.holidayDates,
        sl_month_used: slMonthUsed,
        available: availableMap,
        slots_per_month: requestedType.code === LEAVE_CODES.SL ? (requestedType.monthly_cap ?? 1) : 1,
    });

    return {
        total_days: engine.total_days,
        leave_segments: engine.leave_segments.map((s) => {
            const lt = ctx.typesByCode.get(s.leave_type_code)!;
            return {
                leave_type_id: lt._id.toString(),
                leave_type_code: s.leave_type_code,
                year: s.year,
                days: s.days,
            };
        }),
        requires_additional_approval: engine.requires_additional_approval,
        warnings: engine.warnings,
    };
};

const enumerateYears = (start: string, end: string): number[] => {
    const a = Number.parseInt(start.slice(0, 4), 10);
    const b = Number.parseInt(end.slice(0, 4), 10);
    const out: number[] = [];
    for (let y = a; y <= b; y++) out.push(y);
    return out;
};

const loadAvailableMap = async (params: {
    user_id: Types.ObjectId;
    years: number[];
    types: LeaveTypeDocument[];
}): Promise<Map<string, number>> => {
    // Self-heal balance rows for every touched year so the engine's
    // requires_additional_approval flag is computed against real values.
    for (const y of params.years) {
        await initializeBalancesForUserYear({ user_id: params.user_id, year: y });
    }
    const rows = await LeaveBalance.find({
        user_id: params.user_id,
        year: { $in: params.years },
    });
    const out = new Map<string, number>();
    const idToCode = new Map(params.types.map((t) => [t._id.toString(), t.code]));
    for (const r of rows) {
        const code = idToCode.get(r.leave_type_id.toString());
        if (!code) continue;
        out.set(`${code}|${r.year}`, recomputeAvailable(r));
    }
    return out;
};

// ─── Public: overlap pre-check ────────────────────────────────────────────

const assertNoOverlap = async (params: {
    user_id: Types.ObjectId;
    start_date: string;
    end_date: string;
    excludeId?: Types.ObjectId;
}) => {
    const filter: Filter = {
        user_id: params.user_id,
        status: { $in: ACTIVE_LEAVE_STATUSES },
        // Overlap predicate: existing.start <= new.end AND existing.end >= new.start
        start_date: { $lte: params.end_date },
        end_date: { $gte: params.start_date },
    };
    if (params.excludeId) {
        filter._id = { $ne: params.excludeId };
    }
    const existing = await LeaveRequest.findOne(filter).select({ _id: 1, start_date: 1, end_date: 1 });
    if (existing) {
        throw AppError.conflict(
            `Request overlaps with an existing leave (${existing.start_date} → ${existing.end_date})`,
            ERROR_CODES.LEAVE_OVERLAP,
            { conflicting_id: existing._id.toString() }
        );
    }
};

// ─── Public: apply ────────────────────────────────────────────────────────

export const applyLeave = async (
    body: ApplyLeaveBody,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<Record<string, unknown>> => {
    const ctx = await loadApplyContext(body.start_date, body.end_date);
    const requestedType = ctx.typesById.get(body.leave_type_id);
    if (!requestedType) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (!requestedType.is_active) {
        throw AppError.validation('Leave type is inactive');
    }

    // Date-policy gates ----------------------------------------------------
    const today = dayjs().tz(ctx.timezone).format('YYYY-MM-DD');
    if (body.start_date < today) {
        throw AppError.unprocessable('Backdated leave is not allowed', ERROR_CODES.LEAVE_BACKDATED_NOT_ALLOWED);
    }

    if (requestedType.code === LEAVE_CODES.CL && ctx.clNoticeDays > 0) {
        const earliest = dayjs(today).add(ctx.clNoticeDays, 'day').format('YYYY-MM-DD');
        if (body.start_date < earliest) {
            throw AppError.unprocessable(
                `Casual leave must be applied at least ${ctx.clNoticeDays} days in advance (earliest start: ${earliest})`,
                ERROR_CODES.LEAVE_NOTICE_VIOLATION,
                { earliest_start_date: earliest }
            );
        }
    }

    // Half-day / supports_half_day check
    if (body.is_half_day && !requestedType.supports_half_day) {
        throw AppError.unprocessable(
            `Leave type ${requestedType.code} does not support half-day requests`,
            ERROR_CODES.LEAVE_INVALID_HALF_DAY
        );
    }

    // Engine ----------------------------------------------------------------
    const sl = ctx.typesByCode.get(LEAVE_CODES.SL);
    const yearsTouched = enumerateYears(body.start_date, body.end_date);
    const [slMonthUsed, availableMap] = await Promise.all([
        sl
            ? buildSlMonthUsedMap({
                  user_id: caller.id,
                  sl_type_id: sl._id,
                  yearsTouched,
              })
            : Promise.resolve(new Map()),
        loadAvailableMap({
            user_id: caller.id,
            years: yearsTouched,
            types: ctx.activeTypes,
        }),
    ]);

    const engine = generateSegments({
        requested_code: requestedType.code as LeaveCode,
        start_date: body.start_date,
        end_date: body.end_date,
        is_half_day: body.is_half_day ?? false,
        half_day_slot: body.half_day_slot ?? null,
        working_days: ctx.workingDays,
        holidays: ctx.holidayDates,
        sl_month_used: slMonthUsed,
        available: availableMap,
        slots_per_month: requestedType.code === LEAVE_CODES.SL ? (requestedType.monthly_cap ?? 1) : 1,
    });

    // Warnings → errors --------------------------------------------------
    if (engine.warnings.some((w) => w.code === 'LEAVE_INVALID_HALF_DAY')) {
        throw AppError.unprocessable(
            'Half-day requests must have start_date == end_date',
            ERROR_CODES.LEAVE_INVALID_HALF_DAY
        );
    }
    if (engine.total_days === 0 || engine.leave_segments.length === 0) {
        throw AppError.unprocessable(
            'Request contains no working days (all weekends / holidays)',
            ERROR_CODES.LEAVE_NO_WORKING_DAYS
        );
    }

    // Overlap (after we know we have real segments) -----------------------
    await assertNoOverlap({
        user_id: caller.id,
        start_date: body.start_date,
        end_date: body.end_date,
    });

    // Resolve to ObjectIds + reserve balances atomically ------------------
    const segments = resolveSegments(engine, ctx.typesByCode);
    await reserveBalances({ user_id: caller.id, segments, requestedType, allowNegative: false });

    // Persist the request.
    let created: LeaveRequestDocument;
    try {
        created = await LeaveRequest.create({
            user_id: caller.id,
            requested_leave_type_id: requestedType._id,
            start_date: body.start_date,
            end_date: body.end_date,
            is_half_day: body.is_half_day ?? false,
            half_day_slot: body.half_day_slot ?? null,
            total_days: engine.total_days,
            leave_segments: segments,
            reason: body.reason,
            attachment_url: body.attachment_url ?? null,
            status: LEAVE_REQUEST_STATUSES.PENDING,
            requires_additional_approval: engine.requires_additional_approval,
            additional_approval_reason: null,
            approver_id: null,
            approver_remarks: '',
            acted_at: null,
        });
    } catch (err) {
        // Rollback reservations if the LeaveRequest insert fails for any reason.
        await releaseReservations({ user_id: caller.id, segments });
        throw err;
    }

    // Notify reviewers in-app + email. The dispatcher never throws — failures
    // are logged as `NOTIFICATION_DISPATCH_FAILED` and the apply still
    // returns 2xx (API_Contract §15.500).
    await notifyLeaveSubmitted({
        request_id: created._id,
        requester_id: caller.id,
        leave_type_label: leaveTypeLabel(requestedType),
        start_date: body.start_date,
        end_date: body.end_date,
        total_days: engine.total_days,
    });

    return toRequestPublic(created, ctx.typesById);
};

/**
 * Render a leave type as "CL — Casual Leave" (or just the name when the code
 * already starts the string). Used in notification titles + bodies so the
 * recipient sees the human label, not a hex id.
 */
const leaveTypeLabel = (lt: LeaveTypeDocument): string => {
    if (!lt) return 'leave';
    if (lt.code && lt.name && !lt.name.toLowerCase().includes(lt.code.toLowerCase())) {
        return `${lt.code} — ${lt.name}`;
    }
    return lt.name ?? lt.code ?? 'leave';
};

// ─── Reservation logic (atomic conditional updates) ──────────────────────

const reserveBalances = async (params: {
    user_id: Types.ObjectId;
    segments: LeaveSegment[];
    requestedType: LeaveTypeDocument;
    allowNegative: boolean;
}) => {
    // Apply reservations one segment at a time so we can roll back the
    // partial subset if a later one fails.
    const applied: LeaveSegment[] = [];
    try {
        for (const seg of params.segments) {
            const lt = await LeaveType.findById(seg.leave_type_id);
            if (!lt) throw AppError.internal('Leave type vanished mid-apply');

            // Self-heal the row first so atomic update has a target.
            await findOrInitBalance({
                user_id: params.user_id,
                leave_type_id: seg.leave_type_id,
                year: seg.year,
            });

            const filter: Filter = {
                user_id: params.user_id,
                leave_type_id: seg.leave_type_id,
                year: seg.year,
            };
            // CL is allowed to dip negative (additional-approval workflow);
            // every other type must have enough room. Unlimited types skip
            // the guard entirely.
            if (!lt.is_unlimited && lt.code !== LEAVE_CODES.CL) {
                filter.available = { $gte: seg.days };
            }

            const updated = await LeaveBalance.findOneAndUpdate(
                filter,
                { $inc: { pending: seg.days, available: -seg.days } },
                { new: true }
            );
            if (!updated) {
                // Either the row is gone or balance is short.
                if (lt.is_unlimited || lt.code === LEAVE_CODES.CL) {
                    throw AppError.internal('Failed to reserve balance');
                }
                throw AppError.conflict(
                    `Insufficient ${lt.code} balance for ${seg.year}`,
                    ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE,
                    { code: lt.code, year: seg.year, requested: seg.days }
                );
            }
            applied.push(seg);
        }
    } catch (err) {
        // Roll back anything that succeeded before the failure.
        await releaseReservations({ user_id: params.user_id, segments: applied });
        throw err;
    }
};

const releaseReservations = async (params: { user_id: Types.ObjectId; segments: LeaveSegment[] }) => {
    for (const seg of params.segments) {
        await LeaveBalance.updateOne(
            {
                user_id: params.user_id,
                leave_type_id: seg.leave_type_id,
                year: seg.year,
            },
            { $inc: { pending: -seg.days, available: seg.days } }
        );
    }
};

// ─── Listing / get ────────────────────────────────────────────────────────

const toRequestPublic = async (
    doc: LeaveRequestDocument,
    typeCache?: Map<string, LeaveTypeDocument>
): Promise<Record<string, unknown>> => {
    const cache = typeCache ?? new Map<string, LeaveTypeDocument>();
    const missing = doc.leave_segments
        .map((s) => s.leave_type_id.toString())
        .concat([doc.requested_leave_type_id.toString()])
        .filter((id) => !cache.has(id));
    if (missing.length > 0) {
        const ids = Array.from(new Set(missing)).map((s) => new Types.ObjectId(s));
        const fetched = await LeaveType.find({ _id: { $in: ids } });
        for (const t of fetched) cache.set(t._id.toString(), t);
    }
    const requested = cache.get(doc.requested_leave_type_id.toString());

    const json = doc.toJSON() as Record<string, unknown>;
    json.requested_leave_type = requested
        ? { id: requested._id.toString(), code: requested.code, name: requested.name }
        : { id: doc.requested_leave_type_id.toString() };
    json.leave_segments = doc.leave_segments.map((s) => {
        const lt = cache.get(s.leave_type_id.toString());
        return {
            leave_type_id: s.leave_type_id.toString(),
            leave_type_code: lt?.code ?? null,
            year: s.year,
            days: s.days,
        };
    });
    return json;
};

export const listLeaves = async (
    query: ListLeavesQuery,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (isReviewer(caller.role)) {
        if (query.user_id) filter.user_id = new Types.ObjectId(query.user_id);
    } else {
        // Employees only see their own.
        filter.user_id = caller.id;
    }
    if (query.status) filter.status = query.status;
    if (query.requires_additional_approval !== undefined) {
        filter.requires_additional_approval = query.requires_additional_approval;
    }
    if (query.from_date && query.to_date) {
        filter.$and = [{ start_date: { $lte: query.to_date } }, { end_date: { $gte: query.from_date } }];
    } else if (query.from_date) {
        filter.start_date = { $gte: query.from_date };
    } else if (query.to_date) {
        filter.end_date = { $lte: query.to_date };
    }

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        LeaveRequest.find(filter).sort({ start_date: -1, _id: -1 }).skip(skip).limit(query.limit),
        LeaveRequest.countDocuments(filter),
    ]);

    const cache = new Map<string, LeaveTypeDocument>();
    const data = await Promise.all(rows.map((r) => toRequestPublic(r, cache)));
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

export const getLeave = async (
    id: Types.ObjectId,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<Record<string, unknown>> => {
    const doc = await LeaveRequest.findById(id);
    if (!doc) throw AppError.notFound('Leave request not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    ensureCanReadRequest(doc, caller);
    return toRequestPublic(doc);
};

// ─── Approve / reject / cancel ────────────────────────────────────────────

export const approveLeave = async (
    id: Types.ObjectId,
    body: ApproveLeaveBody,
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const existing = await LeaveRequest.findById(id);
    if (!existing) throw AppError.notFound('Leave request not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    ensureCanReviewRequest(existing, caller);

    if (
        existing.requires_additional_approval &&
        (!body.additional_approval_reason || body.additional_approval_reason.trim().length < 5)
    ) {
        throw AppError.unprocessable(
            'This request would drive a balance below zero — provide additional_approval_reason (min 5 chars)',
            ERROR_CODES.ADDITIONAL_APPROVAL_REASON_REQUIRED
        );
    }

    // H2 — status transition + balance moves are atomic. Pre-H2 the
    // PENDING→APPROVED swap and the per-segment `pending → used`
    // updates were separate writes; a network partition between them
    // left the request approved but balance still in `pending`,
    // silently inflating available balance by the leave amount until
    // someone noticed. The atomic state-transition guard remains
    // (the `status: PENDING` predicate inside the transaction
    // double-protects against double-approval).
    const updated = await withTransaction(async (session) => {
        const findOpts = session ? { new: true, session } : { new: true };

        const u = await LeaveRequest.findOneAndUpdate(
            { _id: existing._id, status: LEAVE_REQUEST_STATUSES.PENDING },
            {
                $set: {
                    status: LEAVE_REQUEST_STATUSES.APPROVED,
                    approver_id: caller.id,
                    approver_remarks: body.approver_remarks ?? '',
                    additional_approval_reason: existing.requires_additional_approval
                        ? (body.additional_approval_reason ?? null)
                        : null,
                    acted_at: new Date(),
                },
            },
            findOpts
        );
        if (!u) {
            throw AppError.conflict(
                'Leave request is no longer pending',
                ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING
            );
        }

        // Move pending → used on each segment. Same session as the
        // status flip — either everything commits or nothing does.
        // Omit the third argument entirely when no session, matching
        // pre-H2 call shape so tests that strict-match call args
        // (`toHaveBeenNthCalledWith(1, filter, update)`) still work.
        for (const seg of u.leave_segments) {
            const filter = {
                user_id: u.user_id,
                leave_type_id: seg.leave_type_id,
                year: seg.year,
            };
            const update = { $inc: { pending: -seg.days, used: seg.days } };
            if (session) {
                await LeaveBalance.updateOne(filter, update, { session });
            } else {
                await LeaveBalance.updateOne(filter, update);
            }
        }
        return u;
    });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LEAVE_APPROVE,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_REQUEST, id: updated._id },
            before: { status: existing.status },
            after: {
                status: updated.status,
                approver_id: updated.approver_id?.toString() ?? null,
                approver_remarks: updated.approver_remarks,
                additional_approval_reason: updated.additional_approval_reason,
            },
            metadata: {
                requester_id: updated.user_id.toString(),
                requires_additional_approval: existing.requires_additional_approval,
                total_days: updated.total_days,
            },
        });
    }

    await notifyLeaveDecisionFromRequest(updated, 'approved', caller.id, body.approver_remarks ?? null);
    return toRequestPublic(updated);
};

/**
 * Helper used by approve/reject/cancel to look up the requested leave type
 * once and emit the correct decision notification. Centralised so the three
 * lifecycle endpoints share one call shape — and adding a new decision type
 * later (e.g. `partially_approved`) only touches this function.
 */
const notifyLeaveDecisionFromRequest = async (
    req: LeaveRequestDocument,
    decision: 'approved' | 'rejected' | 'cancelled',
    actor_id: Types.ObjectId,
    remarks: string | null
): Promise<void> => {
    const requestedType = await LeaveType.findById(req.requested_leave_type_id).select('code name');
    await notifyLeaveDecided({
        request_id: req._id,
        requester_id: req.user_id,
        leave_type_label: requestedType ? leaveTypeLabel(requestedType) : 'leave',
        start_date: req.start_date,
        end_date: req.end_date,
        total_days: req.total_days,
        decision,
        actor: { id: actor_id },
        remarks,
    });
};

export const rejectLeave = async (
    id: Types.ObjectId,
    body: RejectLeaveBody,
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const existing = await LeaveRequest.findById(id);
    if (!existing) throw AppError.notFound('Leave request not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    ensureCanReviewRequest(existing, caller);

    const updated = await LeaveRequest.findOneAndUpdate(
        { _id: existing._id, status: LEAVE_REQUEST_STATUSES.PENDING },
        {
            $set: {
                status: LEAVE_REQUEST_STATUSES.REJECTED,
                approver_id: caller.id,
                approver_remarks: body.approver_remarks,
                acted_at: new Date(),
            },
        },
        { new: true }
    );
    if (!updated) {
        throw AppError.conflict('Leave request is no longer pending', ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING);
    }

    // Refund pending → 0 (no used change since it never approved).
    await releaseReservations({ user_id: updated.user_id, segments: updated.leave_segments });

    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LEAVE_REJECT,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_REQUEST, id: updated._id },
            before: { status: existing.status },
            after: {
                status: updated.status,
                approver_id: updated.approver_id?.toString() ?? null,
                approver_remarks: updated.approver_remarks,
            },
            metadata: { requester_id: updated.user_id.toString() },
        });
    }

    await notifyLeaveDecisionFromRequest(updated, 'rejected', caller.id, body.approver_remarks ?? null);
    return toRequestPublic(updated);
};

export const cancelLeave = async (
    id: Types.ObjectId,
    body: CancelLeaveBody,
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    const existing = await LeaveRequest.findById(id);
    if (!existing) throw AppError.notFound('Leave request not found', ERROR_CODES.RESOURCE_NOT_FOUND);

    // Self can cancel own; reviewers can cancel anyone's.
    if (!caller.id.equals(existing.user_id) && !isReviewer(caller.role)) {
        throw AppError.forbidden("You cannot cancel another user's leave request");
    }

    if (existing.status === LEAVE_REQUEST_STATUSES.CANCELLED) {
        return toRequestPublic(existing);
    }
    if (existing.status === LEAVE_REQUEST_STATUSES.REJECTED) {
        throw AppError.conflict('Cannot cancel a rejected request', ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING);
    }

    // Approved + already started → too late.
    const ctx = await loadApplyContext(existing.start_date, existing.end_date);
    const today = dayjs().tz(ctx.timezone).format('YYYY-MM-DD');
    if (existing.status === LEAVE_REQUEST_STATUSES.APPROVED && existing.start_date <= today) {
        throw AppError.unprocessable(
            'Cannot cancel a leave that has already started',
            ERROR_CODES.LEAVE_ALREADY_CONSUMED
        );
    }

    const expectedStatus = existing.status as LeaveRequestStatus;
    const updated = await LeaveRequest.findOneAndUpdate(
        { _id: existing._id, status: expectedStatus },
        {
            $set: {
                status: LEAVE_REQUEST_STATUSES.CANCELLED,
                cancelled_at: new Date(),
                cancelled_by: caller.id,
                cancellation_reason: body.cancellation_reason,
            },
        },
        { new: true }
    );
    if (!updated) {
        throw AppError.conflict(
            'Leave request status changed concurrently — refresh and retry',
            ERROR_CODES.CONCURRENT_UPDATE_CONFLICT
        );
    }

    // Refund per-segment to the original (type, year) row.
    if (expectedStatus === LEAVE_REQUEST_STATUSES.APPROVED) {
        for (const seg of updated.leave_segments) {
            await LeaveBalance.updateOne(
                {
                    user_id: updated.user_id,
                    leave_type_id: seg.leave_type_id,
                    year: seg.year,
                },
                { $inc: { used: -seg.days, available: seg.days } }
            );
        }
    } else {
        // Pending → just release the reservation.
        await releaseReservations({ user_id: updated.user_id, segments: updated.leave_segments });
    }

    if (caller.audit) {
        const isSelfCancel = caller.id.equals(existing.user_id);
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LEAVE_CANCEL,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_REQUEST, id: updated._id },
            before: { status: existing.status },
            after: {
                status: updated.status,
                cancelled_at: updated.cancelled_at,
                cancelled_by: updated.cancelled_by?.toString() ?? null,
                cancellation_reason: updated.cancellation_reason,
            },
            metadata: {
                requester_id: updated.user_id.toString(),
                self_cancel: isSelfCancel,
                previous_status: expectedStatus,
            },
        });
    }

    await notifyLeaveDecisionFromRequest(updated, 'cancelled', caller.id, body.cancellation_reason ?? null);
    return toRequestPublic(updated);
};

// ─── GET /leaves/calendar ────────────────────────────────────────────────

export const calendarLeaves = async (query: CalendarLeavesQuery): Promise<Record<string, unknown>[]> => {
    const rows = await LeaveRequest.find({
        status: LEAVE_REQUEST_STATUSES.APPROVED,
        start_date: { $lte: query.to_date },
        end_date: { $gte: query.from_date },
    })
        .sort({ start_date: 1 })
        .limit(1000);
    const cache = new Map<string, LeaveTypeDocument>();
    return Promise.all(rows.map((r) => toRequestPublic(r, cache)));
};
