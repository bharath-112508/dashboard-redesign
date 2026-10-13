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
    // breakdown the UI shows in the expandable accordion. `% of time` is the
    // project's share of that user's logged time. A user with no logged time
    // still gets one row (project "—") so headcount is complete.
    //
    // Expected hours and utilization % are deliberately NOT exported. They are
    // user-level figures, so on a per-(user, project) grid they repeated
    // identically down every row belonging to one person — which reads as a
    // per-project number and invites the wrong sum. They remain on screen,
    // where one row is one person and they mean what they say.
    const rows: Array<Record<string, CellValue>> = [];
    for (const r of data.rows) {
        const base = {
            user: r.user.full_name,
            role: r.user.role,
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

// ─── Team timesheets ──────────────────────────────────────────────────────

/** One enriched entry as `listAllEntries` returns it (names already resolved). */
export interface TeamTimesheetExportRow {
    local_date: string;
    entry_type: string;
    description?: string | null;
    general_category?: string | null;
    billable_total_minutes: number;
    non_billable_total_minutes: number;
    user_id: unknown;
    user?: { id?: string; full_name?: string } | null;
    project?: { name?: string } | null;
    task?: { title?: string } | null;
}

export interface TeamTimesheetExportInput {
    from_date: string;
    to_date: string;
    /** Resolved display names, or null when the filter wasn't applied. */
    user_label: string | null;
    project_label: string | null;
    rows: TeamTimesheetExportRow[];
    /** True when the row cap was hit, so the file can say so out loud. */
    truncated: boolean;
}

/**
 * Team timesheets → one row per entry, followed by a per-employee roll-up.
 *
 * The detail rows answer "what did people do"; the roll-up answers "how many
 * hours did each person put in", which is what the file is usually downloaded
 * for — and which otherwise requires a pivot table. Both live in one sheet so
 * a reader never has to reconcile two files.
 *
 * The roll-up is keyed on user id, not display name: two people can share a
 * name, and a deleted user has none at all.
 */
export const toTabularTeamTimesheets = (input: TeamTimesheetExportInput): TabularReport => {
    const hours = (m: number): number => Math.round((m / 60) * 100) / 100;

    const detail = input.rows.map((r) => ({
        local_date: r.local_date,
        user: r.user?.full_name ?? 'Deleted user',
        entry_type: r.entry_type === 'task_linked' ? 'Task' : 'General',
        project: r.project?.name ?? '',
        task: r.entry_type === 'task_linked' ? (r.task?.title ?? '') : (r.general_category ?? ''),
        notes: r.description ?? '',
        billable_hours: hours(r.billable_total_minutes),
        non_billable_hours: hours(r.non_billable_total_minutes),
        total_hours: hours(r.billable_total_minutes + r.non_billable_total_minutes),
    }));

    const byUser = new Map<string, { name: string; b: number; nb: number; n: number }>();
    for (const r of input.rows) {
        const key = r.user?.id ?? String(r.user_id);
        const acc = byUser.get(key) ?? { name: r.user?.full_name ?? 'Deleted user', b: 0, nb: 0, n: 0 };
        acc.b += r.billable_total_minutes;
        acc.nb += r.non_billable_total_minutes;
        acc.n += 1;
        byUser.set(key, acc);
    }
    const totals = [...byUser.values()].sort((a, b) => b.b + b.nb - (a.b + a.nb));

    // A blank spacer, a banner, then the roll-up — rendered through the same
    // columns so the single-sheet layout holds for both CSV and XLSX.
    const rollUp: Array<Record<string, CellValue>> = [
        {
            local_date: '',
            user: '',
            entry_type: '',
            project: '',
            task: '',
            notes: '',
            billable_hours: null,
            non_billable_hours: null,
            total_hours: null,
        },
        {
            local_date: 'TOTALS BY EMPLOYEE',
            user: '',
            entry_type: '',
            project: '',
            task: '',
            notes: '',
            billable_hours: null,
            non_billable_hours: null,
            total_hours: null,
        },
        ...totals.map((t) => ({
            local_date: '',
            user: t.name,
            entry_type: '',
            project: '',
            task: '',
            notes: `${t.n} ${t.n === 1 ? 'entry' : 'entries'}`,
            billable_hours: hours(t.b),
            non_billable_hours: hours(t.nb),
            total_hours: hours(t.b + t.nb),
        })),
        {
            local_date: '',
            user: 'TOTAL',
            entry_type: '',
            project: '',
            task: '',
            notes: `${input.rows.length} ${input.rows.length === 1 ? 'entry' : 'entries'}`,
            billable_hours: hours(totals.reduce((a, t) => a + t.b, 0)),
            non_billable_hours: hours(totals.reduce((a, t) => a + t.nb, 0)),
            total_hours: hours(totals.reduce((a, t) => a + t.b + t.nb, 0)),
        },
    ];

    const summary = [
        { label: 'From', value: input.from_date },
        { label: 'To', value: input.to_date },
        { label: 'User', value: input.user_label ?? 'All users' },
        { label: 'Project', value: input.project_label ?? 'All projects' },
    ];
    // Never silently short: if the cap was hit the file says so on its face,
    // not just in a toast the reader never saw.
    if (input.truncated) {
        summary.push({ label: 'NOTE', value: `Truncated to the first ${input.rows.length} entries.` });
    }

    return {
        title: 'Team timesheets',
        summary,
        columns: [
            { key: 'local_date', label: 'Date' },
            { key: 'user', label: 'User' },
            { key: 'entry_type', label: 'Type' },
            { key: 'project', label: 'Project' },
            { key: 'task', label: 'Task / Category' },
            { key: 'notes', label: 'Notes' },
            { key: 'billable_hours', label: 'Billable (h)' },
            { key: 'non_billable_hours', label: 'Non-billable (h)' },
            { key: 'total_hours', label: 'Total (h)' },
        ],
        rows: [...detail, ...rollUp],
    };
};
