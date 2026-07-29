import { Types, type ClientSession } from 'mongoose';

import { LeaveBalance, type LeaveBalanceDocument, recomputeAvailable } from '../models/leave-balance.model.js';
import { LeaveType, type LeaveTypeDocument } from '../models/leave-type.model.js';
import { SlMonthlyForfeiture } from '../models/sl-monthly-forfeiture.model.js';
import { User } from '../models/user.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { LEAVE_CODES, PRO_RATA_STRATEGIES, type ProRataStrategy } from '../constants/leave.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import { scopedUserIdFilter } from './reporting-scope.service.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import dayjs, { DEFAULT_TIMEZONE } from '../utils/date.js';
import logger from '../utils/logger.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type {
    AdjustLeaveBalanceBody,
    InitializeYearBody,
    ListLeaveBalancesQuery,
} from '../validators/leave-balance.validator.js';

/**
 * Leave-balance service (API_Contract.md §5.2, Data_Model.md §3.2).
 *
 * Three responsibilities:
 *  1. Maintain a balance row per `(user, leave_type, year)` via upsert.
 *  2. Compute the right `allocated` value at row-creation time, applying
 *     the type's `pro_rata_on_join` strategy + the user's `date_of_joining`.
 *  3. Surface read/adjust APIs for the FE and admin consoles.
 *
 * The atomic conditional update used by the apply-flow lives in
 * `leave-request.service.ts` so the read-only `/me` and `/list` endpoints
 * here stay simple.
 */

type Filter = Record<string, unknown>;

// ─── Allocation maths ─────────────────────────────────────────────────────

/**
 * Round to nearest 0.5 — the only legal half-day step in the leave engine.
 * `Math.round` rounds half-up; we use that for parity with the plan's
 * `round_half(15 × 6/12) = 7.5` example.
 */
export const roundHalf = (n: number): number => Math.round(n * 2) / 2;

/**
 * Compute the annual allocation for a given user × type × target year.
 *
 *  - `is_unlimited` / `is_earned` / `is_event_based` types → `0` (no annual
 *    allocation; balance comes from another mechanism).
 *  - User joined **before** target year → full `default_allocation_days`.
 *  - User joins **in** the target year → apply `pro_rata_on_join`:
 *      - `by_months_remaining` (CL) → `round_half(default × (13 − M)/12)`.
 *      - `sl_monthly_buckets`   (SL) → `13 − M` (cap one bucket per month).
 *      - `none`                       → `default_allocation_days`.
 *  - User joins **after** target year → `0` (employee not on payroll yet).
 *
 * The pure function shape is convenient for unit tests in 10.2.
 */
export const computeAllocation = (params: {
    leaveType: Pick<
        LeaveTypeDocument,
        'default_allocation_days' | 'is_unlimited' | 'is_earned' | 'is_event_based' | 'pro_rata_on_join'
    >;
    joiningYear: number;
    joiningMonth: number; // 1..12
    targetYear: number;
}): number => {
    const lt = params.leaveType;
    if (lt.is_unlimited || lt.is_earned || lt.is_event_based) return 0;

    const annual = lt.default_allocation_days || 0;
    if (annual === 0) return 0;

    if (params.joiningYear < params.targetYear) return annual;
    if (params.joiningYear > params.targetYear) return 0;

    const monthsRemaining = 13 - params.joiningMonth;
    if (monthsRemaining <= 0) return 0;

    const strategy: ProRataStrategy = lt.pro_rata_on_join;
    if (strategy === PRO_RATA_STRATEGIES.NONE) return annual;
    if (strategy === PRO_RATA_STRATEGIES.SL_MONTHLY_BUCKETS) return monthsRemaining;
    if (strategy === PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING) return roundHalf((annual * monthsRemaining) / 12);

    return annual;
};

const parseJoiningDate = (date_of_joining: string): { year: number; month: number } => {
    const [y, m] = date_of_joining.split('-');
    return { year: Number.parseInt(y, 10), month: Number.parseInt(m, 10) };
};

// ─── Per-user, per-year initialization ────────────────────────────────────

/**
 * Insert (or top-up) one balance row per active leave type for the given
 * user/year. Idempotent — uses the unique compound index as the upsert key
 * with `$setOnInsert` so an existing row is never overwritten.
 *
 * Returns the count of rows that were freshly inserted; the rest were
 * already present.
 */
export const initializeBalancesForUserYear = async (params: {
    user_id: Types.ObjectId;
    year: number;
    /** Optional pre-fetched user (saves a roundtrip when called from createUser). */
    joining_year?: number;
    joining_month?: number;
    /** When provided, every read + write enrolls in the caller's
     *  transaction. Used by `createUser` to make user + balance
     *  rows atomic (H1). Standalone callers (cron, self-heal,
     *  manual init endpoint) leave it undefined. */
    session?: ClientSession;
}): Promise<number> => {
    let joining_year = params.joining_year;
    let joining_month = params.joining_month;

    // Chain `.session()` only when one is provided. Tests mock the
    // Mongoose models with bare stubs that don't expose `.session()`,
    // so an unconditional chain breaks them; the production code path
    // (where Mongoose returns real Query objects) supports both forms.
    if (joining_year === undefined || joining_month === undefined) {
        const userQuery = User.findById(params.user_id).select('role status internal_profile.date_of_joining');
        if (params.session) userQuery.session(params.session);
        const u = await userQuery;
        if (!u) return 0;
        // Clients don't apply for leave.
        if (u.role === ROLES.CLIENT) return 0;
        const doj = u.internal_profile?.date_of_joining;
        if (!doj) {
            // No joining date on file (e.g. seeded admin accounts that never
            // had an internal_profile). Returning 0 here used to leave the user
            // with zero balance rows, so apply-leave then failed with a
            // confusing "Failed to initialise leave balance row" 500 from
            // `findOrInitBalance`. Fall back to the start of the target year so
            // they get a full-year allocation and can apply leave.
            logger.warn(
                { user_id: params.user_id.toString(), year: params.year },
                'Leave balance init — user has no date_of_joining; defaulting to start of target year'
            );
            joining_year = params.year;
            joining_month = 1;
        } else {
            const parsed = parseJoiningDate(doj);
            joining_year = parsed.year;
            joining_month = parsed.month;
        }
    }

    const typeQuery = LeaveType.find({ is_active: true });
    if (params.session) typeQuery.session(params.session);
    const types = await typeQuery;
    let inserted = 0;

    for (const lt of types) {
        const allocated = computeAllocation({
            leaveType: lt,
            joiningYear: joining_year,
            joiningMonth: joining_month,
            targetYear: params.year,
        });

        const seedDoc = {
            user_id: params.user_id,
            leave_type_id: lt._id,
            year: params.year,
            allocated,
            carried_forward: 0,
            used: 0,
            pending: 0,
            adjusted: 0,
            monthly_forfeited: 0,
            available: allocated,
        };

        const result = await LeaveBalance.updateOne(
            { user_id: params.user_id, leave_type_id: lt._id, year: params.year },
            { $setOnInsert: seedDoc },
            { upsert: true, session: params.session }
        );
        if (result.upsertedCount && result.upsertedCount > 0) inserted += 1;
    }

    return inserted;
};

/**
 * Year-rollover entry point — initializes balances for every active
 * non-client user for the target year. Used by the cron and the manual
 * `POST /leave-balances/initialize-year` endpoint. Returns per-user
 * counts so the response is auditable.
 */
export const initializeYearForAllUsers = async (
    body: InitializeYearBody
): Promise<{ year: number; processed_users: number; total_inserted: number }> => {
    const users = await User.find({
        status: USER_STATUSES.ACTIVE,
        role: { $ne: ROLES.CLIENT },
        'internal_profile.date_of_joining': { $exists: true, $ne: null },
    }).select('_id internal_profile.date_of_joining');

    let totalInserted = 0;
    for (const u of users) {
        const doj = u.internal_profile?.date_of_joining;
        if (!doj) continue;
        const { year, month } = parseJoiningDate(doj);
        totalInserted += await initializeBalancesForUserYear({
            user_id: u._id,
            year: body.year,
            joining_year: year,
            joining_month: month,
        });
    }

    return {
        year: body.year,
        processed_users: users.length,
        total_inserted: totalInserted,
    };
};

// ─── GET /leave-balances/me + GET /leave-balances ────────────────────────

const toBalancePublic = async (
    b: LeaveBalanceDocument,
    typeCache: Map<string, LeaveTypeDocument>
): Promise<Record<string, unknown>> => {
    const lt = typeCache.get(b.leave_type_id.toString());
    const baseAvail = recomputeAvailable(b);
    const out: Record<string, unknown> = {
        id: b._id.toString(),
        user_id: b.user_id.toString(),
        leave_type: lt
            ? { id: lt._id.toString(), code: lt.code, name: lt.name, is_unlimited: lt.is_unlimited }
            : { id: b.leave_type_id.toString() },
        year: b.year,
        allocated: b.allocated,
        carried_forward: b.carried_forward,
        used: b.used,
        pending: b.pending,
        adjusted: b.adjusted,
        monthly_forfeited: b.monthly_forfeited,
        available: baseAvail,
    };

    // Append `sl_monthly_detail` for any type that defines a monthly cap.
    if (lt && lt.monthly_cap !== null && lt.monthly_cap !== undefined) {
        // H1 — month must be derived in the org's business timezone (IST).
        // Pre-H1 used `getUTCMonth()`, which crossed the month boundary 5h30m
        // ahead of IST and caused the dashboard / list endpoints to look up
        // the wrong forfeiture row in the late-night IST window between IST
        // midnight and UTC midnight on the 1st of each month.
        const month = dayjs().tz(DEFAULT_TIMEZONE).month() + 1;
        const forfeited = await SlMonthlyForfeiture.findOne({
            user_id: b.user_id,
            year: b.year,
            month,
        });
        // For v1, SL monthly cap = 1, and a single segment per month → either
        // the cap is hit (forfeited or used) or it isn't. The `current_month_used`
        // computation across `leave_segments` lives in `leave-request.service.ts`
        // and would be expensive to reissue per balance row, so we surface
        // forfeiture state here and let the apply-flow re-derive at write-time.
        out.sl_monthly_detail = {
            current_month_used: forfeited ? lt.monthly_cap : 0,
            current_month_available: forfeited ? 0 : lt.monthly_cap,
            cap_per_month: lt.monthly_cap,
        };
    }

    return out;
};

const buildTypeCache = async (balances: LeaveBalanceDocument[]): Promise<Map<string, LeaveTypeDocument>> => {
    const ids = Array.from(new Set(balances.map((b) => b.leave_type_id.toString()))).map((s) => new Types.ObjectId(s));
    if (ids.length === 0) return new Map();
    const types = await LeaveType.find({ _id: { $in: ids } });
    return new Map(types.map((t) => [t._id.toString(), t]));
};

// H1 — "current year" follows the IST business calendar so a request made
// just after IST midnight on Jan 1 doesn't read from the previous year's
// balance rows during the 5h30m window before UTC rolls over.
const currentYear = (): number => dayjs().tz(DEFAULT_TIMEZONE).year();

export const listOwnBalances = async (user_id: Types.ObjectId, year?: number): Promise<Record<string, unknown>[]> => {
    const targetYear = year ?? currentYear();
    // Self-heal: if balances haven't been initialized for the requested year
    // (e.g. user predates the leave module), do it now. No-op if rows exist.
    await initializeBalancesForUserYear({ user_id, year: targetYear });

    const rows = await LeaveBalance.find({ user_id, year: targetYear }).sort({
        leave_type_id: 1,
    });
    const cache = await buildTypeCache(rows);
    return Promise.all(rows.map((r) => toBalancePublic(r, cache)));
};

/**
 * Per-page user-display hydration — mirrors the audit-log / attendance /
 * leaves pattern. Lets the admin team-balances UI render names without
 * N+1 lookups against `/users/:id`.
 */
interface BalanceUserDisplay {
    id: string;
    full_name: string | null;
}

const loadBalanceUserDisplays = async (ids: Types.ObjectId[]): Promise<Map<string, BalanceUserDisplay>> => {
    if (ids.length === 0) return new Map();
    const users = await User.find({ _id: { $in: ids } })
        .select('_id full_name')
        .lean<{ _id: Types.ObjectId; full_name: string }[]>();
    return new Map(users.map((u) => [u._id.toString(), { id: u._id.toString(), full_name: u.full_name }]));
};

export const listBalances = async (
    query: ListLeaveBalancesQuery,
    caller: { id: Types.ObjectId; role: RoleType }
): Promise<Record<string, unknown>[]> => {
    const filter: Filter = {};
    const targetYear = query.year ?? currentYear();
    filter.year = targetYear;

    // Reporting-chain scoping — Admin sees all; Manager/Team-Lead only their
    // direct reports. `undefined` → no user_id restriction (admin, no drill).
    const scopedUid = await scopedUserIdFilter(caller, query.user_id);
    if (scopedUid !== undefined) filter.user_id = scopedUid;

    if (query.user_id && scopedUid instanceof Types.ObjectId) {
        // Self-heal only when drilling into a specific, allowed user.
        await initializeBalancesForUserYear({ user_id: scopedUid, year: targetYear });
    }

    const rows = await LeaveBalance.find(filter).sort({ user_id: 1, leave_type_id: 1 });
    const userIds = Array.from(new Set(rows.map((r) => r.user_id.toString()))).map((id) => new Types.ObjectId(id));
    const [cache, userMap, data] = await Promise.all([
        buildTypeCache(rows),
        loadBalanceUserDisplays(userIds),
        Promise.resolve(rows),
    ]);
    const out = await Promise.all(data.map((r) => toBalancePublic(r, cache)));
    for (let i = 0; i < data.length; i++) {
        const r = data[i];
        const o = out[i];
        if (!r || !o) continue;
        o.user = userMap.get(r.user_id.toString()) ?? {
            id: r.user_id.toString(),
            full_name: null,
        };
    }
    return out;
};

// ─── PATCH /leave-balances/:id ────────────────────────────────────────────

export const adjustBalance = async (
    id: Types.ObjectId,
    body: AdjustLeaveBalanceBody,
    updated_by: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const row = await LeaveBalance.findById(id);
    if (!row) {
        throw AppError.notFound('Leave balance not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }

    // H3 — capture the counters that actually move on adjust so the
    // audit row's before/after diff is meaningful. The full balance row
    // would also work but contains plenty of fields adjust never touches
    // (allocated, carried_forward, used, pending, monthly_forfeited);
    // pinning the diff to {adjusted, available} keeps the timeline
    // readable in the future Step-31 audit UI.
    const before = {
        adjusted: row.adjusted ?? 0,
        available: row.available,
    };

    row.adjusted = (row.adjusted || 0) + body.delta;
    row.available = recomputeAvailable(row);
    row.updated_by = updated_by;
    await row.save();

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.LEAVE_BALANCE_ADJUST,
            target: { kind: AUDIT_TARGET_KINDS.LEAVE_BALANCE, id: row._id },
            before,
            after: {
                adjusted: row.adjusted,
                available: row.available,
            },
            metadata: {
                // Pre-H3 the validator demanded a `reason >= 3 chars` but
                // the service silently dropped it. The audit row is the
                // only place that text ever lands, so we surface it here.
                reason: body.reason,
                delta: body.delta,
                user_id: row.user_id.toString(),
                leave_type_id: row.leave_type_id.toString(),
                year: row.year,
            },
        });
    }

    const lt = await LeaveType.findById(row.leave_type_id);
    return toBalancePublic(row, new Map(lt ? [[lt._id.toString(), lt]] : []));
};

// ─── Internal helpers used by the request engine ──────────────────────────

export const findOrInitBalance = async (params: {
    user_id: Types.ObjectId;
    leave_type_id: Types.ObjectId;
    year: number;
}): Promise<LeaveBalanceDocument> => {
    let row = await LeaveBalance.findOne({
        user_id: params.user_id,
        leave_type_id: params.leave_type_id,
        year: params.year,
    });
    if (row) return row;

    // Init the entire year row so every type gets a uniform shape.
    await initializeBalancesForUserYear({ user_id: params.user_id, year: params.year });
    row = await LeaveBalance.findOne({
        user_id: params.user_id,
        leave_type_id: params.leave_type_id,
        year: params.year,
    });
    if (!row) {
        throw AppError.internal('Failed to initialise leave balance row');
    }
    return row;
};

/**
 * SL monthly-cap check helper — used by the segment engine.
 * Returns `true` if the user has already exhausted their SL slot for the
 * given month (either via a previously approved/pending segment or via
 * an end-of-month forfeiture). Engine then routes the day to CL instead.
 *
 * The "used via existing segments" portion is computed by the engine at
 * apply-time directly against `leave_requests`; this helper only owns the
 * forfeiture lookup since it sits closer to the balance domain.
 */
export const isSlMonthForfeited = async (params: {
    user_id: Types.ObjectId;
    year: number;
    month: number;
}): Promise<boolean> => {
    const f = await SlMonthlyForfeiture.findOne({
        user_id: params.user_id,
        year: params.year,
        month: params.month,
    });
    return !!f;
};

void LEAVE_CODES;
