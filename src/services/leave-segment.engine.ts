import dayjs, { type Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

import { DEFAULT_WORKING_DAYS, HALF_DAY, LEAVE_CODES, type HalfDaySlot, type LeaveCode } from '../constants/leave.js';

dayjs.extend(customParseFormat);

/**
 * Pure leave-segment generator (Data_Model.md §3.3, Company_Management_Plan
 * §2.1.2). Lives in its own file with **zero** Mongoose imports so the
 * 10.2 unit + property tests can hammer it without spinning up a database.
 *
 * Inputs
 *  - `requested_code`: the leave type the user *applied under* (drives
 *    split policy; e.g. SL → 1 SL/month + remainder to CL).
 *  - `start_date` / `end_date` / `is_half_day` / `half_day_slot`.
 *  - `working_days`: 0=Sun..6=Sat array of working weekdays (from
 *    `system_settings.work_schedule`).
 *  - `holidays`: Set of `YYYY-MM-DD` strings to exclude.
 *  - `sl_month_used`: per-month map of "SL slots already gone" — the
 *    caller seeds this from `leave_requests` (approved+pending SL segments
 *    for the user) **plus** `sl_monthly_forfeitures`. Apply-time the
 *    engine increments the in-memory map as it allocates the first SL
 *    slot of each year-group, so a multi-year request never debits SL
 *    twice in the same month.
 *  - `available`: optional snapshot of `leave_balances.available` keyed
 *    by `(code, year)` — the engine flags `requires_additional_approval`
 *    when any chosen segment would drive the corresponding entry < 0.
 *  - `slots_per_month`: SL monthly cap from `leave_types.SL.monthly_cap`
 *    (1 in v1; configurable for future).
 *
 * Output
 *  - `total_days` (sum of segments)
 *  - `leave_segments[]` ({ leave_type_code, year, days })
 *  - `requires_additional_approval`
 *  - `warnings[]` (e.g. `LEAVE_SPANS_YEARS`, `LEAVE_NO_WORKING_DAYS`)
 *  - `working_days` — the canonical day list, returned for service-layer
 *    overlap checks
 *
 * The engine deliberately stops at **codes**. It is the apply-flow's
 * responsibility to translate `code → leave_type_id` against the active
 * `leave_types` collection right before persisting `leave_segments[]`.
 */

// ─── Public types ─────────────────────────────────────────────────────────

export interface SegmentEngineInput {
    requested_code: LeaveCode;
    start_date: string;
    end_date: string;
    is_half_day: boolean;
    half_day_slot: HalfDaySlot | null;
    working_days?: readonly number[];
    holidays?: ReadonlySet<string>;
    sl_month_used?: ReadonlyMap<string, number>; // key: `${year}-${month}` (1..12), val: days already used (incl. forfeitures)
    available?: ReadonlyMap<string, number>; // key: `${code}|${year}`, val: leave_balances.available
    slots_per_month?: number; // default 1
}

export interface ComputedSegment {
    leave_type_code: LeaveCode;
    year: number;
    days: number;
}

export interface SegmentEngineWarning {
    code: 'LEAVE_SPANS_YEARS' | 'LEAVE_NO_WORKING_DAYS' | 'LEAVE_INVALID_HALF_DAY';
    message: string;
}

export interface SegmentEngineResult {
    total_days: number;
    leave_segments: ComputedSegment[];
    requires_additional_approval: boolean;
    warnings: SegmentEngineWarning[];
    working_days: string[]; // YYYY-MM-DD list (post weekend/holiday filter)
}

// ─── Helpers (pure) ───────────────────────────────────────────────────────

const monthKey = (year: number, month: number): string => `${year}-${month}`;
const balanceKey = (code: LeaveCode, year: number): string => `${code}|${year}`;

const isWorkingDay = (d: Dayjs, workingDays: readonly number[], holidays: ReadonlySet<string>): boolean => {
    if (!workingDays.includes(d.day())) return false;
    if (holidays.has(d.format('YYYY-MM-DD'))) return false;
    return true;
};

/**
 * Enumerate the working day list for the request span. Returned dates are
 * strict `YYYY-MM-DD` strings ordered ascending. Half-day requests still
 * return one date (the same one start === end).
 */
export const enumerateWorkingDays = (params: {
    start_date: string;
    end_date: string;
    working_days: readonly number[];
    holidays: ReadonlySet<string>;
}): string[] => {
    const start = dayjs(params.start_date, 'YYYY-MM-DD', true);
    const end = dayjs(params.end_date, 'YYYY-MM-DD', true);
    const out: string[] = [];
    let cursor = start;
    while (!cursor.isAfter(end)) {
        if (isWorkingDay(cursor, params.working_days, params.holidays)) {
            out.push(cursor.format('YYYY-MM-DD'));
        }
        cursor = cursor.add(1, 'day');
    }
    return out;
};

const halfDayMultiplier = (slot: HalfDaySlot | null): number => {
    // Half-day always equals 0.5 regardless of which slot — the slot is
    // surfaced for the calendar UI but doesn't change the debit math.
    void slot;
    return HALF_DAY;
};

const groupByYear = (workingDays: string[]): Map<number, string[]> => {
    const out = new Map<number, string[]>();
    for (const d of workingDays) {
        const yr = Number.parseInt(d.slice(0, 4), 10);
        const arr = out.get(yr) ?? [];
        arr.push(d);
        out.set(yr, arr);
    }
    return out;
};

const monthOf = (date: string): number => Number.parseInt(date.slice(5, 7), 10);

// ─── Core entrypoint ──────────────────────────────────────────────────────

export const generateSegments = (input: SegmentEngineInput): SegmentEngineResult => {
    const workingDaysCfg = input.working_days ?? DEFAULT_WORKING_DAYS;
    const holidays = input.holidays ?? new Set<string>();
    const slotsPerMonth = input.slots_per_month ?? 1;
    const slUsed = new Map<string, number>(input.sl_month_used ?? []);
    const available = input.available ?? new Map<string, number>();

    const warnings: SegmentEngineWarning[] = [];

    // ── Half-day fast path ───────────────────────────────────────────────
    if (input.is_half_day) {
        if (input.start_date !== input.end_date) {
            warnings.push({
                code: 'LEAVE_INVALID_HALF_DAY',
                message: 'Half-day requests must have start_date == end_date',
            });
            return {
                total_days: 0,
                leave_segments: [],
                requires_additional_approval: false,
                warnings,
                working_days: [],
            };
        }
        const day = dayjs(input.start_date, 'YYYY-MM-DD', true);
        if (!isWorkingDay(day, workingDaysCfg, holidays)) {
            warnings.push({
                code: 'LEAVE_NO_WORKING_DAYS',
                message: 'The selected day is a weekend or holiday',
            });
            return {
                total_days: 0,
                leave_segments: [],
                requires_additional_approval: false,
                warnings,
                working_days: [],
            };
        }
        const days = halfDayMultiplier(input.half_day_slot);
        const year = day.year();
        const segments = pickFirstSegmentForCode(
            input.requested_code,
            year,
            days,
            day.month() + 1,
            slUsed,
            slotsPerMonth
        );
        return finalize(segments, available, warnings, [day.format('YYYY-MM-DD')]);
    }

    // ── Full-day path ────────────────────────────────────────────────────
    const workingDays = enumerateWorkingDays({
        start_date: input.start_date,
        end_date: input.end_date,
        working_days: workingDaysCfg,
        holidays,
    });

    if (workingDays.length === 0) {
        warnings.push({
            code: 'LEAVE_NO_WORKING_DAYS',
            message: 'Request contains no working days (all weekends / holidays)',
        });
        return {
            total_days: 0,
            leave_segments: [],
            requires_additional_approval: false,
            warnings,
            working_days: [],
        };
    }

    const years = groupByYear(workingDays);
    if (years.size > 1) {
        warnings.push({ code: 'LEAVE_SPANS_YEARS', message: 'Request spans multiple years' });
    }

    const segments: ComputedSegment[] = [];
    for (const [year, daysInYear] of years) {
        const ymSegments = splitForYear({
            requested_code: input.requested_code,
            year,
            days_in_year: daysInYear,
            sl_used: slUsed,
            slots_per_month: slotsPerMonth,
        });
        segments.push(...ymSegments);
    }

    return finalize(segments, available, warnings, workingDays);
};

// ─── Internal: split a year-group ─────────────────────────────────────────

const splitForYear = (params: {
    requested_code: LeaveCode;
    year: number;
    days_in_year: string[];
    sl_used: Map<string, number>;
    slots_per_month: number;
}): ComputedSegment[] => {
    const { requested_code, year, days_in_year, sl_used, slots_per_month } = params;
    const totalDays = days_in_year.length;

    if (requested_code !== LEAVE_CODES.SL) {
        return [{ leave_type_code: requested_code, year, days: totalDays }];
    }

    // SL → walk the day list in order. For each calendar month, allow up to
    // `slots_per_month - already_used` SL days; remainder spills to CL.
    let slDays = 0;
    let clDays = 0;

    // Group within the year by month for clean iteration.
    const monthBuckets = new Map<number, string[]>();
    for (const d of days_in_year) {
        const m = monthOf(d);
        const arr = monthBuckets.get(m) ?? [];
        arr.push(d);
        monthBuckets.set(m, arr);
    }

    for (const [month, daysOfMonth] of monthBuckets) {
        const key = monthKey(year, month);
        const alreadyUsed = sl_used.get(key) ?? 0;
        const remaining = Math.max(0, slots_per_month - alreadyUsed);
        const slToTake = Math.min(remaining, daysOfMonth.length);
        slDays += slToTake;
        clDays += daysOfMonth.length - slToTake;
        if (slToTake > 0) {
            // Reflect our allocation so a downstream call inside the same
            // request (multi-year SL) doesn't double-claim the slot.
            sl_used.set(key, alreadyUsed + slToTake);
        }
    }

    const out: ComputedSegment[] = [];
    if (slDays > 0) out.push({ leave_type_code: LEAVE_CODES.SL, year, days: slDays });
    if (clDays > 0) out.push({ leave_type_code: LEAVE_CODES.CL, year, days: clDays });
    return out;
};

// ─── Internal: half-day single-segment shortcut ──────────────────────────

const pickFirstSegmentForCode = (
    code: LeaveCode,
    year: number,
    days: number,
    month: number,
    sl_used: Map<string, number>,
    slots_per_month: number
): ComputedSegment[] => {
    if (code !== LEAVE_CODES.SL) {
        return [{ leave_type_code: code, year, days }];
    }
    const key = monthKey(year, month);
    const alreadyUsed = sl_used.get(key) ?? 0;
    const remaining = Math.max(0, slots_per_month - alreadyUsed);
    if (remaining >= days) {
        sl_used.set(key, alreadyUsed + days);
        return [{ leave_type_code: LEAVE_CODES.SL, year, days }];
    }
    // Half-day SL but month exhausted → fall through to CL.
    return [{ leave_type_code: LEAVE_CODES.CL, year, days }];
};

// ─── Internal: finalize totals + neg-balance flag ────────────────────────

const finalize = (
    segments: ComputedSegment[],
    available: ReadonlyMap<string, number>,
    warnings: SegmentEngineWarning[],
    workingDays: string[]
): SegmentEngineResult => {
    let total = 0;
    let requiresAdditional = false;

    // Accumulate planned debits per (code, year) so a single request that
    // splits across types still flags negative balance correctly.
    const planned = new Map<string, number>();
    for (const s of segments) {
        total += s.days;
        const k = balanceKey(s.leave_type_code, s.year);
        planned.set(k, (planned.get(k) ?? 0) + s.days);
    }

    if (available.size > 0) {
        for (const [k, plannedDays] of planned) {
            const avail = available.get(k);
            if (avail !== undefined && avail - plannedDays < 0) {
                requiresAdditional = true;
                break;
            }
        }
    }

    return {
        total_days: Math.round(total * 2) / 2, // snap to 0.5 grid
        leave_segments: segments,
        requires_additional_approval: requiresAdditional,
        warnings,
        working_days: workingDays,
    };
};
