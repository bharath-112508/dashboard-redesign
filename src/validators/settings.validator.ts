import { z } from 'zod';

import { SLACK_BOT_TOKEN_MAX } from '../constants/slack.js';

/**
 * Zod schemas for `PATCH /settings`.
 *
 * Every section is fully optional and every field within a section is also
 * optional — i.e. callers may send `{ leave_policy: { cl_carry_forward_cap: 6 } }`
 * and the rest of the document is left untouched (deep-merge in the service).
 *
 * Arrays REPLACE rather than merge — that matches the documented PATCH semantics
 * in API_Contract.md §4.1 and the deep-merge implementation in `settings.service.ts`.
 *
 * Strict shape per Data_Model.md §2.1.
 */

// ─── Re-usable atoms ───────────────────────────────────────────────────────

const HHMM_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOR_REGEX = /^#([0-9a-fA-F]{6})$/;
// Loose CIDR / IP — full validation is overkill; the dispatcher does the real check.
const IP_OR_CIDR_REGEX = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

const hhmm = z.string().regex(HHMM_REGEX, 'Must be HH:MM (24-hour)');
const hexColor = z.string().regex(HEX_COLOR_REGEX, 'Must be a #RRGGBB hex colour');

const dayOfWeek = z.number().int().min(0).max(6);
const latitude = z.number().min(-90).max(90).nullable();
const longitude = z.number().min(-180).max(180).nullable();

// ─── Section schemas (each fully partial) ──────────────────────────────────

const workScheduleSchema = z
    .object({
        start_time: hhmm,
        end_time: hhmm,
        working_days: z.array(dayOfWeek).min(1).max(7),
        daily_expected_hours: z.number().min(0).max(24),
    })
    .partial();

const leavePolicySchema = z
    .object({
        cl_carry_forward_cap: z.number().int().min(0),
        comp_off_hours_per_day: z.number().min(0).max(24),
        cl_advance_notice_days: z.number().int().min(0),
        pro_rata_for_joiners: z.boolean(),
    })
    .partial();

const timesheetSchema = z
    .object({
        self_edit_window_days: z.number().int().min(0),
        daily_warn_threshold_hours: z.number().min(0).max(24),
    })
    .partial();

const geofenceSchema = z
    .object({
        enabled: z.boolean(),
        center_latitude: latitude,
        center_longitude: longitude,
        radius_meters: z.number().min(0),
    })
    .partial();

const wifiRestrictionSchema = z
    .object({
        enabled: z.boolean(),
        allowed_ssids: z.array(z.string().min(1)),
        allowed_ip_ranges: z.array(z.string().regex(IP_OR_CIDR_REGEX, 'Must be an IP or CIDR range')),
    })
    .partial();

const attendanceSchema = z
    .object({
        geofence: geofenceSchema,
        wifi_restriction: wifiRestrictionSchema,
        forgot_checkout_flag_time: hhmm,
    })
    .partial();

const securitySchema = z
    .object({
        password_min_length: z.number().int().min(6),
        password_max_length: z.number().int().min(6),
        password_require_upper: z.boolean(),
        password_require_lower: z.boolean(),
        password_require_number: z.boolean(),
        password_require_special: z.boolean(),
        failed_login_threshold: z.number().int().min(1),
        lockout_duration_minutes: z.number().int().min(0),
        access_token_ttl_minutes: z.number().int().min(1),
        refresh_token_ttl_days: z.number().int().min(1),
        password_reset_ttl_minutes: z.number().int().min(1),
        require_mfa_for_admins: z.boolean(),
    })
    .partial()
    .refine(
        (s) =>
            s.password_min_length === undefined ||
            s.password_max_length === undefined ||
            s.password_min_length <= s.password_max_length,
        { message: 'password_min_length must be <= password_max_length', path: ['password_min_length'] }
    );

const uploadsSchema = z
    .object({
        max_file_size_mb: z.number().int().min(1),
        allowed_mime_types: z.array(z.string().min(1)),
        sas_token_ttl_minutes: z.number().int().min(1),
    })
    .partial();

const slackChannelsSchema = z
    .object({
        leaves: z.string().min(1),
        attendance: z.string().min(1),
        projects: z.string().min(1),
        timesheet: z.string().min(1),
        general: z.string().min(1),
    })
    .partial();

const slackSchema = z
    .object({
        enabled: z.boolean(),
        channels: slackChannelsSchema,
        // Bot User OAuth token. Empty string is the explicit "clear"
        // signal — Mongo coerces it to null in the service layer so
        // the model's `String | null` shape stays clean. Cap shared
        // with the dedicated `/settings/slack` PATCH so a future bump
        // only happens in one place.
        bot_token: z.string().max(SLACK_BOT_TOKEN_MAX).nullable(),
    })
    .partial();

const emailSchema = z
    .object({
        from_address: z.string().email(),
        reply_to_address: z.string().email(),
    })
    .partial();

const remindersSchema = z
    .object({
        timesheet_reminder_time: hhmm,
        task_due_reminder_run_interval_hours: z.number().int().min(1),
    })
    .partial();

const companySchema = z
    .object({
        name: z.string().trim().min(1),
        logo_blob_key: z.string().nullable(),
        primary_color: hexColor,
        login_page_tagline: z.string(),
    })
    .partial();

// ─── PATCH body ────────────────────────────────────────────────────────────

export const patchSettingsBodySchema = z
    .object({
        work_schedule: workScheduleSchema,
        leave_policy: leavePolicySchema,
        timesheet: timesheetSchema,
        attendance: attendanceSchema,
        security: securitySchema,
        uploads: uploadsSchema,
        slack: slackSchema,
        email: emailSchema,
        reminders: remindersSchema,
        company: companySchema,
        default_timezone: z.string().trim().min(1),
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
        message: 'At least one settings section must be supplied',
    });

export type PatchSettingsBody = z.infer<typeof patchSettingsBodySchema>;
