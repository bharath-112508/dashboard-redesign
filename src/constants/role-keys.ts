/**
 * System role keys (Phase 4 Step 47).
 *
 * Five system roles are seeded on first boot. They cannot be
 * deleted or renamed via the role-CRUD endpoints (`is_system: true`
 * invariant is enforced on PATCH/DELETE). Their permission sets
 * MAY be amended by editing `system-role-definitions.ts` and
 * re-running the seeder.
 *
 * The string values mirror the legacy `ROLES` enum from before
 * Step 47. This is deliberate — every existing service that
 * branches on `caller.role === 'admin'` continues to work, because
 * the JWT's `role_keys` array uses these same string values.
 *
 * "team_lead" is new to Step 47 — sits between manager and
 * employee. Can approve leaves / corrections / read timesheets for
 * own reports (resolved via the `internal_profile.reporting_manager_id`
 * chain at the service layer), and can create + manage projects
 * they're a member of.
 */

export const SYSTEM_ROLE_KEYS = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    TEAM_LEAD: 'team_lead',
    EMPLOYEE: 'employee',
    CLIENT: 'client',
    REPRESENTATIVE: 'representative',
} as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[keyof typeof SYSTEM_ROLE_KEYS];
