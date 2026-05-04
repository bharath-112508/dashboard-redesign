import { Types } from 'mongoose';

import { SystemSettings, type SystemSettingsDocument } from '../models/system-settings.model.js';
import { ROLES, type RoleType } from '../constants/roles.js';
import {
    ADMIN_ONLY_SECTIONS,
    DEFAULT_SETTINGS,
    PUBLIC_COMPANY_FIELDS,
    SETTINGS_SINGLETON_KEY,
    type SettingsSection,
} from '../constants/settings.js';
import { AUDIT_ACTIONS, AUDIT_TARGET_KINDS } from '../constants/audit.js';
import { recordAudit, type AuditContext } from './audit.service.js';
import type { PatchSettingsBody } from '../validators/settings.validator.js';

/**
 * System settings service (API_Contract.md §4.1).
 *
 *  - The collection is a singleton — pinned by `singleton_key: 'system'` with
 *    a unique index, so concurrent first-boot inserts are safe.
 *  - First read auto-seeds the row from `DEFAULT_SETTINGS`.
 *  - PATCH does a deep merge per section. Arrays REPLACE rather than concatenate
 *    (e.g. setting `working_days: [1,2,3]` removes 4 and 5).
 *  - Non-admin GET callers receive a redacted view: sections in
 *    `ADMIN_ONLY_SECTIONS` are stripped before serialisation.
 */

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
    if (v === null || typeof v !== 'object') return false;
    const proto = Object.getPrototypeOf(v);
    return proto === Object.prototype || proto === null;
};

/** Recursive merge: `patch` wins, arrays replace, plain objects merge. */
const deepMerge = <T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T => {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        const current = out[key];
        if (isPlainObject(current) && isPlainObject(value)) {
            out[key] = deepMerge(current, value);
        } else {
            out[key] = value;
        }
    }
    return out as T;
};

/**
 * Load — and lazily seed — the singleton settings document.
 *
 * Race: two callers hitting an empty DB simultaneously will both insert; the
 * unique index on `singleton_key` makes the second insert fail with E11000.
 * We catch that, retry the read, and return the row that won the race.
 */
export const getOrInitSettings = async (): Promise<SystemSettingsDocument> => {
    const existing = await SystemSettings.findOne({ singleton_key: SETTINGS_SINGLETON_KEY });
    if (existing) return existing;

    try {
        return await SystemSettings.create({
            singleton_key: SETTINGS_SINGLETON_KEY,
            ...DEFAULT_SETTINGS,
            updated_by: null,
        });
    } catch (err: unknown) {
        // Lost the race with another concurrent first-boot insert.
        if (err && typeof err === 'object' && 'code' in err && (err as { code: number }).code === 11000) {
            const winner = await SystemSettings.findOne({ singleton_key: SETTINGS_SINGLETON_KEY });
            if (winner) return winner;
        }
        throw err;
    }
};

const stripInternalFields = (json: Record<string, unknown>): Record<string, unknown> => {
    delete json.singleton_key;
    return json;
};

// ─── Step-33 resolvers (compile-time defaults → settings hot-wiring) ─────
//
// These resolvers expose the `security.*` block to the auth/password
// surfaces that previously hard-coded the matching policy. They return
// `null` for any field when the singleton hasn't been seeded yet (a
// fresh-install bootstrap window) so the caller can fall back to the
// `constants/auth.ts` compile-time defaults without crashing.
//
// Why a per-resolver narrow shape rather than just exporting
// `getOrInitSettings().security`? Two reasons:
//   1. Each call site cares about 1-2 fields; narrowing keeps the import
//      surface honest.
//   2. The resolvers are easy mock points in tests — auth.service tests
//      can stub the resolver without dragging the whole settings doc.
//
// Failure mode: if the settings read itself throws (e.g. transient
// Mongo blip during a login burst), the resolver re-raises and the
// auth flow surfaces a 500. That's the right answer — silently
// reverting to compile-time defaults during a partial outage would
// hide configuration drift.

export interface LoginLockoutPolicy {
    failed_login_threshold: number | null;
    lockout_duration_minutes: number | null;
}

export const resolveLoginLockoutPolicy = async (): Promise<LoginLockoutPolicy> => {
    const settings = await getOrInitSettings();
    return {
        failed_login_threshold: settings.security?.failed_login_threshold ?? null,
        lockout_duration_minutes: settings.security?.lockout_duration_minutes ?? null,
    };
};

export interface PasswordPolicy {
    min_length: number | null;
    max_length: number | null;
    require_upper: boolean | null;
    require_lower: boolean | null;
    require_number: boolean | null;
    require_special: boolean | null;
}

export const resolvePasswordPolicy = async (): Promise<PasswordPolicy> => {
    const settings = await getOrInitSettings();
    const s = settings.security;
    return {
        min_length: s?.password_min_length ?? null,
        max_length: s?.password_max_length ?? null,
        require_upper: s?.password_require_upper ?? null,
        require_lower: s?.password_require_lower ?? null,
        require_number: s?.password_require_number ?? null,
        require_special: s?.password_require_special ?? null,
    };
};

export const resolvePasswordResetTtlMinutes = async (): Promise<number | null> => {
    const settings = await getOrInitSettings();
    return settings.security?.password_reset_ttl_minutes ?? null;
};

/**
 * Strip the raw Slack `bot_token` from a settings JSON / slack-section
 * snapshot, replacing it with a presence flag (`has_bot_token`).
 *
 * Step 25 added a dedicated `/settings/slack` surface that does this
 * redaction inline, but the legacy `/settings` GET + the generic
 * `/settings` PATCH (and its audit row) flow through `getSettingsForCaller`
 * + `patchSettings` here. Both must apply the same redaction so an
 * admin caller — or, worse, an audit-log reader (Step-31 UI) — cannot
 * extract the live or historical bot token through the pre-existing
 * settings surface. Operates in-place on a shallow JSON object; safe to
 * call on either a full settings doc or a single `slack` section.
 */
const redactSlackBotTokenInPlace = (
    holder: Record<string, unknown> | null | undefined,
    isFullSettingsJson: boolean
): void => {
    if (!holder || typeof holder !== 'object') return;
    const slack = (isFullSettingsJson ? holder.slack : holder) as Record<string, unknown> | undefined;
    if (!slack || typeof slack !== 'object') return;
    if ('bot_token' in slack) {
        slack.has_bot_token = Boolean(slack.bot_token);
        delete slack.bot_token;
    } else if (!('has_bot_token' in slack)) {
        // Always emit the presence flag so the FE has a stable shape
        // whether or not the field was previously set.
        slack.has_bot_token = false;
    }
};

const redactForRole = (settings: Record<string, unknown>, role: RoleType): Record<string, unknown> => {
    if (role === ROLES.ADMIN) {
        // Admin sees the slack section but NEVER the raw token —
        // `has_bot_token: bool` only. Same contract the dedicated
        // `/settings/slack` GET enforces; this is the legacy path.
        redactSlackBotTokenInPlace(settings, true);
        return settings;
    }
    const out = { ...settings };
    for (const section of ADMIN_ONLY_SECTIONS) {
        delete out[section];
    }
    return out;
};

// ─── GET /settings ─────────────────────────────────────────────────────────

export const getSettingsForCaller = async (caller_role: RoleType): Promise<Record<string, unknown>> => {
    const settings = await getOrInitSettings();
    const json = stripInternalFields(settings.toJSON() as Record<string, unknown>);
    return redactForRole(json, caller_role);
};

// ─── GET /settings/public ──────────────────────────────────────────────────

interface PublicSettings {
    company: {
        name: string;
        logo_blob_key: string | null;
        primary_color: string;
        login_page_tagline: string;
    };
}

export const getPublicSettings = async (): Promise<PublicSettings> => {
    const settings = await getOrInitSettings();
    const company: Record<string, unknown> = {};
    for (const field of PUBLIC_COMPANY_FIELDS) {
        company[field] = settings.company[field];
    }
    return { company: company as PublicSettings['company'] };
};

// ─── PATCH /settings ───────────────────────────────────────────────────────

export const patchSettings = async (
    patch: PatchSettingsBody,
    actor_id: Types.ObjectId,
    audit?: AuditContext
): Promise<Record<string, unknown>> => {
    const settings = await getOrInitSettings();

    // Snapshot the affected sections BEFORE merging so the audit `before` is
    // a focused diff, not the entire settings document.
    const sectionsTouched = Object.keys(patch) as Array<keyof PatchSettingsBody>;
    const beforeSnapshot: Record<string, unknown> = {};
    for (const section of sectionsTouched) {
        if (section === 'default_timezone') {
            beforeSnapshot.default_timezone = settings.default_timezone;
            continue;
        }
        const key = section as SettingsSection;
        const raw = settings[key] as unknown;
        const maybeSubdoc = raw as { toObject?: () => Record<string, unknown> } | null | undefined;
        const sectionJson =
            maybeSubdoc && typeof maybeSubdoc.toObject === 'function' ? maybeSubdoc.toObject() : (raw ?? null);
        // Redact `slack.bot_token` so the audit row never carries a
        // raw or historical secret. The dedicated /settings/slack
        // PATCH does the same; this covers the legacy entry point.
        if (section === 'slack' && sectionJson && typeof sectionJson === 'object') {
            redactSlackBotTokenInPlace(sectionJson as Record<string, unknown>, false);
        }
        beforeSnapshot[section] = sectionJson;
    }

    // Deep-merge each section explicitly so we don't accidentally allow new
    // top-level keys outside the schema. `default_timezone` is a primitive top-
    // level field and is handled separately.
    for (const section of sectionsTouched) {
        if (section === 'default_timezone') continue;
        const sectionPatch = patch[section];
        if (!sectionPatch) continue;

        const key = section as SettingsSection;
        // Normalise the current section to a POJO before merging. Mongoose
        // sub-documents fail `isPlainObject`, which would otherwise cause
        // `deepMerge` to *replace* nested sub-docs (e.g. `geofence`) instead
        // of merging into them — wiping any unspecified required fields.
        const currentRaw = settings[key] as unknown;
        const maybeSubdoc = currentRaw as { toObject?: () => Record<string, unknown> } | null | undefined;
        const current: Record<string, unknown> =
            maybeSubdoc && typeof maybeSubdoc.toObject === 'function'
                ? maybeSubdoc.toObject()
                : ((currentRaw ?? {}) as Record<string, unknown>);
        const merged = deepMerge(current, sectionPatch as Record<string, unknown>);

        // Mongoose needs `markModified` for nested-path mutation to persist when
        // the path holds a sub-document with `_id: false`.
        (settings as unknown as Record<string, unknown>)[key] = merged;
        settings.markModified(key);
    }

    if (patch.default_timezone !== undefined) {
        settings.default_timezone = patch.default_timezone;
    }

    settings.updated_by = actor_id;
    await settings.save();

    // Build the after snapshot using the same focused-section view.
    const afterSnapshot: Record<string, unknown> = {};
    for (const section of sectionsTouched) {
        if (section === 'default_timezone') {
            afterSnapshot.default_timezone = settings.default_timezone;
            continue;
        }
        const key = section as SettingsSection;
        const raw = settings[key] as unknown;
        const maybeSubdoc = raw as { toObject?: () => Record<string, unknown> } | null | undefined;
        const sectionJson =
            maybeSubdoc && typeof maybeSubdoc.toObject === 'function' ? maybeSubdoc.toObject() : (raw ?? null);
        if (section === 'slack' && sectionJson && typeof sectionJson === 'object') {
            redactSlackBotTokenInPlace(sectionJson as Record<string, unknown>, false);
        }
        afterSnapshot[section] = sectionJson;
    }

    if (audit) {
        await recordAudit(audit, {
            action: AUDIT_ACTIONS.SETTINGS_UPDATE,
            target: { kind: AUDIT_TARGET_KINDS.SYSTEM_SETTINGS, id: null },
            before: beforeSnapshot,
            after: afterSnapshot,
            metadata: { sections_touched: sectionsTouched },
        });
    }

    const json = stripInternalFields(settings.toJSON() as Record<string, unknown>);
    // Same redaction as `getSettingsForCaller` — even an admin caller
    // never sees the raw bot token in the response shape.
    redactSlackBotTokenInPlace(json, true);
    return json;
};
