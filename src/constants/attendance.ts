import { ROLES, type RoleType } from './roles.js';

/**
 * Attendance constants — Step 8 (Data_Model.md §4, API_Contract.md §6).
 *
 * RBAC summary:
 *  - Employee-facing endpoints (check-in/out, /me, /me/today, qr-verify,
 *    submit correction request) are open to any authenticated internal role
 *    (employee, manager, admin). Clients cannot have attendance records.
 *  - Manager/admin-only endpoints: list-all (`GET /attendance`), direct
 *    correction (`PATCH /attendance/:id`), correction request approve/reject.
 *  - Listing correction requests: managers/admins see everything; employees
 *    see only their own (auto-filtered by user_id, mirroring `/users`).
 *
 * `local_date` is computed in the system's `default_timezone`
 * (`Asia/Kolkata` per Data_Model §1). Per-user timezone overrides are a
 * future v1.5 concern — Plan §3.4 notes "IST default (per-user configurable)".
 */

export const ATTENDANCE_INTERNAL_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER, ROLES.EMPLOYEE];

export const ATTENDANCE_REVIEW_ROLES: readonly RoleType[] = [ROLES.ADMIN, ROLES.MANAGER];

// ─── Enums ────────────────────────────────────────────────────────────────

export const ATTENDANCE_STATUSES = ['present', 'absent', 'on_leave', 'holiday', 'weekend', 'incomplete'] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const CHECK_METHODS = ['manual', 'qr'] as const;
export type CheckMethod = (typeof CHECK_METHODS)[number];

export const CORRECTION_REQUEST_STATUSES = ['pending', 'approved', 'rejected'] as const;
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
