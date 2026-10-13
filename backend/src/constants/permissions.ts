/**
 * Permission catalog (Phase 4 Step 47 — RBAC).
 *
 * Naming: `<resource>.<verb>` — dot-separated. Verbs are usually one of:
 *   - `read`        — list / get / detail
 *   - `write`       — create / update / patch
 *   - `delete`      — delete (when separate from write)
 *   - special verbs — `approve`, `archive`, `correction_approve`, etc.
 *
 * Why bundle `create + update + patch` into a single `write` in most
 * cases: the existing route allowlists already gate them as a unit
 * (a manager who can edit a project can also create one). Splitting
 * them produces a permission set with ~150 entries and no real
 * authorization daylight between them — pure maintenance overhead.
 *
 * Special verbs exist where the RBAC contract genuinely separates
 * the operations:
 *   - `leave_request.approve` (vs. `leave_request.write` for own apply)
 *   - `attendance.correction_approve` (vs. `correction_request` write)
 *   - `timesheet.edit_out_of_window` (admin-only override)
 *   - `project.archive` (vs. update — different audit shape)
 *
 * Wildcard:
 *   - `system.admin` — held by the system "Admin" role only. The
 *     `requirePermission` middleware treats this as "satisfies any
 *     permission check" so admins always pass. Per-row visibility
 *     scoping (e.g. `buildProjectVisibilityFilter`) keeps using the
 *     `role_keys.includes('admin')` check separately.
 *
 * Adding a new permission: append a constant here, then add it to
 * the relevant system role's permission set in
 * `system-role-definitions.ts`. The `requirePermission` middleware
 * picks it up automatically.
 */

export const PERMISSIONS = {
    // ─── Wildcard ──────────────────────────────────────────────────────
    SYSTEM_ADMIN: 'system.admin',

    // ─── User management ───────────────────────────────────────────────
    USER_READ: 'user.read',
    USER_WRITE: 'user.write',
    /** Edit a user's employment data (internal_profile) only — NOT identity, role, or status. Granted to manager so they can maintain team employment records without full user.write. */
    USER_EMPLOYMENT_WRITE: 'user.employment_write',
    USER_DEACTIVATE: 'user.deactivate',
    USER_ROLE_CHANGE: 'user.role_change',
    /** GDPR DSAR — bundle a user's PII into a JSON dump for export. (BACKEND_AUDIT.md P1-8) */
    USER_DATA_EXPORT: 'user.data_export',
    /** GDPR right-to-erasure — anonymise a user's PII while preserving referential integrity. (BACKEND_AUDIT.md P1-8) */
    USER_DATA_ERASURE: 'user.data_erasure',

    // ─── Roles (Step 47 itself) ────────────────────────────────────────
    ROLE_READ: 'role.read',
    ROLE_WRITE: 'role.write',
    ROLE_DELETE: 'role.delete',

    // ─── Companies (clients) ───────────────────────────────────────────
    COMPANY_READ: 'company.read',
    COMPANY_WRITE: 'company.write',
    /**
     * Create representatives for a company. Held by admin and `client`.
     *
     * Deliberately NOT `user.write`: creating a representative creates a
     * User, and `user.write` is the admin-wide bit — granting it to a
     * Client would let them create admins. The scoped route hard-codes
     * role + company_id instead of reading either from the body.
     */
    REPRESENTATIVE_WRITE: 'representative.write',

    // ─── Projects + structure ──────────────────────────────────────────
    PROJECT_READ: 'project.read',
    PROJECT_WRITE: 'project.write',
    PROJECT_ARCHIVE: 'project.archive',
    PROJECT_MEMBERS_WRITE: 'project.members_write',
    /**
     * Assign representatives to a project. Replaces the retired
     * `project.clients_write`. Held by admin, manager, and `client` —
     * a Client may only touch their OWN company's projects, which is a
     * service-layer scope check, not an RBAC one.
     */
    PROJECT_REPRESENTATIVES_WRITE: 'project.representatives_write',
    SPRINT_WRITE: 'sprint.write',
    STORY_WRITE: 'story.write',

    // ─── Tasks + collaboration ─────────────────────────────────────────
    TASK_READ: 'task.read',
    TASK_WRITE: 'task.write',
    TASK_COMMENT_WRITE: 'task_comment.write',
    TASK_ATTACHMENT_WRITE: 'task_attachment.write',
    /**
     * Raise an issue on a project you can already see — the client-side
     * reporting bit. Deliberately NOT `task.write`: that one gates nine
     * routes including delete, reorder, move-sprint and dependency editing,
     * so granting it to a client would let them restructure the team's board.
     * This grants exactly one thing: create a report, then edit its title,
     * description and suggested priority while it is theirs.
     */
    TASK_REPORT: 'task.report',

    // ─── Task templates (Step 40) ──────────────────────────────────────
    TASK_TEMPLATE_READ: 'task_template.read',
    TASK_TEMPLATE_WRITE: 'task_template.write',

    // ─── Timesheets + billing ──────────────────────────────────────────
    TIMESHEET_READ: 'timesheet.read',
    TIMESHEET_WRITE: 'timesheet.write',
    TIMESHEET_EDIT_OUT_OF_WINDOW: 'timesheet.edit_out_of_window',
    BILLING_RATE_READ: 'billing_rate.read',
    BILLING_RATE_WRITE: 'billing_rate.write',

    // ─── Invoicing (client engagements + invoices) ─────────────────────
    INVOICE_READ: 'invoice.read',
    INVOICE_WRITE: 'invoice.write',

    // ─── Cost rates & margin (Billing Phase 2) ─────────────────────────
    COST_RATE_READ: 'cost_rate.read',
    COST_RATE_WRITE: 'cost_rate.write',

    // ─── Attendance ────────────────────────────────────────────────────
    //
    // M3 — `attendance.read_own` was removed. `/attendance/me*` routes
    // owner-scope at the service layer; nothing ever called
    // `requirePermission(ATTENDANCE_READ_OWN)`. Re-add if you ever need
    // to gate self-reads behind a permission (currently they're
    // authenticate-only).
    ATTENDANCE_READ_TEAM: 'attendance.read_team',
    ATTENDANCE_CHECK_IN_OUT: 'attendance.check_in_out',
    ATTENDANCE_CORRECTION_REQUEST: 'attendance.correction_request',
    ATTENDANCE_CORRECTION_APPROVE: 'attendance.correction_approve',

    // ─── Leaves ────────────────────────────────────────────────────────
    LEAVE_TYPE_READ: 'leave_type.read',
    LEAVE_TYPE_WRITE: 'leave_type.write',
    // M3 — `leave_balance.read_own` + `leave_request.read_own` removed
    // (see note above on ATTENDANCE_READ_OWN). `/leave-balance/me` and
    // `/leave-requests/me` are authenticate-only with owner-scoping in
    // the service.
    LEAVE_BALANCE_READ_TEAM: 'leave_balance.read_team',
    LEAVE_BALANCE_ADJUST: 'leave_balance.adjust',
    LEAVE_REQUEST_READ_TEAM: 'leave_request.read_team',
    LEAVE_REQUEST_WRITE: 'leave_request.write',
    LEAVE_REQUEST_APPROVE: 'leave_request.approve',
    COMP_OFF_READ: 'comp_off.read',
    COMP_OFF_WRITE: 'comp_off.write',

    // ─── Holidays + office locations ───────────────────────────────────
    HOLIDAY_READ: 'holiday.read',
    HOLIDAY_WRITE: 'holiday.write',
    OFFICE_LOCATION_READ: 'office_location.read',
    OFFICE_LOCATION_WRITE: 'office_location.write',

    // ─── Reports + exports ─────────────────────────────────────────────
    REPORT_READ: 'report.read',
    REPORT_EXPORT_WRITE: 'report_export.write',

    // ─── Audit + archive ───────────────────────────────────────────────
    AUDIT_LOG_READ: 'audit_log.read',
    AUDIT_ARCHIVE_READ: 'audit_archive.read',

    // ─── System settings ───────────────────────────────────────────────
    SETTINGS_READ: 'settings.read',
    SETTINGS_WRITE: 'settings.write',
    SETTINGS_SLACK_WRITE: 'settings.slack_write',

    // ─── Project share-links (Step 24) ─────────────────────────────────
    SHARE_LINK_WRITE: 'share_link.write',

    // ─── Dashboards ────────────────────────────────────────────────────
    DASHBOARD_ADMIN: 'dashboard.admin',
    DASHBOARD_MANAGER: 'dashboard.manager',
    DASHBOARD_EMPLOYEE: 'dashboard.employee',
    DASHBOARD_CLIENT: 'dashboard.client',

    // ─── Payroll & certificates ────────────────────────────────────────
    PAYROLL_READ: 'payroll.read',
    PAYROLL_WRITE: 'payroll.write',
    PAYSLIP_GENERATE: 'payslip.generate',
    LETTER_GENERATE: 'letter.generate',
    // Deleting an issued document — admin-only by default (not bundled into any
    // role; only the `system.admin` wildcard grants it).
    PAYSLIP_DELETE: 'payslip.delete',
    LETTER_DELETE: 'letter.delete',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const PERMISSION_VALUES: readonly Permission[] = Object.values(PERMISSIONS);
