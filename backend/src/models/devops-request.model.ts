import { Schema, Types, model, type Document } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * Redesign: a request the team raises to DevOps from Tickets, on a DevOps item.
 * `number` is the id the app uses. `logs` are the hours DevOps logs on it from
 * the Timesheet page, kept as the app shapes them.
 */
export interface DevopsRequestDocument extends Document {
    _id: Types.ObjectId;
    number: number;
    devops_key: string;
    project_id: Types.ObjectId | null;
    pname: string;
    rkey: string;
    type: string;
    prio: string;
    to: string;
    text: string;
    desc: string;
    due: string;
    start: string;
    est: string;
    by: string;
    by_id: Types.ObjectId;
    raised: string;
    status: string;
    comments: { by: string; by_id: Types.ObjectId; text: string; when: Date; side: 'tickets' | 'devops' }[];
    history: { by: string; text: string; when: Date }[];
    logs: unknown[];
    seen_t: number;
    status_seen: string;
    created_at: Date;
    updated_at: Date;
}

const devopsRequestSchema = new Schema<DevopsRequestDocument>(
    {
        number: { type: Number, required: true },
        devops_key: { type: String, required: true },
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, default: null },
        pname: { type: String, default: '' },
        rkey: { type: String, default: '' },
        type: { type: String, default: '' },
        prio: { type: String, default: '' },
        to: { type: String, default: '' },
        text: { type: String, required: true },
        desc: { type: String, default: '' },
        due: { type: String, default: '' },
        start: { type: String, default: '' },
        est: { type: String, default: '' },
        by: { type: String, required: true },
        by_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        raised: { type: String, default: '' },
        status: { type: String, default: 'Open' },
        comments: {
            type: [
                new Schema(
                    {
                        by: String,
                        by_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS },
                        text: String,
                        when: Date,
                        side: { type: String, enum: ['tickets', 'devops'] },
                    },
                    { _id: false }
                ),
            ],
            default: [],
        },
        history: { type: [new Schema({ by: String, text: String, when: Date }, { _id: false })], default: [] },
        logs: { type: [Schema.Types.Mixed], default: [] },
        seen_t: { type: Number, default: 0 },
        status_seen: { type: String, default: 'Open' },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.DEVOPS_REQUESTS }
);

devopsRequestSchema.index({ number: 1 }, { unique: true });
devopsRequestSchema.index({ project_id: 1 });

export const DevopsRequest = model<DevopsRequestDocument>('DevopsRequest', devopsRequestSchema);
