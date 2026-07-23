import type {
    AttendanceReportResult,
    BillingReportResult,
    LeaveReportResult,
    UtilizationReportResult,
} from '../report.service.js';

/**
 * Tabular intermediate representation (Step 30).
 *
 * Each format generator (csv, xlsx) consumes a `TabularReport`; the
 * report-specific knowledge of which fields to show + label is captured
 * once here. Adding a new report = one new `toTabular*` function; adding a
 * new format = one new generator that walks the same `TabularReport`.
 *
 * `summary` renders as a header block above the rows (e.g. project name +
 * date range for billing, year for leaves). It is **not** a Mongo row
 * shape — it's a labelled key/value list designed for human reading.
 */

export type CellValue = string | number | null;

export interface TabularColumn {
    key: string;
    label: string;
}

export interface TabularReport {
    title: string;
    /** Optional human-readable header (project name, date range, etc.). */
    summary: Array<{ label: string; value: string }>;
    columns: TabularColumn[];
    rows: Array<Record<string, CellValue>>;
}

// ─── Per-report adapters ─────────────────────────────────────────────────

const formatMinutes = (m: number | null | undefined): number => {
    if (typeof m !== 'number') return 0;
    // Round to 2 decimals as hours so CSV/XLSX cells render numerically.
    return Math.round((m / 60) * 100) / 100;
};

export const toTabularBilling = (data: BillingReportResult): TabularReport => ({
    title: 'Billing report',
    summary: [
        { label: 'Project', value: data.project.name },
        { label: 'From', value: data.from_date },
        { label: 'To', value: data.to_date },
        { label: 'Total billable hours', value: String(formatMinutes(data.totals.billable_minutes)) },
        { label: 'Total non-billable hours', value: String(formatMinutes(data.totals.non_billable_minutes)) },
        { label: 'Total billable amount', value: String(data.totals.billable_amount) },
    ],
    columns: [
        { key: 'user', label: 'User' },
        { key: 'task', label: 'Task' },
        { key: 'billable_hours', label: 'Billable hours' },
        { key: 'non_billable_hours', label: 'Non-billable hours' },
        { key: 'hourly_rate', label: 'Hourly rate' },
        { key: 'billable_amount', label: 'Billable amount' },
    ],
    rows: data.rows.map((r) => ({
        user: r.user.full_name,
        task: r.task.title ?? '—',
        billable_hours: formatMinutes(r.billable_minutes),
        non_billable_hours: formatMinutes(r.non_billable_minutes),
        hourly_rate: r.hourly_rate,
        billable_amount: r.billable_amount,
    })),
});

export const toTabularUtilization = (data: UtilizationReportResult): TabularReport => {
    // One row per (user, project) so the export carries the same per-project
    // breakdown the UI shows in the expandable accordion. User-level fields
    // (expected hours, utilization %) repeat on each of that user's rows so
    // every row is self-contained and pivots cleanly by user OR by project.
    // `% of time` is the project's share of that user's logged time. A user
    // with no logged time still gets one row (project "—") so headcount is
    // complete.
    const rows: Array<Record<string, CellValue>> = [];
    for (const r of data.rows) {
        const base = {
            user: r.user.full_name,
            role: r.user.role,
            expected_hours: formatMinutes(r.expected_minutes),
            utilization_pct: r.utilization_pct,
        };
        if (r.projects.length === 0) {
            rows.push({
                ...base,
                project: '—',
                billable_hours: formatMinutes(r.logged_billable_minutes),
                non_billable_hours: formatMinutes(r.logged_non_billable_minutes),
                total_hours: formatMinutes(r.logged_total_minutes),
                share_pct: 0,
            });
            continue;
        }
        for (const p of r.projects) {
            rows.push({
                ...base,
                project: p.project ? p.project.name : 'Unassigned',
                billable_hours: formatMinutes(p.billable_minutes),
                non_billable_hours: formatMinutes(p.non_billable_minutes),
                total_hours: formatMinutes(p.total_minutes),
                share_pct: p.share_pct,
            });
        }
    }

    return {
        title: 'Utilization report',
        summary: [
            { label: 'From', value: data.from_date },
            { label: 'To', value: data.to_date },
            { label: 'Expected hours per user', value: String(formatMinutes(data.expected_per_user_minutes)) },
        ],
        columns: [
            { key: 'user', label: 'User' },
            { key: 'role', label: 'Role' },
            { key: 'project', label: 'Project' },
            { key: 'billable_hours', label: 'Billable hours' },
            { key: 'non_billable_hours', label: 'Non-billable hours' },
            { key: 'total_hours', label: 'Total hours' },
            { key: 'share_pct', label: '% of time' },
            { key: 'expected_hours', label: 'Expected hours' },
            { key: 'utilization_pct', label: 'User utilization %' },
        ],
        rows,
    };
};

export const toTabularAttendance = (data: AttendanceReportResult): TabularReport => ({
    title: 'Attendance report',
    summary: [
        { label: 'From', value: data.from_date },
        { label: 'To', value: data.to_date },
    ],
    columns: [
        { key: 'user', label: 'User' },
        { key: 'present', label: 'Present' },
        { key: 'absent', label: 'Absent' },
        { key: 'on_leave', label: 'On leave' },
        { key: 'holiday', label: 'Holiday' },
        { key: 'weekend', label: 'Weekend' },
        { key: 'incomplete', label: 'Incomplete' },
        { key: 'total_days', label: 'Total days' },
    ],
    rows: data.rows.map((r) => ({
        user: r.user.full_name,
        present: r.present,
        absent: r.absent,
        on_leave: r.on_leave,
        holiday: r.holiday,
        weekend: r.weekend,
        incomplete: r.incomplete,
        total_days: r.total_days,
    })),
});

export const toTabularLeaves = (data: LeaveReportResult): TabularReport => {
    // Leave report nests `by_type[]` under each user; flatten to one
    // row per `(user, leave_type)` so the export is a true rectangle.
    // A user with N balance rows yields N export rows; a user with no
    // balances renders as a single "no balances" row so they still
    // appear in the export (matches the JSON which surfaces them).
    type Row = Record<string, CellValue>;
    const rows: Row[] = [];
    for (const userRow of data.rows) {
        if (userRow.by_type.length === 0) {
            rows.push({
                user: userRow.user.full_name,
                leave_type: '—',
                allocated: 0,
                carried_forward: 0,
                used: 0,
                pending: 0,
                adjusted: 0,
                monthly_forfeited: 0,
                available: 0,
            });
            continue;
        }
        for (const t of userRow.by_type) {
            rows.push({
                user: userRow.user.full_name,
                leave_type: t.leave_type.label,
                allocated: t.allocated,
                carried_forward: t.carried_forward,
                used: t.used,
                pending: t.pending,
                adjusted: t.adjusted,
                monthly_forfeited: t.monthly_forfeited,
                available: t.available,
            });
        }
    }
    return {
        title: 'Leave report',
        summary: [{ label: 'Year', value: String(data.year) }],
        columns: [
            { key: 'user', label: 'User' },
            { key: 'leave_type', label: 'Leave type' },
            { key: 'allocated', label: 'Allocated' },
            { key: 'carried_forward', label: 'Carried forward' },
            { key: 'used', label: 'Used' },
            { key: 'pending', label: 'Pending' },
            { key: 'adjusted', label: 'Adjusted' },
            { key: 'monthly_forfeited', label: 'Monthly forfeited' },
            { key: 'available', label: 'Available' },
        ],
        rows,
    };
};
