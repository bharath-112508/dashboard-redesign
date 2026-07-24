/**
 * Defaults for the singleton `system_settings` document (Data_Model.md §2.1).
 *
 * On first read the service upserts this whole shape into Mongo. Subsequent
 * `PATCH /settings` calls deep-merge per section, so adding a new field here
 * means existing deployments will have it populated lazily on next save.
 *
 * NOTE: the `security.*` block is the contract surface — actual runtime
 * enforcement (bcrypt rounds, lockout window, JWT TTLs) still reads the
 * compile-time constants in `constants/auth.ts`. Hot-wiring those to the
 * stored settings is staged for the auth-policy hardening slice (Phase 3
 * Step 33). Storing them now keeps the API contract honest in the meantime.
 */

export const SETTINGS_SINGLETON_KEY = 'system' as const;

export const DEFAULT_SETTINGS = {
    work_schedule: {
        start_time: '11:00',
        end_time: '20:00',
        working_days: [1, 2, 3, 4, 5] as number[], // 0=Sun..6=Sat
        daily_expected_hours: 8,
    },

    leave_policy: {
        cl_carry_forward_cap: 5,
        comp_off_hours_per_day: 8,
        comp_off_auto_accrual_enabled: false,
        cl_advance_notice_days: 14,
        pro_rata_for_joiners: true,
    },

    timesheet: {
        self_edit_window_days: 7,
        daily_warn_threshold_hours: 8,
    },

    attendance: {
        geofence: {
            enabled: false,
            center_latitude: null as number | null,
            center_longitude: null as number | null,
            radius_meters: 100,
        },
        wifi_restriction: {
            enabled: false,
            allowed_ssids: [] as string[],
            allowed_ip_ranges: [] as string[],
        },
        forgot_checkout_flag_time: '23:00',
    },

    security: {
        password_min_length: 10,
        password_max_length: 12,
        password_require_upper: true,
        password_require_lower: true,
        password_require_number: true,
        password_require_special: true,
        failed_login_threshold: 5,
        lockout_duration_minutes: 15,
        access_token_ttl_minutes: 480, // 8h
        refresh_token_ttl_days: 5,
        password_reset_ttl_minutes: 60,
        // Step 28 — opt-in admin-MFA enforcement. Off by default.
        require_mfa_for_admins: false,
    },

    uploads: {
        max_file_size_mb: 25,
        allowed_mime_types: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/gif',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'application/vnd.ms-powerpoint',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'text/plain',
            'application/zip',
        ] as string[],
        sas_token_ttl_minutes: 15,
    },

    slack: {
        enabled: false,
        channels: {
            leaves: '#leaves',
            attendance: '#attendance',
            projects: '#projects',
            timesheet: '#timesheet',
            general: '#general',
        },
        bot_token: null as string | null,
        attendance_nudges: {
            enabled: false,
            check_in_time: '11:00',
            checkout_reminder_time: '20:00',
        },
    },

    email: {
        from_address: 'noreply@viljetech.com',
        reply_to_address: 'noreply@viljetech.com',
    },

    reminders: {
        timesheet_reminder_time: '18:00',
        task_due_reminder_run_interval_hours: 1,
    },

    company: {
        name: 'Viljetech',
        logo_blob_key: null as string | null,
        primary_color: '#0F62FE',
        login_page_tagline: '',
    },

    // Payroll & certificates (foundation) — company letterhead + signatory
    // fields consumed by the payslip/letter render adapter. Kept in sync
    // with the Mongoose schema defaults in `models/system-settings.model.ts`
    // (`payrollSchema`) — the model is the actual seed source since the
    // subsection has its own `default: () => ({})`, but listing it here
    // makes it a member of `SettingsSection` so `PATCH /settings` can
    // address it like every other section.
    payroll: {
        company_legal_name: 'M/S VILJA TECH LABS PRIVATE LIMITED',
        company_address_lines: [] as string[],
        company_email: '',
        cin_no: '',
        iec_code: '',
        signatory_name: '',
        signatory_title: 'Human Resources',
        hr_reply_to_address: '',
        hr_reply_to_name: '',
    },

    // Billing & invoicing (Phase 1.1 follow-up) — `invoice_prefix` feeds
    // `nextInvoiceNumber` in `invoice.service.ts#generateInvoice`. Kept in
    // sync with the Mongoose schema default in `models/system-settings.model.ts`
    // (`billingSchema`), same rationale as `payroll` above.
    billing: {
        invoice_prefix: 'INV',
        // Billing Phase 2 — reporting currency + FX rate table for the Margin
        // report (`utils/fx.ts#toReportingCurrency`). Kept in sync with the
        // Mongoose schema defaults in `models/system-settings.model.ts`
        // (`billingSchema`).
        reporting_currency: 'INR',
        fx_rates: [] as { currency: string; rate_to_base: number }[],
    },

    default_timezone: 'Asia/Kolkata',
} as const;

export type SettingsSection = Exclude<keyof typeof DEFAULT_SETTINGS, 'default_timezone'>;

/**
 * Sections that are always Admin-only on the read path. Removed from the
 * payload returned to non-admin callers of GET /settings (per API_Contract §4.1
 * "security section Admin-only" — extended here to also hide internal-comms
 * config that is operationally sensitive).
 */
export const ADMIN_ONLY_SECTIONS: ReadonlySet<SettingsSection> = new Set(['security', 'email', 'slack']);

/** Branding fields exposed by the unauthenticated `GET /settings/public`. */
export const PUBLIC_COMPANY_FIELDS = ['name', 'logo_blob_key', 'primary_color', 'login_page_tagline'] as const;
