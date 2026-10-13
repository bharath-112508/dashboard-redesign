import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { STORY_DESCRIPTION_MAX, STORY_TITLE_MAX } from '../constants/story.js';

/**
 * `stories` — Data_Model.md §5.3.
 *
 * A *minimal* document by design — derived fields (`task_count`,
 * `derived_status`, `sprint_ids`, `progress_percent`) are computed at read
 * time from the `tasks` collection (see `story.service.computeDerivedFields`).
 * Persisting them would mean reconciling on every task write, which is the
 * exact treadmill we want to avoid in Phase 1.
 *
 * `description` is required-but-can-be-empty so the field always exists in
 * the document — that lets the FE bind to it without an `?? ''` fallback
 * and keeps the API_Contract response shape stable.
 *
 * `position` is a dense integer per project; the reorder logic in the
 * service shifts neighbours rather than using fractional ranks. For the
 * Phase 1 target of ~hundreds of stories per project this is fine; if we
 * hit thousands we can switch to fractional ranks without changing the
 * field type.
 */

export interface StoryDocument extends Document {
    _id: Types.ObjectId;
    project_id: Types.ObjectId;
    title: string;
    description: string;
    position: number;
    // Redesign: the epic document. All optional with empty defaults.
    goal: string;
    user_story: string;
    criteria: string[];
    /** Indexes of `criteria` that are met. */
    criteria_done: number[];
    target_date: string | null;
    in_scope: string[];
    out_scope: string[];
    requirements: string[];
    risks: string[];
    open_questions: string[];
    created_by: Types.ObjectId;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const storySchema = new Schema<StoryDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        title: { type: String, required: true, trim: true, maxlength: STORY_TITLE_MAX },
        // `required: false`, matching Project and Task. It was `required: true`
        // with `default: ''` — a combination Mongoose can never satisfy, because
        // an empty string fails its `required` check for a String. Since the
        // create dialog omits the field when the box is blank and the validator
        // then defaults it to `''`, creating an epic without a description
        // always 400'd with "Path `description` is required."
        description: { type: String, required: false, default: '', maxlength: STORY_DESCRIPTION_MAX },
        position: { type: Number, required: true, default: 0, min: 0 },
        goal: { type: String, default: '' },
        user_story: { type: String, default: '' },
        criteria: { type: [String], default: [] },
        criteria_done: { type: [Number], default: [] },
        target_date: { type: String, default: null },
        in_scope: { type: [String], default: [] },
        out_scope: { type: [String], default: [] },
        requirements: { type: [String], default: [] },
        risks: { type: [String], default: [] },
        open_questions: { type: [String], default: [] },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.STORIES,
    }
);

// Indexes per Data_Model §5.3.
//   - {project_id, position}   → story-board ordering (the dominant read).
//   - {project_id, created_at} → activity-feed style "newest first" queries.
//   - text(title, description) → joins the global-search index set.
storySchema.index({ project_id: 1, position: 1 });
storySchema.index({ project_id: 1, created_at: -1 });
storySchema.index({ title: 'text', description: 'text' });

export const Story: Model<StoryDocument> = model<StoryDocument>(COLLECTIONS.STORIES, storySchema);
