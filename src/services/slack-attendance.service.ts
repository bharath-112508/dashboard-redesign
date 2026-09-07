import type { Types } from 'mongoose';

import { PERMISSIONS } from '../constants/permissions.js';
import { callerCan } from '../utils/caller-permissions.js';
import { resolvePermissionsForUser } from './role.service.js';

/**
 * May this caller check in/out or start/end a break from Slack?
 *
 * Keyed on `attendance.check_in_out` — the SAME permission
 * `requirePermission` enforces on `POST /attendance/check-in|check-out|
 * break/start|break/end` (attendance.routes.ts) — because the Slack
 * inbound path (break buttons, check-in/out buttons, `/checkin`,
 * `/checkout`) bypasses Express middleware entirely and `checkIn` /
 * `checkOut` / `startBreak` / `endBreak` (attendance.service.ts) have no
 * permission check of their own. This IS the authorization boundary for
 * those writes, not a UI nicety.
 *
 * Without it, a client-side caller (client/representative — neither holds
 * `attendance.check_in_out`, per `CLIENT_SIDE_BASE`) whose Slack email
 * happens to match their platform account could create and mutate their
 * own `AttendanceRecord` rows purely from Slack, a surface the web app
 * never exposes to them at all.
 */
export const callerCanCheckInOut = async (userId: Types.ObjectId): Promise<boolean> => {
    const { permissions } = await resolvePermissionsForUser(userId);
    return callerCan(permissions, PERMISSIONS.ATTENDANCE_CHECK_IN_OUT);
};
