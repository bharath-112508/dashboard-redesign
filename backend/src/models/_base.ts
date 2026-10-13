import type { SchemaOptions } from 'mongoose';

/**
 * Shared Mongoose schema options:
 *  - `created_at` / `updated_at` in snake_case (plan §Dates & Timezones)
 *  - No `__v` version key
 *  - `toJSON` exposes `id` (string) and hides `_id`
 *  - Virtuals included on JSON output so computed properties work
 *
 * Individual models can override `toJSON.transform` to additionally strip
 * sensitive fields (e.g. `password_hash` on `users`). See `user.model.ts`.
 */
export const BASE_SCHEMA_OPTIONS: SchemaOptions = {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    versionKey: false,
    toJSON: {
        virtuals: true,
        transform: (_doc, ret: Record<string, unknown>) => {
            if (ret._id) {
                ret.id = String(ret._id);
                delete ret._id;
            }
            return ret;
        },
    },
    toObject: { virtuals: true },
};

/**
 * Build a `toJSON` transform that also strips the given sensitive fields.
 * Use this when composing `SchemaOptions` for a specific model.
 */
export const sensitiveToJSON = (sensitiveFields: readonly string[]): SchemaOptions['toJSON'] => ({
    virtuals: true,
    transform: (_doc, ret: Record<string, unknown>) => {
        if (ret._id) {
            ret.id = String(ret._id);
            delete ret._id;
        }
        for (const f of sensitiveFields) {
            delete ret[f];
        }
        return ret;
    },
});
