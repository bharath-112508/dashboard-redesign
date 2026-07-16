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
