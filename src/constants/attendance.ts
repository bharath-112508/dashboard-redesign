import { ROLES, type RoleType } from './roles.js';

/**
 * Attendance constants — Step 8 (Data_Model.md §4, API_Contract.md §6).
 *
 * RBAC summary (Step 47):
 *  - Route gates: `attendance.check_in_out` (router-level — clients
 *    don't hold this permission, so they're blocked at the door) →
 *    individual endpoints further narrow to `attendance.read_team`
 *    (list / view others) or `attendance.correction_approve` (approve
 *    / reject correction requests, direct correction).
 *  - The service layer still uses `ATTENDANCE_REVIEW_ROLES` (below)
 *    for "is the caller-as-role allowed to review" semantics — this
 *    is role-string-based, not permission-based, and lives next to
 *    other reporting-chain logic.
 *
 * `local_date` is computed in the system's `default_timezone`
 * (`Asia/Kolkata` per Data_Model §1). Per-user timezone overrides are a
 * future v1.5 concern — Plan §3.4 notes "IST default (per-user configurable)".
 */

/**
 * Step 47: Team Lead is a first-line approver for own-reports —
 * `attendance.correction_approve` is in their permission bundle.
 * Service-layer scoping (caller-is-reporting-manager check) still
 * narrows them to actual reports.
 */
export const ATTENDANCE_REVIEW_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.TEAM_LEAD];

// ─── Enums ────────────────────────────────────────────────────────────────

export const ATTENDANCE_STATUSES = ['present', 'absent', 'on_leave', 'holiday', 'weekend', 'incomplete'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CHECK_METHODS = ['manual', 'qr'] as const;
export type CheckMethod = (typeof CHECK_METHODS)[number];

export const BREAK_TYPES = ['lunch', 'tea', 'other'] as const;
export type BreakType = (typeof BREAK_TYPES)[number];

/** `slack_status` = started/ended by the user's Slack profile status (🍔/☕/break). */
export const BREAK_SOURCES = ['slack', 'app', 'slack_status'] as const;
export type BreakSource = (typeof BREAK_SOURCES)[number];

/** Default soft daily break allowance (minutes). Admin-configurable in settings. */
export const DEFAULT_BREAK_ALLOWANCE_MINUTES = 60;

// M49 — `cancelled` joins the lifecycle. The owner (employee) can
// withdraw a pending request before a reviewer acts on it, so they
// can submit a replacement without tripping the
// `CORRECTION_REQUEST_ALREADY_PENDING` guard. Reviewer actions
// (approve/reject) and cancel are mutually exclusive — once any of
// them lands, the row is terminal.
export const CORRECTION_REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;
export type CorrectionRequestStatus = (typeof CORRECTION_REQUEST_STATUSES)[number];

// ─── Date-range listing caps ──────────────────────────────────────────────

/**
 * Max span (in days) accepted on `?from_date=...&to_date=...` queries against
 * `attendance_records`. Caps the worst-case page-aggregation cost so a single
 * caller can't pull a year of records with one request.
 */
export const ATTENDANCE_DATE_RANGE_MAX_DAYS = 92; // ~3 months

// ─── Geofence helper ──────────────────────────────────────────────────────

/**
 * Haversine distance between two lat/long pairs, in metres.
 * Used by check-in to enforce `attendance.geofence` from `system_settings`
 * (off by default; Plan §3.2 + Data_Model §2.1).
 */
export const haversineDistanceMeters = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const earthRadiusM = 6_371_000;
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * earthRadiusM * Math.asin(Math.sqrt(a));
};

// ─── Reasoning fields ─────────────────────────────────────────────────────

export const CORRECTION_REASON_MIN = 5;
export const CORRECTION_REASON_MAX = 1000;
export const CORRECTION_REMARKS_MAX = 1000;
export const ATTENDANCE_NOTES_MAX = 1000;
