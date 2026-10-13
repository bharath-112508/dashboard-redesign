import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    NOTIFICATION_BODY_MAX,
    NOTIFICATION_LINK_URL_MAX,
    NOTIFICATION_TITLE_MAX,
    NOTIFICATION_TYPE_VALUES,
    type NotificationType,
} from '../constants/notification.js';

/**
 * `notifications` — Data_Model.md §7.1.
 *
 * In-app notification center items. One row per recipient × event (so a leave
 * submitted by employee X with three reviewers fans out to three rows).
 *
 * `related_entity` lets the FE deep-link to the source record without having
 * to encode it in `link_url` parsing — `{ kind, id }` is structured enough
 * that future kinds (e.g. `task`, `attendance_correction_request`) can ride
 * on the same field shape.
 *
 * Indexes mirror the spec exactly:
 *   - `{ user_id: 1, created_at: -1 }` powers the bell list (default sort).
 *   - `{ user_id: 1, is_read: 1 }` powers the unread-count badge query.
 */

export interface NotificationRelatedEntity {
    kind: string;
    id: Types.ObjectId;
}

export interface NotificationDocument extends Document {
    _id: Types.ObjectId;
    user_id: Types.ObjectId;
    type: NotificationType;
    title: string;
    body: string;
    link_url: string;
    related_entity: NotificationRelatedEntity | null;
    is_read: boolean;
    read_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

const relatedEntitySchema = new Schema<NotificationRelatedEntity>(
    {
        kind: { type: String, required: true, trim: true, maxlength: 80 },
        id: { type: Schema.Types.ObjectId, required: true },
    },
    { _id: false }
);

const notificationSchema = new Schema<NotificationDocument>(
    {
        user_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.USERS,
            required: true,
            index: true,
        },
        type: {
            type: String,
            required: true,
            enum: NOTIFICATION_TYPE_VALUES as readonly string[],
        },
        title: { type: String, required: true, trim: true, maxlength: NOTIFICATION_TITLE_MAX },
        body: { type: String, required: true, trim: true, maxlength: NOTIFICATION_BODY_MAX },
        link_url: { type: String, required: false, default: '', trim: true, maxlength: NOTIFICATION_LINK_URL_MAX },
        related_entity: { type: relatedEntitySchema, required: false, default: null },
        is_read: { type: Boolean, required: true, default: false, index: true },
        read_at: { type: Date, required: false, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.NOTIFICATIONS,
    }
);

// Composite indexes from Data_Model §7.1.
// The single-field `user_id` and `is_read` indexes above are kept because
// MongoDB will pick the best index per query; the composites are the
// frequently-hit access patterns (bell list + unread badge).
notificationSchema.index({ user_id: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, is_read: 1 });

export const Notification: Model<NotificationDocument> = model<NotificationDocument>(
    COLLECTIONS.NOTIFICATIONS,
    notificationSchema
);
