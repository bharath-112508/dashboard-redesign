import { Schema, Types, model, type Document } from 'mongoose';
import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';

/**
 * Redesign: a question the team raises to a client (from the DevOps board or
 * Tickets) and its conversation. `number` is the id the app shows (Q-<n>).
 * `project_id` is resolved from the ticket, DevOps item or sprint when it is
 * raised, so a client sees only their company's questions.
 */
export interface QuestionMessage {
    who: string;
    by_id: Types.ObjectId;
    side: 'client' | 'team';
    text: string;
    files: unknown[];
    when: Date;
}

export interface ClientQuestionDocument extends Document {
    _id: Types.ObjectId;
    number: number;
    project_id: Types.ObjectId | null;
    task_id: Types.ObjectId | null;
    devops_key: string | null;
    sprint: string | null;
    title: string;
    text: string;
    photos: unknown[];
    qtype: string;
    qprio: string;
    from_devops: boolean;
    by: string;
    by_id: Types.ObjectId;
    solved: boolean;
    seen_t: number;
    messages: QuestionMessage[];
    created_at: Date;
    updated_at: Date;
}

const messageSchema = new Schema<QuestionMessage>(
    {
        who: { type: String, required: true },
        by_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        side: { type: String, enum: ['client', 'team'], required: true },
        text: { type: String, default: '' },
        files: { type: [Schema.Types.Mixed], default: [] },
        when: { type: Date, required: true },
    },
    { _id: false }
);

const clientQuestionSchema = new Schema<ClientQuestionDocument>(
    {
        number: { type: Number, required: true },
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, default: null },
        task_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.TASKS, default: null },
        devops_key: { type: String, default: null },
        sprint: { type: String, default: null },
        title: { type: String, required: true },
        text: { type: String, default: '' },
        photos: { type: [Schema.Types.Mixed], default: [] },
        qtype: { type: String, default: '' },
        qprio: { type: String, default: '' },
        from_devops: { type: Boolean, default: false },
        by: { type: String, required: true },
        by_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        solved: { type: Boolean, default: false },
        seen_t: { type: Number, default: 0 },
        messages: { type: [messageSchema], default: [] },
    },
    { ...BASE_SCHEMA_OPTIONS, collection: COLLECTIONS.CLIENT_QUESTIONS }
);

clientQuestionSchema.index({ number: 1 }, { unique: true });
clientQuestionSchema.index({ project_id: 1 });

export const ClientQuestion = model<ClientQuestionDocument>('ClientQuestion', clientQuestionSchema);
