/**
 * User roles (plan §2.2 / API_Contract Appendix A).
 *
 * Step 47 (Phase 4) added `TEAM_LEAD` between manager and employee in
 * the system-role hierarchy. The legacy `users.role` enum is the
 * denormalized cache for the **first** of a user's role_keys, so adding
 * the value here lets a Team Lead user's `users.role` field hold
 * `'team_lead'` — and the user model picks it up automatically because
 * its enum validator reads `Object.values(ROLES)`.
 */
export const ROLES = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    TEAM_LEAD: 'team_lead',
    EMPLOYEE: 'employee',
    /** The client organisation's company-level person. See `companies`. */
    CLIENT: 'client',
    /** A client organisation's project-scoped person. Sees only assigned projects. */
    REPRESENTATIVE: 'representative',
} as const;

export type RoleType = (typeof ROLES)[keyof typeof ROLES];

/**
 * The client-side roles — external people who belong to a client company, not
 * the internal workforce. Exclude these anywhere you count/list "staff" (e.g.
 * the team-attendance roster + workforce headcounts) so client-side people
 * don't leak into staff-only surfaces. Adding a new client-side role here fixes
 * every consumer at once.
 */
export const CLIENT_SIDE_ROLES: RoleType[] = [ROLES.CLIENT, ROLES.REPRESENTATIVE];
