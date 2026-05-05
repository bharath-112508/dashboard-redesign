/**
 * Leave-management constants — Step 10
 * (`Company_Management_Plan.md §2`, `Data_Model.md §3`, `API_Contract.md §5`).
 *
 * Authorization (Step 47): every endpoint is gated at the route layer
 * via `requirePermission(...)` — see `permissions.ts` for the catalog
 * (`leave_type.read/write`, `leave_balance.read_team/adjust`,
 * `leave_request.write/approve/read_team`, `comp_off.read/write`).
 * The legacy `*_ROLES` allowlist constants this file used to export
 * have been removed; service-layer scoping is in `leave-request.service.ts`
 * (`isReviewer`).
 *
 * Half-day rule (`Data_Model.md §3.3`): half-day requests must span exactly
 * one calendar day. Validator rejects any half-day with start_date != end_date.
 *
 * Year-spanning: a single request can be split into multiple
 * `(leave_type_id, year, days)` segments — see `leave-segment.engine.ts`.
 */

// ─── Default codes & enums ─────────────────────────────────────────────────

export const LEAVE_CODES = {
    CL: 'CL',
    SL: 'SL',
    MATERNITY: 'MATERNITY',
    PATERNITY: 'PATERNITY',
    WFH: 'WFH',
    COMP_OFF: 'COMP_OFF',
    UNPAID: 'UNPAID',
} as const;
export type LeaveCode = (typeof LEAVE_CODES)[keyof typeof LEAVE_CODES];
export const LEAVE_CODE_VALUES = Object.values(LEAVE_CODES) as readonly string[];

export const PRO_RATA_STRATEGIES = {
    NONE: 'none',
    BY_MONTHS_REMAINING: 'by_months_remaining',
    SL_MONTHLY_BUCKETS: 'sl_monthly_buckets',
} as const;
export type ProRataStrategy = (typeof PRO_RATA_STRATEGIES)[keyof typeof PRO_RATA_STRATEGIES];

export const LEAVE_REQUEST_STATUSES = {
    PENDING: 'pending',
    APPROVED: 'approved',
    REJECTED: 'rejected',
    CANCELLED: 'cancelled',
} as const;
export type LeaveRequestStatus = (typeof LEAVE_REQUEST_STATUSES)[keyof typeof LEAVE_REQUEST_STATUSES];

export const HALF_DAY_SLOTS = {
    FIRST_HALF: 'first_half',
    SECOND_HALF: 'second_half',
} as const;
export type HalfDaySlot = (typeof HALF_DAY_SLOTS)[keyof typeof HALF_DAY_SLOTS];

export const COMP_OFF_TYPES = {
    EARNED: 'earned',
    CONSUMED: 'consumed',
} as const;
export type CompOffType = (typeof COMP_OFF_TYPES)[keyof typeof COMP_OFF_TYPES];

export const COMP_OFF_SOURCES = {
    ATTENDANCE_OVERTIME: 'attendance_overtime',
    LEAVE_REQUEST: 'leave_request',
    ADMIN_ADJUSTMENT: 'admin_adjustment',
} as const;
export type CompOffSource = (typeof COMP_OFF_SOURCES)[keyof typeof COMP_OFF_SOURCES];

export const SL_FORFEITURE_REASONS = {
    UNUSED_MONTHLY_ALLOCATION: 'unused_monthly_allocation',
    ADMIN_OVERRIDE: 'admin_override',
} as const;
export type SlForfeitureReason = (typeof SL_FORFEITURE_REASONS)[keyof typeof SL_FORFEITURE_REASONS];

// ─── Default seed values for `leave_types` (Data_Model §3.1, §2.1.1) ───────
// Mirrors the table in the plan exactly. Re-applied on every boot via
// `seedLeaveTypes` (idempotent — uses `code` as the upsert key).

export const LEAVE_TYPE_SEEDS: ReadonlyArray<{
    code: LeaveCode;
    name: string;
    default_allocation_days: number;
    carry_forward: boolean;
    carry_forward_cap: number | null;
    monthly_cap: number | null;
    monthly_forfeiture: boolean;
    is_unlimited: boolean;
    is_earned: boolean;
    is_event_based: boolean;
    pro_rata_on_join: ProRataStrategy;
    supports_half_day: boolean;
    advance_notice_days: number;
    resets_yearly: boolean;
}> = [
    {
        code: LEAVE_CODES.CL,
        name: 'Casual Leave',
        default_allocation_days: 15,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.BY_MONTHS_REMAINING,
        supports_half_day: true,
        advance_notice_days: 14,
        resets_yearly: true,
    },
    {
        code: LEAVE_CODES.SL,
        name: 'Sick Leave',
        default_allocation_days: 12,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: 1,
        // Policy update: SL accrues 1/month and **carries over within
        // the same calendar year** — an unused January bucket stays
        // available through Dec 31. The previous `monthly_forfeiture:
        // true` setting forfeited unused buckets at the end of each
        // month (an unused Jan day was lost on Feb 1), which the
        // business judged too punitive. Year-end reset still applies
        // (`resets_yearly: true` below + the leave-year-rollover cron)
        // — anything left on Dec 31 does NOT roll into next year.
        //
        // Mechanics: the `slMonthlyForfeitureJob` cron's findOne is
        // gated on `monthly_forfeiture: true`, so flipping this flag
        // turns the cron into a no-op for SL automatically — no cron
        // edit needed. The cron stays in place so any future leave
        // type that opts back in (`monthly_forfeiture: true`) gets
        // the same monthly-bucket treatment.
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.SL_MONTHLY_BUCKETS,
        supports_half_day: true,
        advance_notice_days: 0,
        resets_yearly: true,
    },
    {
        code: LEAVE_CODES.MATERNITY,
        name: 'Maternity Leave',
        default_allocation_days: 180,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: true,
        pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
        supports_half_day: false,
        advance_notice_days: 0,
        resets_yearly: false,
    },
    {
        code: LEAVE_CODES.PATERNITY,
        name: 'Paternity Leave',
        default_allocation_days: 30,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: true,
        pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
        supports_half_day: false,
        advance_notice_days: 0,
        resets_yearly: false,
    },
    {
        code: LEAVE_CODES.WFH,
        name: 'Work From Home',
        default_allocation_days: 0,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: true,
        is_earned: false,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
        supports_half_day: false,
        advance_notice_days: 0,
        resets_yearly: false,
    },
    {
        code: LEAVE_CODES.COMP_OFF,
        name: 'Compensatory Off',
        default_allocation_days: 0,
        carry_forward: true,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: true,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
        supports_half_day: true,
        advance_notice_days: 0,
        resets_yearly: false,
    },
    {
        code: LEAVE_CODES.UNPAID,
        name: 'Unpaid Leave',
        default_allocation_days: 0,
        carry_forward: false,
        carry_forward_cap: null,
        monthly_cap: null,
        monthly_forfeiture: false,
        is_unlimited: false,
        is_earned: false,
        is_event_based: false,
        pro_rata_on_join: PRO_RATA_STRATEGIES.NONE,
        supports_half_day: false,
        advance_notice_days: 0,
        resets_yearly: false,
    },
];

// ─── Validation caps ───────────────────────────────────────────────────────

export const REASON_MAX = 500;
export const APPROVER_REMARKS_MAX = 500;
export const ADDITIONAL_APPROVAL_REASON_MIN = 5;
export const ADDITIONAL_APPROVAL_REASON_MAX = 500;
export const CANCELLATION_REASON_MAX = 500;

// Single request can't span more than this. CL has 14-day notice, but a year
// of leave through 14 day notice would be unusual; cap protects the engine
// from pathological inputs.
export const LEAVE_REQUEST_MAX_DAYS = 365;

// Half-day fractional value (Data_Model.md §3.3 — segments support 0.5).
export const HALF_DAY = 0.5;

// IST is the canonical local timezone (matches attendance + holidays).
export const LEAVE_TIMEZONE = 'Asia/Kolkata';

// Working-day computation needs the `working_days` array from
// system_settings. We keep a fallback here so the engine stays pure even if
// settings haven't been loaded yet (tests, edge cases).
export const DEFAULT_WORKING_DAYS = [1, 2, 3, 4, 5] as const;

// Strict ISO local-date format — same convention as attendance.local_date
// and holidays.date.
export const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
