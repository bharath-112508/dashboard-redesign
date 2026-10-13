import { Types } from 'mongoose';

import { Notification } from '../models/notification.model.js';
import { NOTIFICATION_TYPES } from '../constants/notification.js';
import { expireDueLots } from '../services/comp-off.service.js';
import logger from '../utils/logger.js';

/**
 * Daily comp-off lot expiry (03:20 IST, after the 02:30 reconciliation).
 *
 * Walks every earned comp-off lot whose `expires_at` has lapsed and still
 * carries unconsumed `remaining_days`, writes an `expired` history row for
 * the lost days, zeroes the lot, and resyncs the owner's cached balance +
 * leave mirror. The heavy lifting is `expireDueLots` in the comp-off
 * service — it is idempotent (each lot is its own transaction, re-checked
 * inside) so a manual re-run on the same day never double-expires.
 *
 * After the sweep, this job best-effort DMs one in-app `Notification` per
 * affected user so the person whose days lapsed sees why their balance
 * dropped. Notification writes are wrapped individually — a flaky insert
 * for one user never blocks the others, and the whole job **never throws**
 * (mirrors the runner's non-throwing contract; the scheduler in
 * `jobs/index.ts` also catches, but expiry has no `runJob` lock because
 * the underlying sweep is idempotent by construction).
 *
 * Registered in `jobs/index.ts` and scheduled from `constants/jobs.ts`
 * (`JOB_NAMES.COMP_OFF_EXPIRY` / `JOB_SCHEDULES` / `compOffExpiryRunKey`).
 */
export const runCompOffExpiry = async (asOf?: Date): Promise<{ lotsExpired: number; usersNotified: number }> => {
    let result: { lotsExpired: number; perUser: Map<string, number> };
    try {
        result = await expireDueLots(asOf);
    } catch (err) {
        try {
            logger.error({ err, job: 'comp_off_expiry' }, 'Comp-off expiry sweep failed');
        } catch {
            // never propagate from a log line
        }
        return { lotsExpired: 0, usersNotified: 0 };
    }

    const { lotsExpired, perUser } = result;
    let usersNotified = 0;

    for (const [userId, days] of perUser) {
        try {
            await Notification.create({
                user_id: new Types.ObjectId(userId),
                type: NOTIFICATION_TYPES.SYSTEM,
                title: 'Comp-off expired',
                body: `${days} comp-off day(s) expired.`,
                link_url: '/comp-off',
            });
            usersNotified += 1;
        } catch (err) {
            // Best-effort: a failed notification must not abort the sweep
            // reporting or the remaining users' notifications.
            try {
                logger.warn(
                    { err, job: 'comp_off_expiry', user_id: userId },
                    'Failed to write comp-off expiry notification'
                );
            } catch {
                // never propagate from a log line
            }
        }
    }

    try {
        logger.info(
            { job: 'comp_off_expiry', lots_expired: lotsExpired, users_notified: usersNotified },
            'Comp-off expiry finished'
        );
    } catch {
        // never propagate from a log line
    }

    return { lotsExpired, usersNotified };
};
