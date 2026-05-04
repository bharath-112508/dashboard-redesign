import { z } from 'zod';

/**
 * Path-param schema for `/auth/sessions/:id/revoke` (Step 27).
 *
 * Sessions are stored as `refresh_tokens` rows; the `:id` is the row's
 * Mongo ObjectId. The list endpoint takes no params and returns the
 * caller's active sessions only — no validator needed.
 */
const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Must be a valid ObjectId');

export const sessionIdPathSchema = z.object({ id: objectIdSchema });
export type SessionIdPath = z.infer<typeof sessionIdPathSchema>;
