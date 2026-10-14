import { Schema, Types, model, type Document } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * Redesign: one DevOps board item per project. `key` (OPS-<n>) is the id the
 * app uses; `data` holds the board's own fields (status, follow-up steps, dev
 * phases, dates, notes, activity) as the app shapes them. `project_id` is
 * kept outside `data` so client visibility is one query.
 */
export interface DevopsItemDocument extends Document {
    _id: Types.ObjectId;
    key: string;
    project_id: Types.ObjectId;
    data: Record<string, unknown>;
    created_by: Types.ObjectId;
    updated_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const devopsItemSchema = new Schema<DevopsItemDocument>(
    {
        key: { type: String, required: true },
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        data: { type: Schema.Types.Mixed, default: {} },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.DEVOPS_ITEMS, minimize: false }
);

devopsItemSchema.index({ key: 1 }, { unique: true });
devopsItemSchema.index({ project_id: 1 });

export const DevopsItem = model<DevopsItemDocument>('DevopsItem', devopsItemSchema);
