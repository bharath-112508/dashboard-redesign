import { Schema, model, Types, type Document, type Model } from 'mongoose';

import { BASE_SCHEMA_OPTIONS } from './_base.js';
import { COLLECTIONS } from '../constants/collections.js';
import { SETTINGS_SINGLETON_KEY } from '../constants/settings.js';
import { DEFAULT_BREAK_ALLOWANCE_MINUTES } from '../constants/attendance.js';

/**
 * `system_settings` — Data_Model.md §2.1
 *
 * A single-document collection: the entire app reads from / writes to one row.
 * Race-safe upsert is achieved with a `singleton_key` field carrying the literal
 * value `'system'` and a unique index on it — concurrent inserts collide on the
 * index and only one wins.
 *
 * The schema mirrors the planning doc verbatim (snake_case throughout). Sub-docs
 * use `_id: false` so they don't accumulate ids on patch-merge round-trips.
 */

// ─── Sub-doc interfaces ────────────────────────────────────────────────────

export interface WorkScheduleSettings {
    start_time: string; // "HH:MM"
    end_time: string; // "HH:MM"
    working_days: number[]; // 0=Sun..6=Sat
    daily_expected_hours: number;
}

export interface LeavePolicySettings {
    cl_carry_forward_cap: number;
    /** Hours of qualifying work that equal one comp-off day. Also the
     *  overtime-bank threshold for automatic accrual (default 8). */
    comp_off_hours_per_day: number;
    /** Master switch for the nightly automatic comp-off accrual job
     *  (overtime bank + weekend/holiday grants). Off by default. */
    comp_off_auto_accrual_enabled: boolean;
    cl_advance_notice_days: number;
    pro_rata_for_joiners: boolean;
}

export interface TimesheetSettings {
    self_edit_window_days: number;
    daily_warn_threshold_hours: number;
}

export interface GeofenceSettings {
    enabled: boolean;
    center_latitude: number | null;
    center_longitude: number | null;
    radius_meters: number;
}

export interface WifiRestrictionSettings {
    enabled: boolean;
    allowed_ssids: string[];
    allowed_ip_ranges: string[];
}

export interface AttendanceSettings {
    geofence: GeofenceSettings;
    wifi_restriction: WifiRestrictionSettings;
    forgot_checkout_flag_time: string; // "HH:MM"
    break_allowance_minutes: number;
}

export interface SecuritySettings {
    password_min_length: number;
    password_max_length: number;
    password_require_upper: boolean;
    password_require_lower: boolean;
    password_require_number: boolean;
    password_require_special: boolean;
    failed_login_threshold: number;
    lockout_duration_minutes: number;
    access_token_ttl_minutes: number;
    refresh_token_ttl_days: number;
    password_reset_ttl_minutes: number;
    /**
     * Step 28 — when true, every admin-role mutation (POST/PATCH/PUT/DELETE)
     * is blocked with `403 MFA_REQUIRED` until the admin enables MFA.
     * The MFA-setup endpoints themselves are exempt from the gate so
     * an admin can still bootstrap their second factor; everything
     * else (including settings PATCH itself) is gated.
     *
     * Default `false` for backward-compat; flipping it on is a Phase-3
     * security-hardening decision the operator makes deliberately.
     */
    require_mfa_for_admins: boolean;
}

export interface UploadSettings {
    max_file_size_mb: number;
    allowed_mime_types: string[];
    sas_token_ttl_minutes: number;
}

export interface SlackChannelMap {
    leaves: string;
    attendance: string;
    projects: string;
    timesheet: string;
    general: string;
}

export interface AttendanceNudgeSettings {
    /** Master switch for the morning/evening attendance nudge crons. */
    enabled: boolean;
    /** "HH:MM" 24h IST — morning check-in nudge fire time. */
    check_in_time: string;
    /** "HH:MM" 24h IST — evening "forgot to check out" reminder fire time. */
    checkout_reminder_time: string;
}

export interface SlackSettings {
    enabled: boolean;
    channels: SlackChannelMap;
    /**
     * Slack Bot User OAuth token (`xoxb-...`). Stored verbatim on the
     * row but **never** echoed back to a caller:
     *  - Non-admin reads have the entire `slack` section stripped via
     *    `ADMIN_ONLY_SECTIONS`.
     *  - Admin reads (both `/settings` and `/settings/slack`) replace
     *    `bot_token` with a presence flag `has_bot_token: bool` —
     *    enforced in `settings.service.redactSlackBotTokenInPlace` and
     *    `slack-settings.service.toAuditSnapshot`. The same redaction
     *    is applied to the audit `before/after` snapshots so a Step-31
     *    audit-log reader can never extract a historical secret.
     */
    bot_token: string | null;
    /** Slack-driven attendance check-in/out nudges (App Home + DM buttons). */
    attendance_nudges: AttendanceNudgeSettings;
}

export interface EmailSettings {
    from_address: string;
    reply_to_address: string;
}

export interface ReminderSettings {
    timesheet_reminder_time: string; // "HH:MM"
    task_due_reminder_run_interval_hours: number;
}

export interface CompanySettings {
    name: string;
    logo_blob_key: string | null;
    primary_color: string; // "#xxxxxx"
    login_page_tagline: string;
}

export interface FxRateSetting {
    /** ISO-4217-shaped currency code, e.g. `'EUR'`. Letters-only, 3 chars. */
    currency: string;
    /** Multiplier to convert 1 unit of `currency` into `reporting_currency`. */
    rate_to_base: number;
}

export interface BillingSettings {
    /** Prefix used by `nextInvoiceNumber` when minting `{prefix}-{year}-{seq}`
     *  invoice numbers (Phase 1.1 follow-up — was hard-coded to `'INV'`). */
    invoice_prefix: string;
    /** Billing Phase 2 — the currency the Margin report (and any other
     *  cross-currency rollup) normalises amounts into. Letters-only ISO code. */
    reporting_currency: string;
    /** Billing Phase 2 — per-currency multipliers into `reporting_currency`,
     *  consumed by `utils/fx.ts#toReportingCurrency`. */
    fx_rates: FxRateSetting[];
}

export interface PayrollSettings {
    company_legal_name: string;
    company_address_lines: string[];
    company_email: string;
    cin_no: string;
    iec_code: string;
    signatory_name: string;
    signatory_title: string;
    hr_reply_to_address: string;
    hr_reply_to_name: string;
}

export interface SystemSettingsDocument extends Document {
    _id: Types.ObjectId;
    singleton_key: typeof SETTINGS_SINGLETON_KEY;

    work_schedule: WorkScheduleSettings;
    leave_policy: LeavePolicySettings;
    timesheet: TimesheetSettings;
    attendance: AttendanceSettings;
    security: SecuritySettings;
    uploads: UploadSettings;
    slack: SlackSettings;
    email: EmailSettings;
    reminders: ReminderSettings;
    company: CompanySettings;
    payroll: PayrollSettings;
    billing: BillingSettings;

    default_timezone: string;

    updated_by: Types.ObjectId | null;
    created_at: Date;
    updated_at: Date;
}

// ─── Sub-doc schemas ───────────────────────────────────────────────────────

const workScheduleSchema = new Schema<WorkScheduleSettings>(
    {
        start_time: { type: String, required: true },
        end_time: { type: String, required: true },
        working_days: { type: [Number], required: true },
        daily_expected_hours: { type: Number, required: true, min: 0, max: 24 },
    },
    { _id: false }
);

const leavePolicySchema = new Schema<LeavePolicySettings>(
    {
        cl_carry_forward_cap: { type: Number, required: true, min: 0 },
        comp_off_hours_per_day: { type: Number, required: true, min: 0, max: 24 },
        comp_off_auto_accrual_enabled: { type: Boolean, required: true, default: false },
        cl_advance_notice_days: { type: Number, required: true, min: 0 },
        pro_rata_for_joiners: { type: Boolean, required: true },
    },
    { _id: false }
);

const timesheetSchema = new Schema<TimesheetSettings>(
    {
        self_edit_window_days: { type: Number, required: true, min: 0 },
        daily_warn_threshold_hours: { type: Number, required: true, min: 0, max: 24 },
    },
    { _id: false }
);

const geofenceSchema = new Schema<GeofenceSettings>(
    {
        enabled: { type: Boolean, required: true, default: false },
        center_latitude: { type: Number, default: null, min: -90, max: 90 },
        center_longitude: { type: Number, default: null, min: -180, max: 180 },
        radius_meters: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const wifiRestrictionSchema = new Schema<WifiRestrictionSettings>(
    {
        enabled: { type: Boolean, required: true, default: false },
        allowed_ssids: { type: [String], required: true, default: [] },
        allowed_ip_ranges: { type: [String], required: true, default: [] },
    },
    { _id: false }
);

const attendanceSchema = new Schema<AttendanceSettings>(
    {
        geofence: { type: geofenceSchema, required: true },
        wifi_restriction: { type: wifiRestrictionSchema, required: true },
        forgot_checkout_flag_time: { type: String, required: true },
        break_allowance_minutes: { type: Number, default: DEFAULT_BREAK_ALLOWANCE_MINUTES, min: 0, max: 480 },
    },
    { _id: false }
);

const securitySchema = new Schema<SecuritySettings>(
    {
        password_min_length: { type: Number, required: true, min: 6 },
        password_max_length: { type: Number, required: true, min: 6 },
        password_require_upper: { type: Boolean, required: true },
        password_require_lower: { type: Boolean, required: true },
        password_require_number: { type: Boolean, required: true },
        password_require_special: { type: Boolean, required: true },
        failed_login_threshold: { type: Number, required: true, min: 1 },
        lockout_duration_minutes: { type: Number, required: true, min: 0 },
        access_token_ttl_minutes: { type: Number, required: true, min: 1 },
        refresh_token_ttl_days: { type: Number, required: true, min: 1 },
        password_reset_ttl_minutes: { type: Number, required: true, min: 1 },
        require_mfa_for_admins: { type: Boolean, required: true, default: false },
    },
    { _id: false }
);

const uploadSchema = new Schema<UploadSettings>(
    {
        max_file_size_mb: { type: Number, required: true, min: 1 },
        allowed_mime_types: { type: [String], required: true, default: [] },
        sas_token_ttl_minutes: { type: Number, required: true, min: 1 },
    },
    { _id: false }
);

// Each category channel is optional: an empty string means "don't broadcast
// to a channel for this category" — the dispatcher skips the post (`if
// (!channel)`) and per-recipient DMs still go out. Defaulted to '' so a blank
// value is a valid, savable "disabled" state (a `required` String rejects '').
const slackChannelsSchema = new Schema<SlackChannelMap>(
    {
        leaves: { type: String, default: '' },
        attendance: { type: String, default: '' },
        projects: { type: String, default: '' },
        timesheet: { type: String, default: '' },
        general: { type: String, default: '' },
    },
    { _id: false }
);

const attendanceNudgeSchema = new Schema<AttendanceNudgeSettings>(
    {
        enabled: { type: Boolean, required: true, default: false },
        check_in_time: { type: String, required: true, default: '11:00' },
        checkout_reminder_time: { type: String, required: true, default: '20:00' },
    },
    { _id: false }
);

const slackSchema = new Schema<SlackSettings>(
    {
        enabled: { type: Boolean, required: true, default: false },
        channels: { type: slackChannelsSchema, required: true },
        bot_token: { type: String, default: null },
        attendance_nudges: {
            type: attendanceNudgeSchema,
            required: true,
            default: () => ({ enabled: false, check_in_time: '11:00', checkout_reminder_time: '20:00' }),
        },
    },
    { _id: false }
);

const emailSchema = new Schema<EmailSettings>(
    {
        from_address: { type: String, required: true },
        reply_to_address: { type: String, required: true },
    },
    { _id: false }
);

const remindersSchema = new Schema<ReminderSettings>(
    {
        timesheet_reminder_time: { type: String, required: true },
        task_due_reminder_run_interval_hours: { type: Number, required: true, min: 1 },
    },
    { _id: false }
);

const companySchema = new Schema<CompanySettings>(
    {
        name: { type: String, required: true, trim: true },
        logo_blob_key: { type: String, default: null },
        primary_color: { type: String, required: true },
        login_page_tagline: { type: String, default: '' },
    },
    { _id: false }
);

// Payroll & certificates (foundation) — company letterhead fields used to
// render payslip/certificate PDFs. All optional strings default to '' so
// the subsection is savable field-by-field from day one.
const payrollSchema = new Schema<PayrollSettings>(
    {
        company_legal_name: { type: String, default: 'M/S VILJA TECH LABS PRIVATE LIMITED' },
        company_address_lines: { type: [String], default: [] },
        company_email: { type: String, default: '' },
        cin_no: { type: String, default: '' },
        iec_code: { type: String, default: '' },
        signatory_name: { type: String, default: '' },
        signatory_title: { type: String, default: 'Human Resources' },
        hr_reply_to_address: { type: String, default: '' },
        hr_reply_to_name: { type: String, default: '' },
    },
    { _id: false }
);

// Billing & invoicing (Phase 1.1 follow-up) — single configurable field so
// far: the `nextInvoiceNumber` prefix. Trimmed + upper-cased at write time so
// `INV`/`inv `/` Inv` all normalise to the same stored value.
// Billing Phase 2 — reporting currency + FX rate table consumed by
// `utils/fx.ts#toReportingCurrency` (Margin report). `_id: false` — these
// are line items in an array, not their own addressable documents.
const fxRateSettingSchema = new Schema<FxRateSetting>(
    {
        currency: { type: String, required: true, trim: true, uppercase: true, match: /^[A-Z]{3}$/ },
        rate_to_base: { type: Number, required: true, min: 0 },
    },
    { _id: false }
);

const billingSchema = new Schema<BillingSettings>(
    {
        invoice_prefix: { type: String, required: true, default: 'INV', trim: true, uppercase: true },
        reporting_currency: {
            type: String,
            required: true,
            default: 'INR',
            trim: true,
            uppercase: true,
            match: /^[A-Z]+$/,
        },
        fx_rates: { type: [fxRateSettingSchema], default: [] },
    },
    { _id: false }
);

// ─── Top-level schema ──────────────────────────────────────────────────────

const systemSettingsSchema = new Schema<SystemSettingsDocument>(
    {
        singleton_key: {
            type: String,
            enum: [SETTINGS_SINGLETON_KEY],
            default: SETTINGS_SINGLETON_KEY,
            required: true,
            unique: true,
        },

        work_schedule: { type: workScheduleSchema, required: true },
        leave_policy: { type: leavePolicySchema, required: true },
        timesheet: { type: timesheetSchema, required: true },
        attendance: { type: attendanceSchema, required: true },
        security: { type: securitySchema, required: true },
        uploads: { type: uploadSchema, required: true },
        slack: { type: slackSchema, required: true },
        email: { type: emailSchema, required: true },
        reminders: { type: remindersSchema, required: true },
        company: { type: companySchema, required: true },
        payroll: { type: payrollSchema, default: () => ({}) },
        billing: { type: billingSchema, default: () => ({}) },

        default_timezone: { type: String, required: true },

        updated_by: { type: Schema.Types.ObjectId, ref: COLLECTIONS.USERS, default: null },
    },
    {
        ...BASE_SCHEMA_OPTIONS,
        collection: COLLECTIONS.SYSTEM_SETTINGS,
    }
);

export const SystemSettings: Model<SystemSettingsDocument> = model<SystemSettingsDocument>(
    COLLECTIONS.SYSTEM_SETTINGS,
    systemSettingsSchema
);
