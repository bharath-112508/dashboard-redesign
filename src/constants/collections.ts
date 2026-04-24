/**
 * MongoDB collection names (Data_Model.md §1–5).
 * Use these constants in all schema / model definitions and queries
 * to avoid magic strings and make renames safe.
 *
 * NOTE: lockout state (`failed_login_attempts`, `locked_until`) and MFA state
 * (`mfa_secret_encrypted`, `mfa_backup_codes_hashed`) live on the `users`
 * document — they are NOT separate collections.
 */
export const COLLECTIONS = {
    // Auth / identity
    USERS: 'users',
    REFRESH_TOKENS: 'refresh_tokens',
    PASSWORD_RESET_TOKENS: 'password_reset_tokens',

    // System config
    SYSTEM_SETTINGS: 'system_settings',
    HOLIDAYS: 'holidays',

    // Leave
    LEAVE_TYPES: 'leave_types',
    LEAVE_BALANCES: 'leave_balances',
    LEAVE_REQUESTS: 'leave_requests',
    COMP_OFF_LEDGER: 'comp_off_ledger',
    SL_MONTHLY_FORFEITURES: 'sl_monthly_forfeitures',

    // Attendance
    OFFICE_LOCATIONS: 'office_locations',
    ATTENDANCE_RECORDS: 'attendance_records',

    // Projects
    PROJECTS: 'projects',
    SPRINTS: 'sprints',
    STORIES: 'stories',
    TASKS: 'tasks',
    TASK_COMMENTS: 'task_comments',
    TASK_ATTACHMENTS: 'task_attachments',
    TASK_DEPENDENCIES: 'task_dependencies',
    PROJECT_MEMBERS: 'project_members',
    PROJECT_SHARE_LINKS: 'project_share_links',

    // Timesheets
    TIMESHEETS: 'timesheets',
    TIMESHEET_ENTRIES: 'timesheet_entries',

    // Cross-cutting
    NOTIFICATIONS: 'notifications',
    AUDIT_LOGS: 'audit_logs',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
