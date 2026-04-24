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

const redactForRole = (settings: Record<string, unknown>, role: RoleType): Record<string, unknown> => {
    if (role === ROLES.ADMIN) return settings;
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
    actor_id: Types.ObjectId
): Promise<Record<string, unknown>> => {
    const settings = await getOrInitSettings();

    // Deep-merge each section explicitly so we don't accidentally allow new
    // top-level keys outside the schema. `default_timezone` is a primitive top-
    // level field and is handled separately.
    for (const section of Object.keys(patch) as Array<keyof PatchSettingsBody>) {
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

    return stripInternalFields(settings.toJSON() as Record<string, unknown>);
};
