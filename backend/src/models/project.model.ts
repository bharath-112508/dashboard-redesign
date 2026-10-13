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
    withAllDefaultStatuses,
} from '../constants/project.js';
import { ISO_DATE_REGEX } from '../constants/holiday.js';

/**
 * `projects` — Data_Model.md §5.1.
 *
 * Per Data_Model the project document carries three embedded arrays:
 *  - `member_ids[]`          — internal staff with explicit access
 *  - `company_id`            — the client COMPANY this project belongs to
 *                              (nullable — internal projects have none)
 *  - `representative_ids[]`  — the project's client-side roster: the company's
 *                              `representative`s assigned to it, PLUS the
 *                              company's `client`s (see below)
 *  - `custom_task_statuses[]` — admin/manager-defined Kanban columns BEYOND
 *                               the implicit defaults (`to_do`, `in_progress`,
 *                               `review`, `done`)
 *
 * We do NOT split these into separate collections in Phase 1 — the read
 * patterns are dominated by "load the full project" and embedding keeps the
 * project visibility check (`member_ids ∋ user`) a single equality match
 * served by the `{ member_ids: 1 }` index.
 *
 * ── company_id vs representative_ids: which one is authoritative ──────────
 *
 * Both describe the client side of a project, so the winner must be stated:
 *
 *   - A `representative` sees a project iff `representative_ids ∋ them`.
 *   - A `client` (the company-level role) sees a project iff
 *     `company_id === their company`. **`company_id` is authoritative for
 *     that role** — a Client's access does NOT depend on the roster.
 *
 * Clients are *also* listed in `representative_ids` so a project's
 * client-side roster is one explicit field, but that entry is a
 * denormalised convenience maintained by the service layer (creating a
 * project seeds the roster with the company's clients). If it ever drifts,
 * a Client still sees their projects via `company_id` — drift costs display
 * accuracy, never access. The inverse design (deriving Client visibility
 * FROM the roster) would let one missed auto-add silently blind someone to
 * a project, so the denormalised field is deliberately the one that can be
 * wrong.
 *
 * A Client is company-scoped rather than roster-scoped because their job is
 * to assign representatives to their company's projects — they cannot staff
 * a project they cannot see, so roster-scoping them would deadlock every
 * newly created project.
 *
 * Invariant: every id in `representative_ids` must be a `client` or
 * `representative` whose `client_profile.company_id === this.company_id`.
 * Enforced in the service on every roster write.
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

// ─── Sub-docs: board settings (column limits, quick filters) ─────────────

export interface BoardWipLimit {
    status_key: string;
    limit: number;
}

export interface BoardQuickFilter {
    _id: Types.ObjectId;
    name: string;
    /** Shape validated by `patchProjectBodySchema` (filter dimensions). */
    criteria: Record<string, unknown>;
}

const boardWipLimitSchema = new Schema<BoardWipLimit>(
    {
        status_key: { type: String, required: true, trim: true },
        limit: { type: Number, required: true, min: 1, max: 999 },
    },
    { _id: false, versionKey: false }
);

const boardQuickFilterSchema = new Schema<BoardQuickFilter>(
    {
        name: { type: String, required: true, trim: true, maxlength: 40 },
        criteria: { type: Schema.Types.Mixed, default: {} },
    },
    { _id: true, versionKey: false, minimize: false }
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

/** A delivered project's support agreement: a monthly quota of hours until a date. */
export interface ProjectSupportPlan {
    until: string;
    quota_hours: number;
}

export interface ProjectDocument extends Document {
    _id: Types.ObjectId;
    name: string;
    code: string;
    description: string;
    start_date: string;
    end_date: string | null;
    status: ProjectStatus;
    is_archived: boolean;
    /** Internal projects: the area the work belongs to (redesign). '' when unset. */
    area: string;
    /** Support agreement for a project in maintenance (redesign). */
    support_plan: ProjectSupportPlan | null;
    member_ids: Types.ObjectId[];
    company_id: Types.ObjectId | null;
    representative_ids: Types.ObjectId[];
    custom_task_statuses: Types.DocumentArray<CustomTaskStatus>;
    default_status_orders: Types.DocumentArray<DefaultStatusOrder>;
    board_wip_limits: BoardWipLimit[];
    board_quick_filters: Types.DocumentArray<BoardQuickFilter>;
    /** Monotonic per-project issue-key counter. Incremented atomically on task
     *  create (task.service); never decremented, so keys are never reused. */
    task_seq: number;
    /**
     * When the project most recently entered `completed` (`null` otherwise).
     * Stamped by the service on the transition and cleared on the reverse, so
     * it is a true delivery moment rather than `updated_at` (which any edit
     * re-dates). Mirrors `Sprint.completed_at` / `Task.completed_at`.
     *
     * Two things read it, and both need the real moment rather than a date the
     * user typed:
     *  - the on-time verdict — `completed_at` (as an IST calendar date) vs
     *    `end_date`, which is the **target**, not the completion date
     *  - the delivery-scope freeze — a task created after this instant is
     *    post-delivery work (a client-reported bug against a shipped project)
     *    and is excluded from the progress rollup, so the bar keeps reading
     *    100% for the scope that was actually delivered
     *
     * `null` on a completed project is a legitimate state, not missing data: it
     * means the project was completed before this field existed and the audit
     * trail no longer holds the transition. Consumers must render "no verdict"
     * rather than inferring one — see `scripts/backfill-project-completed-at.ts`.
     */
    completed_at: Date | null;
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
                message: 'Enter the end date as a valid calendar date.',
            },
        },
        status: {
            type: String,
            required: true,
            enum: PROJECT_STATUS_VALUES,
            default: PROJECT_STATUSES.ACTIVE,
        },
        is_archived: { type: Boolean, required: true, default: false },
        area: { type: String, trim: true, default: '' },
        support_plan: {
            type: new Schema<ProjectSupportPlan>(
                {
                    until: { type: String, required: true, match: [ISO_DATE_REGEX, 'until must be YYYY-MM-DD'] },
                    quota_hours: { type: Number, required: true, min: 0 },
                },
                { _id: false }
            ),
            default: null,
        },
        member_ids: {
            type: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS }],
            default: [],
            validate: {
                // Cap is generous (200) but defensive against a runaway
                // upload of every user in the company; if you hit this, you
                // probably want a project group / department feature, not
                // a bigger array.
                validator: (v: Types.ObjectId[]) => v.length <= PROJECT_MEMBERS_MAX,
                message: `You can add at most ${PROJECT_MEMBERS_MAX} members to a project.`,
            },
        },
        company_id: {
            type: Schema.Types.ObjectId,
            ref: COLLECTIONS.COMPANIES,
            default: null,
        },
        representative_ids: {
            type: [{ type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS }],
            default: [],
            validate: {
                validator: (v: Types.ObjectId[]) => v.length <= PROJECT_CLIENTS_MAX,
                message: `You can add at most ${PROJECT_CLIENTS_MAX} representatives to a project.`,
            },
        },
        custom_task_statuses: {
            type: [customTaskStatusSchema],
            default: [],
            validate: {
                validator: (v: CustomTaskStatus[]) => v.length <= CUSTOM_STATUSES_PER_PROJECT_MAX,
                message: `You can add at most ${CUSTOM_STATUSES_PER_PROJECT_MAX} custom statuses to a project.`,
            },
        },
        // Project-scoped ordering of the five built-in statuses. Seeded
        // with the canonical 100/200/300/400 values on create; admins
        // re-order via the dedicated PATCH endpoint. Customs already
        // carry their own `order`; the FE merges the two arrays and
        // sorts by `order` to render the board.
        default_status_orders: {
            type: [defaultStatusOrderSchema],
            default: buildCanonicalDefaultOrders,
            validate: {
                // Each canonical key must appear exactly once — except one a
                // custom status already owns (a pre-`bug` project with its own
                // `bug`), which must not appear at all. Prevents drift (a key
                // disappearing, or two board columns for one key).
                validator: function (this: unknown, v: DefaultStatusOrder[]) {
                    const customs = (this as { custom_task_statuses?: Array<{ key: string }> }).custom_task_statuses;
                    const customKeys = new Set((customs ?? []).map((c) => c.key));
                    const expected = DEFAULT_TASK_STATUS_KEYS.filter((k) => !customKeys.has(k));
                    if (v.length !== expected.length) return false;
                    const seen = new Set<string>();
                    for (const entry of v) {
                        if (seen.has(entry.key)) return false;
                        seen.add(entry.key);
                    }
                    return expected.every((k) => seen.has(k));
                },
                message: 'Each built-in status must appear exactly once in the order.',
            },
        },
        board_wip_limits: { type: [boardWipLimitSchema], default: [] },
        board_quick_filters: { type: [boardQuickFilterSchema], default: [] },
        task_seq: { type: Number, required: true, default: 0, min: 0 },
        // No index: read only on rows the list/detail queries already loaded,
        // never used as a filter predicate.
        completed_at: { type: Date, required: false, default: null },
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
// A `representative`'s visibility is roster containment.
projectSchema.index({ representative_ids: 1 });
// A `client`'s visibility is company containment — THIS is the authoritative
// filter for that role, not the roster above.
projectSchema.index({ company_id: 1 });
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

// Safety net for the `bug` built-in: a project stored before the migration has
// four entries, which the exactly-the-built-ins validator would reject on ANY
// save. Fill missing built-ins in before validation.
projectSchema.pre('validate', function normaliseDefaultStatusOrders() {
    const current = (this.default_status_orders ?? []) as unknown as Array<{
        key: string;
        order: number;
        is_active: boolean;
    }>;
    if (current.length >= DEFAULT_TASK_STATUS_KEYS.length) return;
    const customKeys = ((this.custom_task_statuses ?? []) as Array<{ key: string }>).map((c) => c.key);
    const filled = withAllDefaultStatuses(current, customKeys);
    if (filled.length !== current.length) this.set('default_status_orders', filled);
});

export const Project: Model<ProjectDocument> = model<ProjectDocument>(COLLECTIONS.PROJECTS, projectSchema);
