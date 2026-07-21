import { CUSTOM_STATUS_KEY_MAX, DEFAULT_TASK_STATUS_KEYS } from '../constants/project.js';

/**
 * Auto-derivation of a custom-status `key` from its human label. The key is
 * the value stored on `task.status` (the task-status set is
 * `defaults ∪ custom keys`) and is immutable once created — so it's derived
 * once, at creation, and never asked of the user.
 *
 * The result always satisfies `CUSTOM_STATUS_KEY_REGEX`
 * (`^[a-z][a-z0-9_]{0,39}$`) and never equals a built-in status key — the
 * service dedupes with {@link pickCustomStatusKey}. Pure + unit-tested.
 */

// Leave headroom for a `_<n>` collision suffix so it can't exceed the cap.
const KEY_BASE_MAX = Math.max(3, CUSTOM_STATUS_KEY_MAX - 6);

/**
 * Slugify a label into a valid lower_snake base key. "Ready for QA" →
 * `ready_for_qa`. Falls back to `status` for a label with no usable letters
 * (the regex requires a leading a-z, so a digit-leading slug is trimmed).
 */
export const slugifyCustomStatusKey = (label: string): string => {
    let slug = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_') // runs of anything else → single underscore
        .replace(/^_+|_+$/g, ''); // trim leading/trailing underscores
    // The key must start with a letter — drop any leading digits/underscores.
    slug = slug.replace(/^[^a-z]+/, '');
    // Cap length, then make sure the slice didn't leave a trailing underscore.
    slug = slug.slice(0, KEY_BASE_MAX).replace(/_+$/g, '');
    if (!slug || !/^[a-z]/.test(slug)) slug = 'status';
    return slug;
};

/**
 * Pick the first free key for `base`, treating the built-in status keys and
 * `taken` as reserved. Returns `base`, else `base_2`, `base_3`, … The
 * `Date.now()` tail is an unreachable saturation guard.
 */
export const pickCustomStatusKey = (base: string, taken: ReadonlySet<string>): string => {
    const reserved = new Set<string>(DEFAULT_TASK_STATUS_KEYS);
    for (const k of taken) reserved.add(k);

    if (!reserved.has(base)) return base;
    for (let n = 2; n < 100_000; n++) {
        const candidate = `${base}_${n}`;
        if (!reserved.has(candidate)) return candidate;
    }
    return `${base}_${Date.now()}`;
};
