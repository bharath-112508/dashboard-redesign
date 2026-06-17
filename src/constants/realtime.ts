/**
 * Real-time (SSE) topic taxonomy + path→topic mapping for the change-event
 * fan-out. Events are data-less — a topic name only — so broadcasting them
 * leaks nothing; clients refetch through the authed API (RBAC enforced).
 */
export const REALTIME_TOPICS = {
    ATTENDANCE: 'attendance',
    LEAVES: 'leaves',
    LEAVE_BALANCES: 'leave-balances',
    COMP_OFF: 'comp-off',
    HOLIDAYS: 'holidays',
    OFFICE_LOCATIONS: 'office-locations',
    PROJECTS: 'projects',
    SPRINTS: 'sprints',
    STORIES: 'stories',
    TASKS: 'tasks',
    TASK_COMMENTS: 'task-comments',
    TIMESHEETS: 'timesheets',
    BILLING_RATES: 'billing-rates',
    REPORTS: 'reports',
    NOTIFICATIONS: 'notifications',
    SETTINGS: 'settings',
    USERS: 'users',
    ROLES: 'roles',
} as const;

export type RealtimeTopic = (typeof REALTIME_TOPICS)[keyof typeof REALTIME_TOPICS];

/** SSE heartbeat — keeps the connection under Azure App Service's ~230s idle timeout. */
export const SSE_HEARTBEAT_MS = 25_000;

/**
 * Map the first `/api/v1/<base>` path segment → topic. A 2xx mutating request
 * to a mapped base publishes that topic. Unmapped segments publish nothing.
 */
export const PATH_TOPIC_MAP: Record<string, RealtimeTopic> = {
    attendance: REALTIME_TOPICS.ATTENDANCE,
    leaves: REALTIME_TOPICS.LEAVES,
    'leave-balances': REALTIME_TOPICS.LEAVE_BALANCES,
    'leave-types': REALTIME_TOPICS.LEAVES,
    'comp-off': REALTIME_TOPICS.COMP_OFF,
    holidays: REALTIME_TOPICS.HOLIDAYS,
    'office-locations': REALTIME_TOPICS.OFFICE_LOCATIONS,
    projects: REALTIME_TOPICS.PROJECTS,
    sprints: REALTIME_TOPICS.SPRINTS,
    stories: REALTIME_TOPICS.STORIES,
    tasks: REALTIME_TOPICS.TASKS,
    comments: REALTIME_TOPICS.TASK_COMMENTS,
    // Task attachments + per-project custom statuses are mutating routes whose
    // changes show up in task/board views, so map them onto those topics.
    attachments: REALTIME_TOPICS.TASKS,
    'project-custom-statuses': REALTIME_TOPICS.PROJECTS,
    timesheets: REALTIME_TOPICS.TIMESHEETS,
    'billing-rates': REALTIME_TOPICS.BILLING_RATES,
    reports: REALTIME_TOPICS.REPORTS,
    notifications: REALTIME_TOPICS.NOTIFICATIONS,
    settings: REALTIME_TOPICS.SETTINGS,
    users: REALTIME_TOPICS.USERS,
    roles: REALTIME_TOPICS.ROLES,
};
