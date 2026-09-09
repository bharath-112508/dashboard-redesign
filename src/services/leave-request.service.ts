import { Types } from 'mongoose';
import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import utcPlugin from 'dayjs/plugin/utc.js';
import timezonePlugin from 'dayjs/plugin/timezone.js';

import { LeaveRequest, type LeaveRequestDocument, type LeaveSegment } from '../models/leave-request.model.js';
import { LeaveBalance, recomputeAvailable } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { User } from '../models/user.model.js';
import { Holiday } from '../models/holiday.model.js';
import { SlMonthlyForfeiture } from '../models/sl-monthly-forfeiture.model.js';
import { AppError } from '../utils/app-error.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { callerCan } from '../utils/caller-permissions.js';
import { resolvePermissionsForUser } from './role.service.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import {
    COMP_OFF_SOURCES,
    LEAVE_CODES,
    LEAVE_REQUEST_STATUSES,
    LEAVE_TIMEZONE,
    type LeaveCode,
    type LeaveRequestStatus,
} from '../constants/leave.js';
import { EMPLOYMENT_TYPES } from '../constants/user-statuses.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { directReportIdsOf, isDirectReportOf } from './reporting-scope.service.js';
import { consumeCompOffLots, refundConsumedLots, resyncCompOff } from './comp-off.service.js';
import { getOrInitSettings } from './settings.service.js';
import { findOrInitBalance, initializeBalancesForUserYear } from './leave-balance.service.js';
import {
    enumerateWorkingDays,
    generateSegments,
    type ComputedSegment,
    type SegmentEngineResult,
} from './leave-segment.engine.js';
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

/**
 * Effective permissions for a caller, by id.
 *
 * The WRITE paths below ask this rather than reading `caller.role`, because
 * that legacy field goes stale: `role.service:assignRolesToUser` computes it
 * from SYSTEM role keys only, so assigning a user ONLY custom roles leaves
 * `set.role` unwritten and the old value in place. A team lead narrowed to a
 * custom role WITHOUT `leave_request.approve` therefore still reads as
 * `'team_lead'` — denied by `requirePermission` on the HTTP route, but waved
 * through by any check that trusts the string. The Slack path had exactly
 * that hole, and this guard was the second copy of it, so there was no
 * defence in depth behind the route.
 *
 * The READ paths (`ensureCanReadRequest`, `listLeaves`) still use
 * `isReviewer` — narrowing those changes which queue people see and is a
 * separate decision from who may mutate another person's request.
 */
const permissionsOf = async (callerId: Types.ObjectId): Promise<readonly string[]> => {
    const { permissions } = await resolvePermissionsForUser(callerId);
    return permissions;
};

const ensureCanReviewRequest = (
    req: LeaveRequestDocument,
    caller: { id: Types.ObjectId; role: RoleType },
    permissions: readonly string[]
) => {
    if (!callerCan(permissions, PERMISSIONS.LEAVE_REQUEST_APPROVE)) {
        throw AppError.forbidden('Only managers or admins can review leave requests');
    }
    if (caller.id.equals(req.user_id)) {
        throw AppError.forbidden('You cannot review your own leave request');
    }
};

/**
 * Approve/reject authorisation WITH reporting-chain scoping. Admins may
 * review any request; a manager / team-lead may review ONLY their own
 * direct reports' requests (plus the existing role + no-self-review guard).
 */
const assertCanReviewScoped = async (
    req: LeaveRequestDocument,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<void> => {
    const permissions = await permissionsOf(caller.id);
    ensureCanReviewRequest(req, caller, permissions);
    // `system.admin` rather than `role === 'admin'` — same staleness applies
    // to the scoping bypass as to the gate above.
    if (callerCan(permissions, PERMISSIONS.SYSTEM_ADMIN)) return;
    if (!(await isDirectReportOf(req.user_id, caller.id))) {
        throw AppError.forbidden('You can only review leave requests from your direct reports');
    }
};

// ─── Settings / context loaders ───────────────────────────────────────────

interface ApplyContext {
    workingDays: readonly number[];
    holidayDates: ReadonlySet<string>;
    activeTypes: LeaveTypeDocument[];
    typesByCode: Map<LeaveCode | string, LeaveTypeDocument>;
    typesById: Map<string, LeaveTypeDocument>;
    timezone: string;
}

const loadApplyContext = async (spanFrom: string, spanTo: string): Promise<ApplyContext> => {
    // Settings doesn't gate the other two queries — one round trip, not two.
    const [settings, holidays, types] = await Promise.all([
        getOrInitSettings(),
        Holiday.find({ date: { $gte: spanFrom, $lte: spanTo } }).select({ date: 1, _id: 0 }),
        LeaveType.find({ is_active: true }),
    ]);
    const workingDays = settings.work_schedule?.working_days ?? [1, 2, 3, 4, 5];

    return {
        workingDays,
        holidayDates: new Set(holidays.map((h) => h.date)),
        activeTypes: types,
        typesByCode: new Map(types.map((t) => [t.code, t])),
        typesById: new Map(types.map((t) => [t._id.toString(), t])),
        timezone: settings.default_timezone || LEAVE_TIMEZONE,
    };
};

// ─── SL "already used this month" map (engine input) ──────────────────────

/**
 * C4 — SL month attribution. Pre-C4 the helper read each historical
 * request's `start_date.month` ONCE and attributed every stored SL day
 * for that request to that single month. A request spanning Jan 30 →
 * Feb 2 with 1 SL day in Feb got filed as Jan SL usage; the next Feb
 * request then re-claimed its Feb slot, double-spending the cap.
 *
 * Post-C4 we re-derive month attribution by REPLAYING the engine's
 * own chronological first-fit + `slots_per_month` cap algorithm
 * against each historical request's actual working-day enumeration.
 * Requests are processed in `created_at` order so the cap state at
 * each request's apply time is reconstructed, not what the calendar
 * looks like today.
 *
 * Holidays are loaded for the FULL year span of every touched year
 * (not just the requesting leave's span) so historical requests
 * outside the apply context's range are still correctly day-counted.
 */
export const buildSlMonthUsedMap = async (params: {
    user_id: Types.ObjectId;
    sl_type_id: Types.ObjectId;
    yearsTouched: number[];
    workingDays: readonly number[];
    /** Pre-loaded holiday set for the touched-year range. When omitted
     *  the helper loads them itself, bounded by min/max year. */
    holidays?: ReadonlySet<string>;
    /** Default 1 — matches the engine's `slots_per_month` default and
     *  every existing call site (which doesn't override). */
    slotsPerMonth?: number;
}): Promise<Map<string, number>> => {
    const slotsPerMonth = params.slotsPerMonth ?? 1;
    const out = new Map<string, number>();
    if (params.yearsTouched.length === 0) return out;

    // Hydrate holidays for the full year boundaries if not pre-loaded —
    // historical requests may extend beyond the apply context's span.
    // The holiday hydration, the historical-request list, and the
    // forfeiture rows (consumed after the replay loop) are mutually
    // independent — load all three in one round trip.
    const minYear = Math.min(...params.yearsTouched);
    const maxYear = Math.max(...params.yearsTouched);
    const [loadedHolidays, reqs, fft] = await Promise.all([
        params.holidays
            ? Promise.resolve(null)
            : Holiday.find({
                  date: { $gte: `${minYear}-01-01`, $lte: `${maxYear}-12-31` },
              }).select({ date: 1, _id: 0 }),
        // Chronological order so the replay mirrors the engine's allocation
        // at each request's actual apply time. Without this, an earlier
        // request's SL slot would be attributed to a later request that
        // happened to be inserted into Mongo first by happenstance.
        LeaveRequest.find({
            user_id: params.user_id,
            status: { $in: [LEAVE_REQUEST_STATUSES.PENDING, LEAVE_REQUEST_STATUSES.APPROVED] },
            'leave_segments.leave_type_id': params.sl_type_id,
            'leave_segments.year': { $in: params.yearsTouched },
        }).sort({ created_at: 1 }),
        SlMonthlyForfeiture.find({
            user_id: params.user_id,
            year: { $in: params.yearsTouched },
        }),
    ]);
    const holidays = params.holidays ?? new Set((loadedHolidays ?? []).map((h) => h.date));

    for (const r of reqs) {
        // Aggregate this request's SL days by year (engine emits at most
        // one SL segment per year).
        const slByYear = new Map<number, number>();
        for (const seg of r.leave_segments) {
            if (!seg.leave_type_id.equals(params.sl_type_id)) continue;
            if (!params.yearsTouched.includes(seg.year)) continue;
            slByYear.set(seg.year, (slByYear.get(seg.year) ?? 0) + seg.days);
        }
        if (slByYear.size === 0) continue;

        // Enumerate the request's actual working days, then bucket by
        // (year, month).
        const workingDayList = enumerateWorkingDays({
            start_date: r.start_date,
            end_date: r.end_date,
            working_days: params.workingDays,
            holidays,
        });
        const buckets = new Map<number, Map<number, number>>();
        for (const d of workingDayList) {
            const yr = Number.parseInt(d.slice(0, 4), 10);
            const mo = Number.parseInt(d.slice(5, 7), 10);
            const yrBucket = buckets.get(yr) ?? new Map<number, number>();
            yrBucket.set(mo, (yrBucket.get(mo) ?? 0) + 1);
            buckets.set(yr, yrBucket);
        }

        // For each year with stored SL, replay chronological first-fit
        // against the accumulating `out` map. `slRemaining` caps total
        // allocation at the stored segment days; per-month allocation
        // is capped at `slotsPerMonth - already_used` (the engine's
        // exact rule).
        for (const [year, slDays] of slByYear) {
            const yrBucket = buckets.get(year);
            if (!yrBucket) continue;
            let slRemaining = slDays;
            const orderedMonths = Array.from(yrBucket.keys()).sort((a, b) => a - b);
            for (const month of orderedMonths) {
                if (slRemaining <= 0) break;
                const key = `${year}-${month}`;
                const alreadyUsed = out.get(key) ?? 0;
                const monthDayCount = yrBucket.get(month) ?? 0;
                const take = Math.min(slotsPerMonth - alreadyUsed, monthDayCount, slRemaining);
                if (take > 0) {
                    out.set(key, alreadyUsed + take);
                    slRemaining -= take;
                }
            }
        }
    }

    // Forfeitures carry `{year, month}` on the row — additive.
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

/**
 * Freelancers accrue no leave, so `initializeBalancesForUserYear` creates no
 * balance rows for them at all. Without this guard the apply path reached
 * `findOrInitBalance`, found nothing, failed to create anything, and threw
 * `Failed to initialise leave balance row` — a 500 on a request that is
 * simply not applicable to the caller.
 *
 * Called from BOTH entry points rather than one shared funnel because there
 * isn't one: preview and apply each load their own context. Guarding only
 * `applyLeave` would let someone fill in the whole form, see a valid preview,
 * and fail on submit.
 */
const assertOnLeaveScheme = async (userId: Types.ObjectId): Promise<void> => {
    const u = await User.findById(userId)
        .select('internal_profile.employment_type')
        .lean<{ internal_profile?: { employment_type?: string } }>();
    if (u?.internal_profile?.employment_type === EMPLOYMENT_TYPES.FREELANCER) {
        throw AppError.unprocessable(
            'Freelancers are engaged per contract and accrue no leave, so there is no balance to apply against.',
            ERROR_CODES.LEAVE_NOT_APPLICABLE
        );
    }
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
    await assertOnLeaveScheme(caller.id);
    const ctx = await loadApplyContext(body.start_date, body.end_date);
    const requestedType = ctx.typesById.get(body.leave_type_id);
    if (!requestedType) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (!requestedType.is_active) {
        throw AppError.validation('Leave type is inactive');
    }
    const sl = ctx.typesByCode.get(LEAVE_CODES.SL);

    // Enumerate years touched for the SL "already used" probe. The SL
    // replay and the balance snapshot are independent — run them
    // concurrently (same shape as `apply`).
    const span = enumerateYears(body.start_date, body.end_date);
    const [slMonthUsed, availableMap] = await Promise.all([
        sl
            ? buildSlMonthUsedMap({
                  user_id: caller.id,
                  sl_type_id: sl._id,
                  yearsTouched: span,
                  workingDays: ctx.workingDays,
                  // C4 follow-through — DO NOT pass `ctx.holidayDates`.
                  // `loadApplyContext` scopes holidays to THIS leave's
                  // date range, but `buildSlMonthUsedMap` enumerates the
                  // working days of every historical SL request whose
                  // dates may fall outside that span. Letting the helper
                  // self-load holidays (via the `params.holidays`-
                  // undefined branch) gives it the full year boundary
                  // window it needs for correct working-day exclusion.
              })
            : Promise.resolve(new Map<string, number>()),
        // Available snapshot — only hydrate years/types we'll touch.
        loadAvailableMap({
            user_id: caller.id,
            years: span,
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
    // M37 — pre-M37 this was a sequential `for await` loop, so a
    // three-year-spanning preview/apply paid 3× the per-year init
    // latency. The year initialisations are independent (each writes
    // its own (user_id, year) row), so `Promise.all` collapses them
    // into a single tick of network latency.
    //
    // Fast path: the init is `$setOnInsert`-only — it never mutates an
    // existing row — so when every (year × active type) row is already
    // present it is a guaranteed no-op. Read first and only heal when a
    // row is actually missing (new user / new year / newly added type);
    // this turns the hot preview/apply path into a single round trip.
    let rows = await LeaveBalance.find({
        user_id: params.user_id,
        year: { $in: params.years },
    });
    const have = new Set(rows.map((r) => `${r.leave_type_id.toString()}|${r.year}`));
    const missing = params.years.some((y) => params.types.some((t) => !have.has(`${t._id.toString()}|${y}`)));
    if (missing) {
        await Promise.all(params.years.map((y) => initializeBalancesForUserYear({ user_id: params.user_id, year: y })));
        rows = await LeaveBalance.find({
            user_id: params.user_id,
            year: { $in: params.years },
        });
    }
    const out = new Map<string, number>();
    const idToCode = new Map(params.types.map((t) => [t._id.toString(), t.code]));
    // Unlimited types (WFH) always carry a 0 allocation (nothing to track —
    // see `deriveAllocation` in leave-balance.service.ts), so any non-zero
    // request would otherwise read as negative-balance and wrongly flag
    // `requires_additional_approval`. Omitting them from the map entirely
    // means the engine's `available.get(k) !== undefined` guard skips the
    // check for these codes — no cap, so no "insufficient balance" is ever
    // possible.
    const unlimitedIds = new Set(params.types.filter((t) => t.is_unlimited).map((t) => t._id.toString()));
    for (const r of rows) {
        const idStr = r.leave_type_id.toString();
        if (unlimitedIds.has(idStr)) continue;
        const code = idToCode.get(idStr);
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
    caller: { id: Types.ObjectId; role: RoleType; audit?: AuditContext }
): Promise<Record<string, unknown>> => {
    await assertOnLeaveScheme(caller.id);
    const ctx = await loadApplyContext(body.start_date, body.end_date);
    const requestedType = ctx.typesById.get(body.leave_type_id);
    if (!requestedType) {
        throw AppError.notFound('Leave type not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    if (!requestedType.is_active) {
        throw AppError.validation('Leave type is inactive');
    }

    // Date-policy gates ----------------------------------------------------
    // Leave can be applied for ANY date — same-day and backdated included —
    // so an employee can record a last-minute absence (e.g. sick leave taken
    // this morning) and a manager can enter a forgotten leave the next day.
    // The previous backdated-not-allowed + per-type advance-notice gates are
    // intentionally removed; `advance_notice_days` is no longer enforced.

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
                  workingDays: ctx.workingDays,
                  // C4 follow-through — see preview-split for the
                  // explanation; let the helper self-load holidays
                  // across the full year span of historical SL
                  // requests, not just THIS leave's date range.
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

    // H2 — close the assertNoOverlap race with a compensating re-check
    // AFTER the insert. Pre-H2 two concurrent applies could both pass
    // the initial overlap check (separate Mongo snapshots) and both
    // commit overlapping rows. Wrapping in `withTransaction` does NOT
    // close this race in Mongo because the two writes target different
    // documents and don't trip any unique-index conflict; transactions
    // only detect document-level write conflicts, not logical overlap.
    // The right fix is to re-check post-insert (excluding our own row);
    // if a competing row now exists, we lost the race — delete our
    // insert + release reservations + throw LEAVE_OVERLAP. Either both
    // applies see each other and both fail (user retries one), or
    // exactly one wins. Both outcomes are correct; the pre-H2 silent
    // double-insert outcome was not.
    try {
        await assertNoOverlap({
            user_id: caller.id,
            start_date: body.start_date,
            end_date: body.end_date,
            excludeId: created._id,
        });
    } catch (err) {
        await LeaveRequest.deleteOne({ _id: created._id });
        await releaseReservations({ user_id: caller.id, segments });
        throw err;
    }

    // H4 — audit the initial submission. Pre-H4 the lifecycle audits
    // only fired on approve/reject/cancel; the CREATION of the row
    // was invisible to the forensic trail. Mirrors the
    // approve/reject/cancel audit shape.
    if (caller.audit) {
        await recordAudit(caller.audit, {
            action: AUDIT_ACTIONS.LEAVE_APPLY,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_REQUEST, id: created._id },
            after: {
                status: created.status,
                start_date: created.start_date,
                end_date: created.end_date,
                total_days: created.total_days,
                requires_additional_approval: created.requires_additional_approval,
            },
            metadata: {
                user_id: created.user_id.toString(),
                requested_leave_type_id: created.requested_leave_type_id.toString(),
                is_half_day: created.is_half_day,
                half_day_slot: created.half_day_slot,
                segments_count: created.leave_segments.length,
            },
        });
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
        reason: body.reason,
        is_half_day: body.is_half_day ?? false,
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
            // Every limited type must have enough room — no leave can be taken
            // into a negative balance (the prior CL "go negative with manager
            // override" path is removed). Unlimited types skip the guard.
            if (!lt.is_unlimited) {
                filter.available = { $gte: seg.days };
            }

            const updated = await LeaveBalance.findOneAndUpdate(
                filter,
                { $inc: { pending: seg.days, available: -seg.days } },
                { new: true }
            );
            if (!updated) {
                // Either the row is gone or balance is short.
                if (lt.is_unlimited) {
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

const releaseReservations = async (params: {
    user_id: Types.ObjectId;
    segments: LeaveSegment[];
    session?: import('mongoose').ClientSession;
}) => {
    for (const seg of params.segments) {
        const filter = {
            user_id: params.user_id,
            leave_type_id: seg.leave_type_id,
            year: seg.year,
        };
        const update = { $inc: { pending: -seg.days, available: seg.days } };
        // Omit `session` entirely when no transaction is active so tests
        // that strict-match the third arg via `toHaveBeenNthCalledWith`
        // keep the pre-C2 call shape. Mirrors the conditional pattern
        // used inside `approveLeave`'s transaction at L729-740.
        if (params.session) {
            await LeaveBalance.updateOne(filter, update, { session: params.session });
        } else {
            await LeaveBalance.updateOne(filter, update);
        }
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

/**
 * Per-page user-display hydration — mirrors the audit-log /attendance
 * pattern so the manager queue can render names without N+1 lookups
 * against `/users/:id`.
 *
 * `full_name` is nullable to cover the rare "user hard-deleted since
 * the leave row was written" case; we preserve the id so the FE can
 * still link back.
 */
interface LeaveUserDisplay {
    id: string;
    full_name: string | null;
}

const loadLeaveUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, LeaveUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const rows = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(rows.map((r) => [r._id.toString(), { id: r._id.toString(), full_name: r.full_name }]));
};

export const listLeaves = async (
    query: ListLeavesQuery,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = {};
    if (isReviewer(caller.role)) {
        if (caller.role === ROLES.ADMIN) {
            // Admin sees the whole queue (minus their own — a reviewer can
            // never approve their OWN request, so it never appears here).
            filter.user_id = query.user_id ? new Types.ObjectId(query.user_id) : { $ne: caller.id };
        } else {
            // Manager / Team Lead — scoped to their OWN direct reports, so a
            // request routes to the employee's reporting manager, not to every
            // reviewer. An empty `$in` (no reports / drilling into someone else's
            // report) simply returns nothing.
            const reportIds = await directReportIdsOf(caller.id);
            if (query.user_id) {
                const wanted = new Types.ObjectId(query.user_id);
                // `|| wanted.equals(caller.id)` — nobody is their own direct
                // report, so without this a reviewer asking for THEMSELVES
                // fell into the `$in: []` branch and saw nothing. Their own
                // "My leaves" tab (which pins `user_id` to the caller) and
                // the Slack Home "my leaves" card both came up empty while
                // the same request sat pending in the admin queue.
                //
                // This widens nothing: every employee can already read their
                // own requests via the `else` branch below, so a reviewer
                // seeing their own is strictly less access than the role they
                // were promoted from. The reports check still governs
                // everyone ELSE.
                const allowed = wanted.equals(caller.id) || reportIds.some((id) => id.equals(wanted));
                filter.user_id = allowed ? wanted : { $in: [] };
            } else {
                // Deliberately NOT including self here: the unfiltered list is
                // the approvals queue, and you cannot approve your own request.
                filter.user_id = { $in: reportIds };
            }
        }
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
        // Newest SUBMISSION first. This used to sort by `start_date`, which
        // ordered the queue by when leave *begins* — so a request filed this
        // morning for next week sat below one filed last month for next
        // year, and a reviewer opening the queue didn't see what just came
        // in. `_id` breaks ties within the same millisecond and keeps
        // pagination stable.
        LeaveRequest.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        LeaveRequest.countDocuments(filter),
    ]);

    const cache = new Map<string, LeaveTypeDocument>();
    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const [userMap, data] = await Promise.all([
        loadLeaveUserDisplays(userIds),
        Promise.all(rows.map((r) => toRequestPublic(r, cache))),
    ]);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const row = data[i];
        if (!row) continue;
        row.user = userMap.get(r.user_id.toString()) ?? {
            id: r.user_id.toString(),
            full_name: null,
        };
    }
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
    await assertCanReviewScoped(existing, caller);

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
            throw AppError.conflict('Leave request is no longer pending', ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING);
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

        // Comp-off unification: a comp-off leave draws down the comp-off LEDGER
        // lots FIFO (oldest-expiring first) so the ledger + expiry reflect the
        // spend — the mirror above stays the apply-gate. The apply-time reserve
        // guarantees the lots cover `total_days`, so this can't run short.
        const requestedTypeQuery = LeaveType.findById(u.requested_leave_type_id).select('code');
        const requestedType = session ? await requestedTypeQuery.session(session) : await requestedTypeQuery;
        if (requestedType?.code === LEAVE_CODES.COMP_OFF) {
            await consumeCompOffLots(
                {
                    user_id: u.user_id,
                    days: u.total_days,
                    source_type: COMP_OFF_SOURCES.LEAVE_REQUEST,
                    source_ref_id: u._id,
                    remarks: `Comp-off leave ${u.start_date}${u.end_date !== u.start_date ? ` – ${u.end_date}` : ''}`,
                    created_by: caller.id,
                },
                session
            );
            await resyncCompOff(u.user_id, session);
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
        reason: req.reason,
        is_half_day: req.is_half_day,
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
    await assertCanReviewScoped(existing, caller);

    // C2 — status transition + `pending → 0` refunds are atomic. Pre-C2
    // the PENDING→REJECTED flip and the per-segment refund were
    // separate writes; a crash between them left the request rejected
    // but balance still in `pending`, silently consuming entitlement.
    // Mirrors the `approveLeave` pattern at L702.
    const updated = await withTransaction(async (session) => {
        const findOpts = session ? { new: true, session } : { new: true };

        const u = await LeaveRequest.findOneAndUpdate(
            { _id: existing._id, status: LEAVE_REQUEST_STATUSES.PENDING },
            {
                $set: {
                    status: LEAVE_REQUEST_STATUSES.REJECTED,
                    approver_id: caller.id,
                    approver_remarks: body.approver_remarks,
                    acted_at: new Date(),
                },
            },
            findOpts
        );
        if (!u) {
            throw AppError.conflict('Leave request is no longer pending', ERROR_CODES.CORRECTION_REQUEST_NOT_PENDING);
        }

        // Refund pending → 0 (no `used` change since it never approved).
        await releaseReservations({
            user_id: u.user_id,
            segments: u.leave_segments,
            session: session ?? undefined,
        });
        return u;
    });

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

    // Self can cancel own — always, no permission needed, or nobody could
    // withdraw their own request.
    //
    // Cancelling SOMEONE ELSE's goes through the same guard as approve and
    // reject: `leave_request.approve` plus reporting-chain scoping, with
    // `system.admin` bypassing the scope. Deliberately the SAME function
    // rather than a second copy of the rule — cancel used to require the
    // permission but no scoping, so a reviewer could cancel a request they
    // were not allowed to approve. Reusing the guard also means cancel can
    // never drift from review again.
    //
    // The self-review check inside it cannot fire here: this branch only runs
    // when the caller is NOT the owner.
    if (!caller.id.equals(existing.user_id)) {
        await assertCanReviewScoped(existing, caller);
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
    // C2 — status transition + balance refunds are atomic. Pre-C2 the
    // status flip and the per-segment refund were separate writes; a
    // crash between them left the request cancelled but balance still
    // marked `used` (after-approved cancel) or `pending`
    // (pending cancel), silently inflating used / pending counters.
    // Mirrors the `approveLeave` / `rejectLeave` pattern.
    const updated = await withTransaction(async (session) => {
        const findOpts = session ? { new: true, session } : { new: true };

        const u = await LeaveRequest.findOneAndUpdate(
            { _id: existing._id, status: expectedStatus },
            {
                $set: {
                    status: LEAVE_REQUEST_STATUSES.CANCELLED,
                    cancelled_at: new Date(),
                    cancelled_by: caller.id,
                    cancellation_reason: body.cancellation_reason,
                },
            },
            findOpts
        );
        if (!u) {
            throw AppError.conflict(
                'Leave request status changed concurrently — refresh and retry',
                ERROR_CODES.CONCURRENT_UPDATE_CONFLICT
            );
        }

        // Refund per-segment to the original (type, year) row.
        if (expectedStatus === LEAVE_REQUEST_STATUSES.APPROVED) {
            for (const seg of u.leave_segments) {
                const filter = {
                    user_id: u.user_id,
                    leave_type_id: seg.leave_type_id,
                    year: seg.year,
                };
                const update = { $inc: { used: -seg.days, available: seg.days } };
                if (session) {
                    await LeaveBalance.updateOne(filter, update, { session });
                } else {
                    await LeaveBalance.updateOne(filter, update);
                }
            }
            // Comp-off unification: restore the exact lots this leave drew down
            // (preserving their original expiry), reversing the `consumed` row.
            const requestedTypeQuery = LeaveType.findById(u.requested_leave_type_id).select('code');
            const requestedType = session ? await requestedTypeQuery.session(session) : await requestedTypeQuery;
            if (requestedType?.code === LEAVE_CODES.COMP_OFF) {
                await refundConsumedLots(
                    { source_type: COMP_OFF_SOURCES.LEAVE_REQUEST, source_ref_id: u._id },
                    session
                );
                await resyncCompOff(u.user_id, session);
            }
        } else {
            // Pending → just release the reservation.
            await releaseReservations({
                user_id: u.user_id,
                segments: u.leave_segments,
                session: session ?? undefined,
            });
        }
        return u;
    });

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

    // Hydrate leave-type info (via toRequestPublic) AND user display so the
    // FE calendar can render real names + type codes instead of "…<id>".
    // Same shape the list endpoint stamps, so the FE consumer is identical.
    //
    // Additionally stamp `display_end_date` — the LAST WORKING DAY in
    // [start_date, end_date]. The bar in the FE calendar uses this as the
    // visual endDate so a Thu→Sat request shows a 2-day bar (Thu–Fri) that
    // matches the `total_days` count instead of visually spanning the
    // weekend cells where nothing was consumed.
    const cache = new Map<string, LeaveTypeDocument>();
    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const settings = await getOrInitSettings();
    const workingDays = settings.work_schedule?.working_days ?? [1, 2, 3, 4, 5];
    // Holiday window spans the union of every row's range so we don't miss
    // holidays that fall inside a leave but outside the visible month.
    const spanFrom = rows.reduce((acc, r) => (acc === '' || r.start_date < acc ? r.start_date : acc), '' as string);
    const spanTo = rows.reduce((acc, r) => (acc === '' || r.end_date > acc ? r.end_date : acc), '' as string);
    const holidayRows =
        spanFrom && spanTo
            ? await Holiday.find({ date: { $gte: spanFrom, $lte: spanTo } }).select({
                  date: 1,
                  _id: 0,
              })
            : [];
    const holidaySet = new Set(holidayRows.map((h) => h.date));

    const lastWorkingDay = (startIso: string, endIso: string): string => {
        // Walk backward from endIso, skipping non-working weekdays + holidays.
        // Return the original end if no working day exists in the range
        // (shouldn't happen — apply validates total_days > 0 — but defensive).
        const [sy, sm, sd] = startIso.split('-').map(Number);
        const startMs = new Date(sy!, (sm ?? 1) - 1, sd!).getTime();
        const [ey, em, ed] = endIso.split('-').map(Number);
        const cursor = new Date(ey!, (em ?? 1) - 1, ed!);
        const pad = (n: number) => String(n).padStart(2, '0');
        while (cursor.getTime() >= startMs) {
            const dow = cursor.getDay();
            const iso = `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`;
            if (workingDays.includes(dow) && !holidaySet.has(iso)) return iso;
            cursor.setDate(cursor.getDate() - 1);
        }
        return endIso;
    };

    const [userMap, data] = await Promise.all([
        loadLeaveUserDisplays(userIds),
        Promise.all(rows.map((r) => toRequestPublic(r, cache))),
    ]);
    for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        if (!r) continue;
        const row = data[i];
        if (!row) continue;
        row.user = userMap.get(r.user_id.toString()) ?? {
            id: r.user_id.toString(),
            full_name: null,
        };
        row.display_end_date = lastWorkingDay(r.start_date, r.end_date);
    }
    return data;
};
