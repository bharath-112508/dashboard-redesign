import { PERMISSIONS, type Permission } from './permissions.js';
import { SYSTEM_ROLE_KEYS, type SystemRoleKey } from './role-keys.js';

/**
 * System-role permission sets (Phase 4 Step 47).
 *
 * Each system role's permission list is derived from the existing
 * pre-Step-47 route allowlists — i.e. the migration is **non-breaking
 * by construction** for the four legacy roles. A user whose
 * pre-migration role was 'admin' gets exactly the permissions admin-
 * only routes required, plus the `system.admin` wildcard for any
 * future surface added behind a permission gate.
 *
 * **team_lead** is new in Step 47. Its permission set is built from:
 *   - everything an Employee gets (so the IC-level surfaces still
 *     work for them — checking off own tasks, submitting own
 *     leaves, etc.)
 *   - PLUS first-line approval verbs (`leave_request.approve`,
 *     `attendance.correction_approve`) gated to own reports
 *     by the existing reporting-chain logic at the service layer
 *   - PLUS read-team verbs (`leave_request.read_team`,
 *     `attendance.read_team`, `timesheet.read`) likewise scoped to
 *     own reports
 *   - PLUS project-author verbs (`project.write`, `project.archive`,
 *     `sprint.write`, `story.write`, `task_template.write`,
 *     `share_link.write`, `project.create`-implied-by-`project.write`)
 *     — the per-row visibility filter still gates them to projects
 *     the team-lead is actually a member of, exactly the same way
 *     it gates an Employee's task writes today.
 *
 * **NOT given to team_lead** (deliberate — these stay manager+):
 *   - billing rate (`billing_rate.*`) — financial surface
 *   - reports (`report.read`) — cross-team rollups
 *   - user management (`user.write` / `user.deactivate` / `user.role_change`)
 *   - leave-balance adjust + leave-type CRUD
 *   - holiday / office-location writes
 *   - settings / audit / role CRUD
 *
 * Adding / removing a permission to a system role is a config
 * change here; the boot seeder reconciles on next start (additions
 * are appended; removals require an explicit migration since they're
 * a privilege downgrade for active users).
 */

export interface SystemRoleDefinition {
    key: SystemRoleKey;
    display_name: string;
    description: string;
    permissions: readonly Permission[];
}

// ─── Permission bundles (composed into roles below) ───────────────────────

/** What every authenticated employee-or-above gets. Foundation. */
const EMPLOYEE_BASE: readonly Permission[] = [
    PERMISSIONS.USER_READ,
    PERMISSIONS.PROJECT_READ,
    PERMISSIONS.TASK_READ,
    PERMISSIONS.TASK_WRITE,
    PERMISSIONS.TASK_COMMENT_WRITE,
    PERMISSIONS.TASK_ATTACHMENT_WRITE,
    PERMISSIONS.TASK_TEMPLATE_READ,
    PERMISSIONS.TIMESHEET_WRITE,
    // M3 — `ATTENDANCE_READ_OWN`, `LEAVE_BALANCE_READ_OWN`,
    // `LEAVE_REQUEST_READ_OWN` were dead: catalogued + assigned, but no
    // route ever called `requirePermission(...READ_OWN)`. The matching
    // `/me*` endpoints already owner-scope at the service layer
    // (Attendance: `getMyAttendance`, LeaveBalance: `getMine`,
    // LeaveRequest: `listMine`), so adding gates would be no-ops because
    // every authenticated user held the bits. Removed from the catalog
    // to clean up the FE Roles UI; route-layer behaviour is unchanged.
    PERMISSIONS.ATTENDANCE_CHECK_IN_OUT,
    PERMISSIONS.ATTENDANCE_CORRECTION_REQUEST,
    PERMISSIONS.LEAVE_TYPE_READ,
    PERMISSIONS.LEAVE_REQUEST_WRITE,
    PERMISSIONS.COMP_OFF_READ,
    PERMISSIONS.COMP_OFF_WRITE,
    PERMISSIONS.HOLIDAY_READ,
    PERMISSIONS.OFFICE_LOCATION_READ,
    PERMISSIONS.SETTINGS_READ,
    PERMISSIONS.DASHBOARD_EMPLOYEE,
];

/** Lead-of-team adds: first-line approval + team-read + project authoring. */
const TEAM_LEAD_ADDITIONS: readonly Permission[] = [
    PERMISSIONS.LEAVE_REQUEST_READ_TEAM,
    PERMISSIONS.LEAVE_REQUEST_APPROVE,
    PERMISSIONS.ATTENDANCE_READ_TEAM,
    PERMISSIONS.ATTENDANCE_CORRECTION_APPROVE,
    PERMISSIONS.TIMESHEET_READ,
    PERMISSIONS.PROJECT_WRITE,
    PERMISSIONS.PROJECT_ARCHIVE,
    PERMISSIONS.PROJECT_MEMBERS_WRITE,
    PERMISSIONS.SPRINT_WRITE,
    PERMISSIONS.STORY_WRITE,
    PERMISSIONS.TASK_TEMPLATE_WRITE,
    PERMISSIONS.SHARE_LINK_WRITE,
    PERMISSIONS.DASHBOARD_MANAGER,
    // BUG-039 — team leads need to see the role catalog so the Roles
    // tab on /admin/users/:id can render. Strictly metadata read; the
    // writes (role assignment / extras) remain admin-only via USER_WRITE
    // and ROLE_WRITE / USER_ROLE_CHANGE.
    PERMISSIONS.ROLE_READ,
];

/** Manager adds on top of team-lead: reports + billing + clients + audit-log read. */
const MANAGER_ADDITIONS: readonly Permission[] = [
    PERMISSIONS.PROJECT_CLIENTS_WRITE,
    PERMISSIONS.BILLING_RATE_READ,
    PERMISSIONS.REPORT_READ,
    PERMISSIONS.REPORT_EXPORT_WRITE,
    PERMISSIONS.LEAVE_BALANCE_READ_TEAM,
    PERMISSIONS.TIMESHEET_EDIT_OUT_OF_WINDOW,
];

const dedupe = (list: readonly Permission[]): Permission[] => Array.from(new Set(list));

// ─── System role definitions ──────────────────────────────────────────────

export const SYSTEM_ROLE_DEFINITIONS: readonly SystemRoleDefinition[] = [
    {
        key: SYSTEM_ROLE_KEYS.ADMIN,
        display_name: 'Admin',
        description:
            'Full platform access. The seeded super-role; satisfies every permission check via the system.admin wildcard.',
        // Just the wildcard. The middleware short-circuits any
        // `requirePermission(X)` for admins. Listing every individual
        // permission here would be redundant + drift over time.
        permissions: [PERMISSIONS.SYSTEM_ADMIN],
    },
    {
        key: SYSTEM_ROLE_KEYS.MANAGER,
        display_name: 'Manager',
        description: 'Team management — leave approvals, project ownership, reports, billing rates.',
        permissions: dedupe([...EMPLOYEE_BASE, ...TEAM_LEAD_ADDITIONS, ...MANAGER_ADDITIONS]),
    },
    {
        key: SYSTEM_ROLE_KEYS.TEAM_LEAD,
        display_name: 'Team Lead',
        description:
            'First-line approver for own reports + project author for projects they belong to. ' +
            'Sits between Manager and Employee — no billing, no cross-team reports, no user management.',
        permissions: dedupe([...EMPLOYEE_BASE, ...TEAM_LEAD_ADDITIONS]),
    },
    {
        key: SYSTEM_ROLE_KEYS.EMPLOYEE,
        display_name: 'Employee',
        description: 'Own tasks, own timesheet, own attendance, own leaves.',
        permissions: dedupe([...EMPLOYEE_BASE]),
    },
    {
        key: SYSTEM_ROLE_KEYS.CLIENT,
        display_name: 'Client',
        description:
            'Read-only view of projects they are a client on, plus task comments + attachments. ' +
            'Per-row visibility is enforced at the service layer (PROJECT_CLIENT_SCOPED_ROLES) — ' +
            'a client only ever sees projects where they appear in `client_ids`.',
        permissions: [
            PERMISSIONS.PROJECT_READ,
            PERMISSIONS.TASK_READ,
            PERMISSIONS.TASK_COMMENT_WRITE,
            // Clients today can attach files on tasks within their
            // visible projects (the legacy ATTACHMENT_WRITE_ROLES is
            // [admin, manager, employee, client]). Per-project visibility
            // is enforced at the service layer.
            PERMISSIONS.TASK_ATTACHMENT_WRITE,
            // Clients see the org-wide holiday calendar + leave types
            // catalog (read-only) — same as the pre-Step-47 behaviour.
            PERMISSIONS.HOLIDAY_READ,
            PERMISSIONS.LEAVE_TYPE_READ,
            PERMISSIONS.SETTINGS_READ,
            PERMISSIONS.DASHBOARD_CLIENT,
        ],
    },
];
