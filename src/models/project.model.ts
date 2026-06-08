import { Schema, Types, model, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import {
    buildCanonicalDefaultOrders,
    CUSTOM_STATUSES_PER_PROJECT_MAX,
    CUSTOM_STATUS_KEY_MAX,
    CUSTOM_STATUS_KEY_REGEX,
    CUSTOM_STATUS_LABEL_MAX,
    DEFAULT_TASK_STATUS_KEYS,
    PROJECT_CLIENTS_MAX,
    PROJECT_CODE_MAX,
    PROJECT_CODE_REGEX,
    PROJECT_DESCRIPTION_MAX,
    PROJECT_MEMBERS_MAX,
    PROJECT_NAME_MAX,
    PROJECT_STATUSES,
    PROJECT_STATUS_VALUES,
    type ProjectStatus,
} from '../constants/project.js';
import { ISO_DATE_REGEX } from '../constants/holiday.js';

/**
 * `projects` — Data_Model.md §5.1.
 *
 * Per Data_Model the project document carries three embedded arrays:
 *  - `member_ids[]`          — internal staff with explicit access
 *  - `client_ids[]`          — client users (role=client) the project is shared with
 *  - `custom_task_statuses[]` — admin/manager-defined Kanban columns BEYOND
 *                               the implicit defaults (`to_do`, `in_progress`,
 *                               `review`, `done`)
 *
 * We do NOT split these into separate collections in Phase 1 — the read
 * patterns are dominated by "load the full project" and embedding keeps the
 * project visibility check (`member_ids ∋ user`) a single equality match
 * served by the `{ member_ids: 1 }` index.
 *
 * `is_archived` is reserved for the Phase 2 archive UI — there is no archive
 * endpoint exposed yet, only the field + index so historic data filters work.
 *
 * Each `custom_task_statuses[]` element gets its own auto-generated `_id`
 * (Mongoose default for sub-doc arrays). The top-level
 * `PATCH /project-custom-statuses/:id` endpoint looks the project up by
 * `custom_task_statuses._id` rather than treating the project's `code` + the
 * status `key` as a composite identifier — that keeps the URL stable across
 * key renames.
 */

// ─── Sub-doc: custom task status ─────────────────────────────────────────

export interface CustomTaskStatus {
    _id: Types.ObjectId;
    key: string;
    label: string;
    order: number;
    is_terminal: boolean;
    /** When false, the status column is hidden from the board / new task
     *  dropdowns, but tasks already assigned to it are kept (no data
     *  loss). Default `true` so existing rows continue to render. */
    is_active: boolean;
}

const customTaskStatusSchema = new Schema<CustomTaskStatus>(
    {
        key: {
            type: String,
            required: true,
            trim: true,
            maxlength: CUSTOM_STATUS_KEY_MAX,
            match: [CUSTOM_STATUS_KEY_REGEX, 'key must be lower_snake (a-z, 0-9, _)'],
        },
        label: { type: String, required: true, trim: true, maxlength: CUSTOM_STATUS_LABEL_MAX },
        order: { type: Number, required: true, min: 0, default: 0 },
        is_terminal: { type: Boolean, required: true, default: false },
        is_active: { type: Boolean, required: true, default: true },
    },
    { _id: true, timestamps: false, versionKey: false }
);

// ─── Sub-doc: default-status ordering ────────────────────────────────────
//
// Each project carries an `order` value for each of the four built-in
// statuses so admins can interleave defaults with custom columns on the
// board. `key` must be one of `DEFAULT_TASK_STATUS_KEYS`; `order` is a
// non-negative integer (no uniqueness constraint — ties are sorted by
// canonical key order, which gives a stable render).

export interface DefaultStatusOrder {
    key: string;
    order: number;
    /** Whether this built-in column is shown on the board. Default
     *  `true`; admins can deactivate individual built-ins (e.g. hide
     *  "review" for a project that doesn't use review steps). */
    is_active: boolean;
}

const defaultStatusOrderSchema = new Schema<DefaultStatusOrder>(
    {
        key: {
            type: String,
            required: true,
            enum: DEFAULT_TASK_STATUS_KEYS,
        },
        order: { type: Number, required: true, min: 0 },
        is_active: { type: Boolean, required: true, default: true },
    },
    { _id: false, timestamps: false, versionKey: false }
);

// ─── Project document ────────────────────────────────────────────────────

export interface ProjectDocument extends Document {
    _id: Types.ObjectId;
    name: string;
    code: string;
    description: string;
    start_date: string;
    end_date: string | null;
    status: ProjectStatus;
    is_archived: boolean;
    member_ids: Types.ObjectId[];
    client_ids: Types.ObjectId[];
    custom_task_statuses: Types.DocumentArray<CustomTaskStatus>;
    default_status_orders: Types.DocumentArray<DefaultStatusOrder>;
    created_by: Types.ObjectId;
    created_at: Date;
    updated_at: Date;
}

const projectSchema = new Schema<ProjectDocument>(
    {
        name: { type: String, required: true, trim: true, maxlength: PROJECT_NAME_MAX },
        code: {
            type: String,
            required: true,
            trim: true,
            uppercase: true,
            unique: true,
            maxlength: PROJECT_CODE_MAX,
            match: [PROJECT_CODE_REGEX, 'code must be uppercase (A-Z, 0-9, -, _) starting with a letter'],
        },
        description: { type: String, required: false, default: '', maxlength: PROJECT_DESCRIPTION_MAX },
        start_date: {
            type: String,
            required: true,
            match: [ISO_DATE_REGEX, 'start_date must be YYYY-MM-DD'],
        },
        end_date: {
            type: String,
            required: false,
            default: null,
            validate: {
                validator: (v: string | null) => v === null || ISO_DATE_REGEX.test(v),
                message: 'end_date must be YYYY-MM-DD or null',
            },
        },
        status: {
            type: String,
            required: true,
            enum: PROJECT_STATUS_VALUES,
            default: PROJECT_STATUSES.ACTIVE,
        },
        is_archived: { type: Boolean, required: true, default: false },
        member_ids: {
            type: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS }],
            default: [],
            validate: {
                // Cap is generous (200) but defensive against a runaway
                // upload of every user in the company; if you hit this, you
                // probably want a project group / department feature, not
                // a bigger array.
                validator: (v: Types.ObjectId[]) => v.length <= PROJECT_MEMBERS_MAX,
                message: `member_ids cannot exceed ${PROJECT_MEMBERS_MAX} entries`,
            },
        },
        client_ids: {
            type: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS }],
            default: [],
            validate: {
                validator: (v: Types.ObjectId[]) => v.length <= PROJECT_CLIENTS_MAX,
                message: `client_ids cannot exceed ${PROJECT_CLIENTS_MAX} entries`,
            },
        },
        custom_task_statuses: {
            type: [customTaskStatusSchema],
            default: [],
            validate: {
                validator: (v: CustomTaskStatus[]) => v.length <= CUSTOM_STATUSES_PER_PROJECT_MAX,
                message: `custom_task_statuses cannot exceed ${CUSTOM_STATUSES_PER_PROJECT_MAX} entries`,
            },
        },
        // Project-scoped ordering of the four built-in statuses. Seeded
        // with the canonical 100/200/300/400 values on create; admins
        // re-order via the dedicated PATCH endpoint. Customs already
        // carry their own `order`; the FE merges the two arrays and
        // sorts by `order` to render the board.
        default_status_orders: {
            type: [defaultStatusOrderSchema],
            default: buildCanonicalDefaultOrders,
            validate: {
                // Each of the four canonical keys must appear exactly once.
                // Prevents drift (e.g. a key disappearing or a duplicate
                // entry that would cause the board to render two columns
                // for the same key).
                validator: (v: DefaultStatusOrder[]) => {
                    if (v.length !== DEFAULT_TASK_STATUS_KEYS.length) return false;
                    const seen = new Set<string>();
                    for (const entry of v) {
                        if (seen.has(entry.key)) return false;
                        seen.add(entry.key);
                    }
                    for (const k of DEFAULT_TASK_STATUS_KEYS) {
                        if (!seen.has(k)) return false;
                    }
                    return true;
                },
                message: 'default_status_orders must contain each of the four built-in keys exactly once',
            },
        },
        created_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, required: true },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.PROJECTS,
    }
);

// Indexes per Data_Model §5.1.
//   `code` is already unique via the field-level `unique: true` above.
projectSchema.index({ status: 1, is_archived: 1 });
// M41 — `listProjects` default sort `{ created_at: -1 }` filtered by
// `status` + `is_archived`. The `{status, is_archived}` index above
// covers the predicate but Mongo can't walk it in `created_at` order.
// This compound serves both predicate AND sort; `{status, is_archived}`
// is left in place because it's the same prefix and dropping a live
// index across deployments is riskier than the modest write-amp cost.
projectSchema.index({ status: 1, is_archived: 1, created_at: -1 });
projectSchema.index({ member_ids: 1 });
projectSchema.index({ client_ids: 1 });
// Reverse-lookup for `PATCH /project-custom-statuses/:id` and friends —
// the partial filter ignores projects with an empty array so the index is
// only as wide as it needs to be.
projectSchema.index(
    { 'custom_task_statuses._id': 1 },
    { partialFilterExpression: { 'custom_task_statuses.0': { $exists: true } } }
);

/**
 * Text index for global search (Data_Model.md §Text Indexes line 1121;
 * Step 33 indexes audit). One text index per collection — combines all
 * three searchable fields. The Step-32 search service still uses regex
 * by default (Phase-4 cutover to `$text: {$search}` documented in its
 * upgrade-path note); this lands the index ahead of that migration.
 */
projectSchema.index({ name: 'text', code: 'text', description: 'text' });

export const Project: Model<ProjectDocument> = model<ProjectDocument>(COLLECTIONS.PROJECTS, projectSchema);
