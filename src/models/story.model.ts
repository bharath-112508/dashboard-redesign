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
    created_by: Types.ObjectId;
    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

const storySchema = new Schema<StoryDocument>(
    {
        project_id: { type: Schema.Types.ObjectId, ref: COLLECTIONS.PROJECTS, required: true },
        title: { type: String, required: true, trim: true, maxlength: STORY_TITLE_MAX },
        description: { type: String, required: true, default: '', maxlength: STORY_DESCRIPTION_MAX },
        position: { type: Number, required: true, default: 0, min: 0 },
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
