import { z } from 'zod';

import { SLACK_BOT_TOKEN_MAX, SLACK_TEXT_MAX } from '../constants/slack.js';

/**
 * Zod schemas for `/settings/slack/*` (Step 25).
 *
 * The shared `/settings` PATCH endpoint already accepts the slack
 * section via `settings.validator.ts`. The dedicated
 * `PATCH /settings/slack` lives here so the FE can post a partial
 * Slack-only payload without having to wrap it in `{ slack: ... }`.
 */

const slackChannelsPatchSchema = z
    .object({
        leaves: z.string().min(1).optional(),
        attendance: z.string().min(1).optional(),
        projects: z.string().min(1).optional(),
        timesheet: z.string().min(1).optional(),
        general: z.string().min(1).optional(),
    })
    .partial();

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

const attendanceNudgesPatchSchema = z
    .object({
        enabled: z.boolean().optional(),
        check_in_time: z.string().regex(HHMM_REGEX, 'Must be HH:MM (24-hour)').optional(),
        checkout_reminder_time: z.string().regex(HHMM_REGEX, 'Must be HH:MM (24-hour)').optional(),
    })
    .partial();

export const patchSlackSettingsBodySchema = z
    .object({
        enabled: z.boolean().optional(),
        channels: slackChannelsPatchSchema.optional(),
        // Empty string is the explicit "clear" signal. Null clears
        // too. A non-empty string is stored verbatim. We don't
        // validate the `xoxb-` prefix here because Slack reserves the
        // right to introduce new token shapes — the workspace either
        // accepts the token at send time or doesn't.
        bot_token: z.string().max(SLACK_BOT_TOKEN_MAX).nullable().optional(),
        attendance_nudges: attendanceNudgesPatchSchema.optional(),
    })
    .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be supplied' });
export type PatchSlackSettingsBody = z.infer<typeof patchSlackSettingsBodySchema>;

// ─── POST /settings/slack/test-message ───────────────────────────────────

export const testMessageBodySchema = z.object({
    /**
     * Required — admin picks the destination explicitly. Channels can
     * be `#channel`, channel IDs (`C…`), or user IDs (`U…`).
     */
    channel: z.string().trim().min(1),
    /**
     * Optional override; defaults to a recognisable
     * "Viljetech Slack integration test" string in the service.
     */
    text: z.string().trim().min(1).max(SLACK_TEXT_MAX).optional(),
});
export type TestMessageBody = z.infer<typeof testMessageBodySchema>;
