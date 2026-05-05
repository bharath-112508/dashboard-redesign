import { PERMISSIONS, type Permission } from './permissions.js';

/**
 * Command-palette action catalog (Phase 4 Step 49 — `Cmd-K` shortcuts).
 *
 * The command palette FE is the keyboard-driven shortcut layer that
 * complements the typeahead `/search` endpoint. Cmd-K opens a modal
 * with two horizontal sections:
 *
 *   1. **Actions** — verbs the user can perform (this catalog).
 *      Examples: "Create new project", "Apply for leave", "Approve
 *      pending leave requests". Each action carries a deep-link URL
 *      the FE navigates to and an optional permission gate; the
 *      service filters the catalog per caller so users never see
 *      actions they can't actually invoke.
 *   2. **Items** — typeahead resource hits (delegates to `/search`).
 *      Users / projects / sprints / tasks. Already implemented at
 *      Step 32; the FE just calls `/search?q=...` in parallel with
 *      this endpoint.
 *
 * Action keys are stable identifiers (`<resource>.<verb>`) — used by
 * the FE for icon mapping and analytics. The label / description /
 * URL are display-only and may change. The `permission` field is the
 * `requirePermission` value the gated route ultimately uses; admins
 * with `system.admin` see every action regardless.
 *
 * Adding a new action: append an entry here, give it the right
 * `permission` (or omit to make it visible to every authenticated
 * user), and the service automatically picks it up. No DB writes
 * involved — this is a static catalog evaluated at request time.
 */

export interface CommandPaletteAction {
    /**
     * Stable identifier — `<resource>.<verb>`. The FE keys icon
     * mappings and telemetry off this; the label can be re-skinned
     * without breaking either.
     */
    key: string;
    /** Display text in the FE's Cmd-K modal. */
    label: string;
    /**
     * Optional sub-line shown below the label. Keep it brief — the
     * Cmd-K modal usually shows one line of supporting text.
     */
    description?: string;
    /**
     * Grouping bucket for the FE's section headers ("Navigation",
     * "Projects", "Reports", etc.). Free-form; the FE can render or
     * ignore the grouping.
     */
    category: string;
    /**
     * Deep-link the FE navigates to when the user activates the
     * action. Relative to the FE root. We don't generate query
     * strings here — the FE may pre-fill drawer state for some
     * actions but the URL itself is a stable target.
     */
    url: string;
    /**
     * Additional substring-match tokens for the `?q=...` filter.
     * Lets a user type "new" to find "Create new project" without
     * needing to remember the exact label phrasing. Each token is
     * lowercased + matched independently; the action surfaces if
     * **any** token contains the query.
     */
    keywords?: readonly string[];
    /**
     * If set, the caller must hold this permission for the action
     * to surface. Admins with `system.admin` auto-pass. If omitted,
     * the action is visible to every authenticated user
     * (navigation entries, "view my tasks", etc.).
     */
    permission?: Permission;
}

const NAV = 'navigation';
const PROJECTS = 'projects';
const TASKS = 'tasks';
const TIME = 'time';
const LEAVES = 'leaves';
const ATTENDANCE = 'attendance';
const REPORTS = 'reports';
const ADMIN = 'admin';

/**
 * The catalog. Ordered by category (the FE may regroup by `category`
 * at render time; insertion order is the within-category default).
 *
 * Entries WITHOUT a `permission` field are visible to every
 * authenticated user — typically navigation shortcuts to "my X" views
 * that are owner-scoped at the underlying endpoint.
 */
export const COMMAND_PALETTE_ACTIONS: readonly CommandPaletteAction[] = [
    // ─── Navigation (no permission gate — every user sees these) ─────
    {
        key: 'nav.dashboard',
        label: 'Go to Dashboard',
        category: NAV,
        url: '/dashboard',
        keywords: ['home', 'overview'],
    },
    {
        key: 'nav.my_tasks',
        label: 'My tasks',
        category: NAV,
        url: '/tasks?assignee=me',
        keywords: ['mine', 'assigned'],
    },
    {
        key: 'nav.my_timesheet',
        label: 'My timesheet',
        category: NAV,
        url: '/timesheets/me',
        keywords: ['hours', 'log'],
    },
    {
        key: 'nav.my_leaves',
        label: 'My leave requests',
        category: NAV,
        url: '/leaves?user=me',
        keywords: ['off', 'vacation'],
    },
    {
        key: 'nav.my_attendance',
        label: 'My attendance',
        category: NAV,
        url: '/attendance/me',
    },
    {
        key: 'nav.profile',
        label: 'My profile',
        category: NAV,
        url: '/users/me',
        keywords: ['settings', 'account'],
    },

    // ─── Projects ────────────────────────────────────────────────────
    {
        key: 'project.create',
        label: 'Create new project',
        description: 'Start a new project with members, sprints, and tasks',
        category: PROJECTS,
        url: '/projects/new',
        keywords: ['add', 'new'],
        permission: PERMISSIONS.PROJECT_WRITE,
    },
    {
        key: 'project.list',
        label: 'Browse projects',
        category: PROJECTS,
        url: '/projects',
        permission: PERMISSIONS.PROJECT_READ,
    },

    // ─── Tasks ───────────────────────────────────────────────────────
    {
        key: 'task.list',
        label: 'Browse all tasks',
        category: TASKS,
        url: '/tasks',
        permission: PERMISSIONS.TASK_READ,
    },
    {
        key: 'task_template.list',
        label: 'Task templates',
        category: TASKS,
        url: '/task-templates',
        keywords: ['recurring'],
        permission: PERMISSIONS.TASK_TEMPLATE_READ,
    },

    // ─── Timesheets ──────────────────────────────────────────────────
    {
        key: 'timesheet.team',
        label: 'Team timesheets',
        category: TIME,
        url: '/timesheets',
        permission: PERMISSIONS.TIMESHEET_READ,
    },
    {
        key: 'billing_rate.list',
        label: 'Billing rates',
        category: TIME,
        url: '/billing-rates',
        keywords: ['rate'],
        permission: PERMISSIONS.BILLING_RATE_READ,
    },

    // ─── Leaves ──────────────────────────────────────────────────────
    {
        key: 'leave_request.apply',
        label: 'Apply for leave',
        description: 'Submit a new leave request',
        category: LEAVES,
        url: '/leaves/new',
        keywords: ['off', 'vacation', 'request'],
        permission: PERMISSIONS.LEAVE_REQUEST_WRITE,
    },
    {
        key: 'leave_request.review',
        label: 'Review pending leave requests',
        category: LEAVES,
        url: '/leaves?status=pending',
        keywords: ['approve', 'reject'],
        permission: PERMISSIONS.LEAVE_REQUEST_APPROVE,
    },
    {
        key: 'leave_balance.team',
        label: 'Team leave balances',
        category: LEAVES,
        url: '/leave-balances',
        permission: PERMISSIONS.LEAVE_BALANCE_READ_TEAM,
    },

    // ─── Attendance ──────────────────────────────────────────────────
    {
        key: 'attendance.checkin',
        label: 'Check in / out',
        category: ATTENDANCE,
        url: '/attendance/me/today',
        keywords: ['punch', 'clock'],
        permission: PERMISSIONS.ATTENDANCE_CHECK_IN_OUT,
    },
    {
        key: 'attendance.review_corrections',
        label: 'Review attendance corrections',
        category: ATTENDANCE,
        url: '/attendance/correction-requests?status=pending',
        keywords: ['approve'],
        permission: PERMISSIONS.ATTENDANCE_CORRECTION_APPROVE,
    },

    // ─── Reports ─────────────────────────────────────────────────────
    {
        key: 'report.billing',
        label: 'Billing report',
        category: REPORTS,
        url: '/reports/billing',
        permission: PERMISSIONS.REPORT_READ,
    },
    {
        key: 'report.utilization',
        label: 'Utilization report',
        category: REPORTS,
        url: '/reports/utilization',
        permission: PERMISSIONS.REPORT_READ,
    },
    {
        key: 'report.attendance',
        label: 'Attendance report',
        category: REPORTS,
        url: '/reports/attendance',
        permission: PERMISSIONS.REPORT_READ,
    },
    {
        key: 'report.leaves',
        label: 'Leaves report',
        category: REPORTS,
        url: '/reports/leaves',
        permission: PERMISSIONS.REPORT_READ,
    },

    // ─── Admin ───────────────────────────────────────────────────────
    {
        key: 'user.create',
        label: 'Invite user',
        description: 'Create a new internal user or client',
        category: ADMIN,
        url: '/users/new',
        keywords: ['add', 'new', 'invite'],
        permission: PERMISSIONS.USER_WRITE,
    },
    {
        key: 'role.create',
        label: 'Create custom role',
        description: 'Define a new role with a custom permission set',
        category: ADMIN,
        url: '/roles/new',
        keywords: ['rbac'],
        permission: PERMISSIONS.ROLE_WRITE,
    },
    {
        key: 'role.list',
        label: 'Manage roles + permissions',
        category: ADMIN,
        url: '/roles',
        keywords: ['rbac'],
        permission: PERMISSIONS.ROLE_READ,
    },
    {
        key: 'holiday.create',
        label: 'Add holiday',
        category: ADMIN,
        url: '/holidays/new',
        permission: PERMISSIONS.HOLIDAY_WRITE,
    },
    {
        key: 'leave_type.create',
        label: 'Manage leave types',
        category: ADMIN,
        url: '/leave-types',
        permission: PERMISSIONS.LEAVE_TYPE_WRITE,
    },
    {
        key: 'office_location.list',
        label: 'Office locations',
        category: ADMIN,
        url: '/office-locations',
        permission: PERMISSIONS.OFFICE_LOCATION_WRITE,
    },
    {
        key: 'settings.edit',
        label: 'System settings',
        category: ADMIN,
        url: '/settings',
        keywords: ['config'],
        permission: PERMISSIONS.SETTINGS_WRITE,
    },
    {
        key: 'audit_log.read',
        label: 'Audit log',
        category: ADMIN,
        url: '/audit-logs',
        keywords: ['security', 'history'],
        permission: PERMISSIONS.AUDIT_LOG_READ,
    },
];

// ─── Query bounds ──────────────────────────────────────────────────────

/**
 * The optional `?q=...` filter is matched by substring against the
 * label + keywords. Same min/max bounds as `/search` for FE
 * consistency — a 1-char `q` is allowed (Cmd-K is keystroke-driven;
 * users see results as they type).
 */
export const COMMAND_PALETTE_MIN_QUERY_LENGTH = 1;
export const COMMAND_PALETTE_MAX_QUERY_LENGTH = 100;
