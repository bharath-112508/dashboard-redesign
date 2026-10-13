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
    /** Display label ('This month' / '1 Jun – 23 Jul'). Shown as a subtitle. */
    label: string;
    /**
     * Sentence-tail form used inside insight strings, so the copy reads
     * naturally after a verb ('… completed this month.' /
     * '… completed in the selected range.'). Equals `label` for presets.
     */
    insight_label: string;
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

    // Presets read the same whether displayed or dropped into a sentence
    // ('this month'), so insight_label mirrors label.
    const base = ((): Omit<ResolvedRange, 'insight_label'> => {
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
    })();
    return { ...base, insight_label: base.label };
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

    // Include the year only when the span crosses one, to keep it short.
    const sameYear = fromDate.year() === toDate.year();
    const displayLabel =
        from === to
            ? toDate.format('D MMM YYYY')
            : sameYear
              ? `${fromDate.format('D MMM')} – ${toDate.format('D MMM YYYY')}`
              : `${fromDate.format('D MMM YYYY')} – ${toDate.format('D MMM YYYY')}`;

    return {
        key: 'custom',
        label: displayLabel,
        // 'in the selected range' reads correctly after every insight verb
        // ('… completed in the selected range.'), unlike a bare date span.
        insight_label: 'in the selected range',
        prev_label: 'the previous period',
        from,
        to,
        prev_from: f(prevFrom),
        prev_to: f(prevTo),
    };
};

/**
 * Resolves the analytics range from a query that carries EITHER a preset
 * `range` key OR an explicit custom `[from, to]` window. Custom wins when
 * both dates are present; otherwise the preset (default `month`) applies.
 * The validator guarantees `from`/`to` arrive together and `from <= to`.
 */
export const resolveAnalyticsRange = (q: { range?: DashboardRangeKey; from?: string; to?: string }): ResolvedRange =>
    q.from && q.to ? resolveCustomRange(q.from, q.to) : resolveDashboardRange(q.range ?? 'month');

/**
 * Full calendar-period boundaries for the "Tasks Completed" throughput
 * card — Sunday–Saturday for a week, 1st–last day of the calendar month,
 * first–last day of the calendar quarter. Every other dashboard section
 * shares `resolveDashboardRange`'s Monday-start week and "to = today"
 * truncation, but a still-in-progress period there just means the
 * not-yet-arrived days have zero completions — reporting the FULL period
 * (rather than only "so far") never inflates the total, it just fixes the
 * boundary so e.g. "This week" always means Sun–Sat, not a partial
 * Monday-to-today window.
 *
 * `'today'` (a single day), `'30d'` (a rolling window with no calendar
 * period of its own) and `'custom'` (an explicit caller-chosen span) have
 * no distinct "full period" — they fall through to the range as already
 * resolved.
 */
export const resolveThroughputPeriod = (
    range: ResolvedRange
): Pick<ResolvedRange, 'from' | 'to' | 'prev_from' | 'prev_to'> => {
    const f = (d: ReturnType<typeof dayjs>) => d.format(DATE_FORMAT);
    // `range.to` is "today" for every preset that reaches this point (week /
    // month / quarter all end their shared range at today), so it doubles as
    // the reference date for finding which week/month/quarter we're in.
    const now = dayjs.tz(range.to, DEFAULT_TIMEZONE);

    switch (range.key) {
        case 'week': {
            const dow = now.day(); // dayjs: 0 = Sunday .. 6 = Saturday
            const start = now.subtract(dow, 'day');
            const end = start.add(6, 'day');
            return {
                from: f(start),
                to: f(end),
                prev_from: f(start.subtract(7, 'day')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        case 'month': {
            const start = now.startOf('month');
            const end = now.endOf('month');
            return {
                from: f(start),
                to: f(end),
                prev_from: f(start.subtract(1, 'month')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        case 'quarter': {
            const qStartMonth = Math.floor(now.month() / 3) * 3;
            const start = now.month(qStartMonth).startOf('month');
            const end = start.add(2, 'month').endOf('month');
            return {
                from: f(start),
                to: f(end),
                prev_from: f(start.subtract(3, 'month')),
                prev_to: f(start.subtract(1, 'day')),
            };
        }
        default:
            return { from: range.from, to: range.to, prev_from: range.prev_from, prev_to: range.prev_to };
    }
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
