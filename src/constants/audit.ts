/**
 * Audit-log constants (Data_Model.md §7.2, API_Contract.md §12,
 * Company_Management_Plan.md §7.5).
 *
 * Phase 1 is **write-only** — there is no GET endpoint until Phase 3 Step 31.
 * The collection is the durable paper trail for every "sensitive" action; the
 * dispatcher records on best-effort and never blocks the primary write.
 *
 * Action naming convention:
 *   `<resource>.<verb>` — lower snake/dot. Resource is the domain (`user`,
 *   `auth`, `leave`, `settings`); verb is past-tense or imperative depending
 *   on what reads more naturally for the audit screen ("user.deactivate" vs
 *   "user.deactivated"). We use the imperative form to match Data_Model §7.2's
 *   examples.
 *
 * Failure policy (mirrors `NOTIFICATION_DISPATCH_FAILED`):
 *   - `audit.service.recordAudit` swallows DB errors and logs at warn level
 *     with `AUDIT_WRITE_FAILED`. Operators grep for that code to find dropped
 *     events.
 */

import { ROLES, type RoleType } from './roles.js';

// ─── Actions whitelist (Data_Model.md §7.2 examples + Phase 1 hookups) ──

export const AUDIT_ACTIONS = {
    // User lifecycle (admin invite + role mgmt)
    USER_CREATE: 'user.create',
    USER_ROLE_CHANGE: 'user.role_change',
    USER_DEACTIVATE: 'user.deactivate',
    USER_REACTIVATE: 'user.reactivate',

    // Auth / credentials
    AUTH_PASSWORD_CHANGE: 'auth.password_change',
    AUTH_PASSWORD_RESET: 'auth.password_reset',
    AUTH_MFA_ENABLE: 'auth.mfa_enable',
    AUTH_MFA_DISABLE: 'auth.mfa_disable',
    AUTH_MFA_REGENERATE_BACKUP_CODES: 'auth.mfa_regenerate_backup_codes',

    // System config
    SETTINGS_UPDATE: 'settings.update',

    // Leave lifecycle (Company_Management_Plan §2.4 — note on negative-CL approval)
    LEAVE_APPROVE: 'leave.approve',
    LEAVE_REJECT: 'leave.reject',
    LEAVE_CANCEL: 'leave.cancel',

    // Scheduled jobs (Step 14). One generic "run" action; per-job detail
    // lives in `metadata.{job_name, run_key, summary}` so the action enum
    // stays small as we add jobs over time.
    SYSTEM_JOB_RUN: 'system.job_run',
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

export const AUDIT_ACTION_VALUES: readonly AuditAction[] = Object.values(AUDIT_ACTIONS);

// ─── target_entity.kind whitelist ────────────────────────────────────────
//
// Free-form strings work too; the whitelist documents the kinds Phase 1
// emits so the future Step-31 admin UI can switch on a known set.

export const AUDIT_TARGET_KINDS = {
    USER: 'user',
    LEAVE_REQUEST: 'leave_request',
    SYSTEM_SETTINGS: 'system_settings',
    JOB: 'job',
} as const;

export type AuditTargetKind = (typeof AUDIT_TARGET_KINDS)[keyof typeof AUDIT_TARGET_KINDS];

// ─── Actor-role values stored in `actor_role` snapshot ───────────────────
//
// Authenticated calls record one of `ROLES`; unauthenticated paths (forgot /
// reset password, MFA challenge before tokens are issued) record `'system'`
// when the action is performed on behalf of a known user via a verified
// token, and `'unauthenticated'` when there is no token at all.

export const AUDIT_ACTOR_ROLES = {
    ...ROLES,
    SYSTEM: 'system',
    UNAUTHENTICATED: 'unauthenticated',
} as const;

export type AuditActorRole = RoleType | 'system' | 'unauthenticated';

// ─── Field caps ──────────────────────────────────────────────────────────
//
// Snapshots (`before` / `after`) are strictly bounded so a runaway diff
// payload (e.g. all-of-system_settings) doesn't bloat a single audit row.
// We don't truncate silently — a snapshot that exceeds the cap is dropped
// from the row and the action is recorded with `before/after = null` plus
// a `metadata.snapshot_dropped = true` flag.

export const AUDIT_ACTION_MAX = 80;
export const AUDIT_TARGET_KIND_MAX = 80;
export const AUDIT_SNAPSHOT_BYTES_MAX = 16 * 1024; // 16 KiB per snapshot
export const AUDIT_METADATA_BYTES_MAX = 4 * 1024; // 4 KiB for ip + ua + extras

// Pagination defaults are reserved for the Phase 3 read endpoint; defining
// them here keeps the constant collocated with the rest of the audit shape.
export const AUDIT_LIST_DEFAULT_LIMIT = 50;
export const AUDIT_LIST_MAX_LIMIT = 200;
