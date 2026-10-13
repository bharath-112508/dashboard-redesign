import { Types } from 'mongoose';

import { Notification, type NotificationDocument } from '../models/notification.model.js';
import { AppError } from '../utils/app-error.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import type { PaginationMeta } from '../utils/api-response.js';
import type { ListNotificationsQuery } from '../validators/notification.validator.js';

/**
 * Notification CRUD service (API_Contract §11).
 *
 * All endpoints are owner-scoped — every query is filtered by `user_id =
 * caller.id`. Mark / dismiss for someone else's notification returns 404 with
 * `RESOURCE_NOT_FOUND` (we don't differentiate "not yours" from "doesn't
 * exist" so the bell can't be used as an existence probe).
 *
 * Mark-as-read is idempotent: marking an already-read row is a 200 no-op so
 * the FE can fire off the action without extra state checks.
 */

type Filter = Record<string, unknown>;

const toPublic = (doc: NotificationDocument): Record<string, unknown> => doc.toJSON() as Record<string, unknown>;

// ─── GET /notifications ──────────────────────────────────────────────────

export const listNotifications = async (
    query: ListNotificationsQuery,
    caller_id: Types.ObjectId
): Promise<{ data: Record<string, unknown>[]; meta: PaginationMeta }> => {
    const filter: Filter = { user_id: caller_id };
    if (query.is_read !== undefined) filter.is_read = query.is_read;
    if (query.type !== undefined) filter.type = query.type;

    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
        Notification.find(filter).sort({ created_at: -1, _id: -1 }).skip(skip).limit(query.limit),
        Notification.countDocuments(filter),
    ]);

    return {
        data: rows.map(toPublic),
        meta: {
            page: query.page,
            limit: query.limit,
            total,
            total_pages: Math.max(1, Math.ceil(total / query.limit)),
        },
    };
};

// ─── GET /notifications/unread-count ─────────────────────────────────────

export const unreadCount = async (caller_id: Types.ObjectId): Promise<number> => {
    return Notification.countDocuments({ user_id: caller_id, is_read: false });
};

// ─── POST /notifications/:id/read ────────────────────────────────────────

export const markRead = async (id: Types.ObjectId, caller_id: Types.ObjectId): Promise<Record<string, unknown>> => {
    // Atomic conditional update — only the owner can flip the flag, and we
    // only set `read_at` on the transition (not on subsequent re-marks).
    const updated = await Notification.findOneAndUpdate(
        { _id: id, user_id: caller_id, is_read: false },
        { $set: { is_read: true, read_at: new Date() } },
        { new: true }
    );

    if (updated) return toPublic(updated);

    // Either the row is already read (idempotent: return the current row) or
    // it doesn't exist for this user (404).
    const existing = await Notification.findOne({ _id: id, user_id: caller_id });
    if (!existing) {
        throw AppError.notFound('Notification not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
    return toPublic(existing);
};

// ─── POST /notifications/read-all ────────────────────────────────────────

export const markAllRead = async (caller_id: Types.ObjectId): Promise<{ updated: number }> => {
    const now = new Date();
    const result = await Notification.updateMany(
        { user_id: caller_id, is_read: false },
        { $set: { is_read: true, read_at: now } }
    );
    return { updated: result.modifiedCount };
};

// ─── DELETE /notifications/:id ───────────────────────────────────────────

export const dismissNotification = async (id: Types.ObjectId, caller_id: Types.ObjectId): Promise<void> => {
    const result = await Notification.findOneAndDelete({ _id: id, user_id: caller_id });
    if (!result) {
        throw AppError.notFound('Notification not found', ERROR_CODES.RESOURCE_NOT_FOUND);
    }
};
