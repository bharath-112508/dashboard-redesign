// src/utils/dashboard-range.ts
import dayjs, { DEFAULT_TIMEZONE, DATE_FORMAT } from './date.js';

/**
 * Dashboard analytics range windows (spec §4). All boundaries are IST
 * local dates (YYYY-MM-DD) for parity with attendance/leave/timesheet
 * `local_date` fields. Every range also carries the previous equal
 * period so the service can compute deltas in one pass.
 */

export const DASHBOARD_RANGE_KEYS = ['today', 'week', 'month', '30d', 'quarter'] as const;
export type DashboardRangeKey = (typeof DASHBOARD_RANGE_KEYS)[number];

export interface ResolvedRange {
    key: DashboardRangeKey | 'custom';
    label: string;
    /** Inclusive IST local dates. */
    from: string;
    to: string;
    prev_from: string;
    prev_to: string;
    /** Friendly name of the previous period, for delta labels. */
    prev_label: string;
}

export const resolveDashboardRange = (key: DashboardRangeKey): ResolvedRange => {
    const now = dayjs().tz(DEFAULT_TIMEZONE);
    const f = (d: ReturnType<typeof dayjs>) => d.format(DATE_FORMAT);

    switch (key) {
        case 'today':
            return {
                key,
                label: 'Today',
                prev_label: 'yesterday',
                from: f(now),
                to: f(now),
                prev_from: f(now.subtract(1, 'day')),
                prev_to: f(now.subtract(1, 'day')),
            };
        case 'week': {
            // dayjs weeks start Sunday; the platform week starts Monday.
            const dow = (now.day() + 6) % 7; // 0 = Monday
            const start = now.subtract(dow, 'day');
            return {
                key,
                label: 'This week',
                prev_label: 'last week',
                from: f(start),
                to: f(now),
                prev_from: f(start.subtract(7, 'day')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        case 'month': {
            const start = now.startOf('month');
            return {
                key,
                label: 'This month',
                prev_label: 'last month',
                from: f(start),
                to: f(now),
                prev_from: f(start.subtract(1, 'month')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        case '30d': {
            const start = now.subtract(29, 'day');
            return {
                key,
                label: 'Last 30 days',
                prev_label: 'the previous 30 days',
                from: f(start),
                to: f(now),
                prev_from: f(start.subtract(30, 'day')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        case 'quarter': {
            const qStartMonth = Math.floor(now.month() / 3) * 3;
            const start = now.month(qStartMonth).startOf('month');
            return {
                key,
                label: 'This quarter',
                prev_label: 'last quarter',
                from: f(start),
                to: f(now),
                prev_from: f(start.subtract(3, 'month')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
    }
};

/**
 * Resolves an arbitrary caller-supplied `[from, to]` window (inclusive IST
 * local dates) plus the equally-long previous window immediately before it.
 * Caller guarantees `from <= to` (validated by `dashboardOverviewQuerySchema`).
 */
export const resolveCustomRange = (from: string, to: string): ResolvedRange => {
    const f = (d: ReturnType<typeof dayjs>) => d.format(DATE_FORMAT);
    const fromDate = dayjs.tz(from, DEFAULT_TIMEZONE);
    const toDate = dayjs.tz(to, DEFAULT_TIMEZONE);
    const span = toDate.diff(fromDate, 'day') + 1;
    const prevTo = fromDate.subtract(1, 'day');
    const prevFrom = prevTo.subtract(span - 1, 'day');

    return {
        key: 'custom',
        label: `${from} – ${to}`,
        prev_label: `${f(prevFrom)} – ${f(prevTo)}`,
        from,
        to,
        prev_from: f(prevFrom),
        prev_to: f(prevTo),
    };
};

/** Inclusive YYYY-MM-DD list for [from, to]. Caller guarantees from <= to. */
export const enumerateDates = (from: string, to: string): string[] => {
    const out: string[] = [];
    let cur = dayjs.tz(from, DEFAULT_TIMEZONE);
    const end = dayjs.tz(to, DEFAULT_TIMEZONE);
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
        out.push(cur.format(DATE_FORMAT));
        cur = cur.add(1, 'day');
    }
    return out;
};
