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
    COMP_OFF_ACCRUAL_DAYS: 'comp_off_accrual_days',
    SL_MONTHLY_FORFEITURES: 'sl_monthly_forfeitures',

    // Attendance
    OFFICE_LOCATIONS: 'office_locations',
    ATTENDANCE_RECORDS: 'attendance_records',
    ATTENDANCE_CORRECTION_REQUESTS: 'attendance_correction_requests',

    // Clients
    COMPANIES: 'companies',

    // Projects
    PROJECTS: 'projects',
    SPRINTS: 'sprints',
    STORIES: 'stories',
    TASKS: 'tasks',
    TASK_COMMENTS: 'task_comments',
    TASK_ATTACHMENTS: 'task_attachments',
    TASK_DEPENDENCIES: 'task_dependencies',
    TASK_ACTIVITIES: 'task_activities',
    PROJECT_MEMBERS: 'project_members',
    PROJECT_SHARE_LINKS: 'project_share_links',

    // Timesheets
    TIMESHEETS: 'timesheets',
    TIMESHEET_ENTRIES: 'timesheet_entries',
    /** Redesign: weeks a person has submitted (their time is locked). */
    TIMESHEET_WEEKS: 'timesheet_weeks',
    DEVOPS_ITEMS: 'devops_items',
    CLIENT_QUESTIONS: 'client_questions',
    DEVOPS_REQUESTS: 'devops_requests',
    BILLING_RATES: 'billing_rates',

    // Invoicing (client engagements + invoices)
    ENGAGEMENTS: 'engagements',
    INVOICES: 'invoices',
    INVOICE_COUNTERS: 'invoice_counters',

    // Cost rates & margin (Billing Phase 2)
    COST_RATES: 'cost_rates',

    // Cross-cutting
    NOTIFICATIONS: 'notifications',
    PUSH_SUBSCRIPTIONS: 'push_subscriptions',
    AUDIT_LOGS: 'audit_logs',
    JOB_RUNS: 'job_runs',
    REPORT_EXPORTS: 'report_exports',
    AUDIT_ARCHIVES: 'audit_archives',
    AUDIT_LOG_MIRRORS: 'audit_log_mirrors',
    MFA_SESSION_USED_JTIS: 'mfa_session_used_jtis',
    TASK_TEMPLATES: 'task_templates',
    REPORT_PRESETS: 'report_presets',
    REPORT_SUBSCRIPTIONS: 'report_subscriptions',
    ROLES: 'roles',

    // Payroll & certificates
    PAYROLL_PROFILES: 'payroll_profiles',
    SALARY_STRUCTURES: 'salary_structures',
    PAYSLIPS: 'payslips',
    LETTERS: 'letters',
} as const;

export type CollectionName = (typeof COLLECTIONS)[keyof typeof COLLECTIONS];
