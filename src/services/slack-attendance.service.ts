import type { Types } from 'mongoose';

import type { BreakType } from '../constants/attendance.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { PERMISSIONS } from '../constants/permissions.js';
import { callerCan } from '../utils/caller-permissions.js';
import { endBreak, getOpenBreak, startBreak } from './attendance.service.js';
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

/**
 * Map a Slack profile status to a break type: 🍔 / "lunch" → lunch,
 * ☕ / "tea" → tea, any other status mentioning "break" / "brb" / "be right
 * back" → other. Anything else (incl. a cleared status) → null.
 */
export const breakTypeFromSlackStatus = (emoji: string | undefined, text: string | undefined): BreakType | null => {
    const t = (text ?? '').toLowerCase();
    if (emoji === ':hamburger:' || /\blunch\b/.test(t)) return 'lunch';
    if (emoji === ':coffee:' || /\btea\b/.test(t)) return 'tea';
    if (/\bbreak\b|\bbrb\b|be right back/.test(t)) return 'other';
    return null;
};

/** Conflicts that just mean "nothing to do" (not checked in, raced another write). */
const BENIGN_CODES: ReadonlySet<string> = new Set([
    ERROR_CODES.NOT_CHECKED_IN,
    ERROR_CODES.ALREADY_ON_BREAK,
    ERROR_CODES.NOT_ON_BREAK,
]);

/**
 * Reconcile today's break with the user's Slack status (fired from the
 * `user_profile_changed` event). Only breaks this path started
 * (`source: 'slack_status'`) are ever ended or switched here — a break begun
 * from the app or a Slack button is left alone, since Slack fires this event
 * for ANY profile edit, not only status changes.
 *
 * Returns true when attendance changed.
 */
export const syncBreakFromSlackStatus = async (
    userId: Types.ObjectId,
    breakType: BreakType | null
): Promise<boolean> => {
    try {
        const open = await getOpenBreak(userId);
        const ownedBySlackStatus = open?.start.source === 'slack_status';
        if (!breakType) {
            if (!ownedBySlackStatus) return false;
            await endBreak(userId, 'slack_status');
            return true;
        }
        if (open) {
            if (open.break_type === breakType || !ownedBySlackStatus) return false;
            await endBreak(userId, 'slack_status'); // 🍔 → ☕: close lunch, open tea
        }
        await startBreak(userId, breakType, 'slack_status');
        return true;
    } catch (err: unknown) {
        if (BENIGN_CODES.has((err as { code?: string })?.code ?? '')) return false;
        throw err;
    }
};
