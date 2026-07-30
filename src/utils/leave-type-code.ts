/**
 * Derives a leave type's permanent `code` from its human name.
 *
 * The create form no longer asks for a code, so this is the only thing
 * producing it. That makes two properties non-negotiable:
 *
 *  1. **The output always satisfies `codeSchema`** — `/^[A-Z][A-Z0-9_]*$/`,
 *     2–32 chars. A name that upper-snakes to nothing usable ("日本語",
 *     "2", "!!") falls back rather than emitting something the validator
 *     would reject on the way back in.
 *  2. **Collisions resolve, they don't 409.** With no field to edit, a
 *     second "Bereavement leave" would be an unfixable dead end for the
 *     admin — so the caller suffixes (`_2`, `_3`, …) against the codes
 *     already taken.
 */

const CODE_MAX = 32;
const CODE_MIN = 2;

/** Fallback when a name carries no Latin letters to build from. */
const FALLBACK = 'LEAVE_TYPE';

/** "Bereavement leave" → "BEREAVEMENT_LEAVE". */
export const codeFromName = (name: string): string => {
    const base = name
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        // A code must START with a letter — drop leading digits/underscores
        // ("2nd shift" would otherwise emit "2ND_SHIFT").
        .replace(/^[^A-Z]+/, '')
        .replace(/_+$/, '')
        .slice(0, CODE_MAX)
        .replace(/_+$/, '');
    return base.length >= CODE_MIN ? base : FALLBACK;
};

/**
 * `codeFromName` + a numeric suffix when the base is taken. Trims the base
 * so `base + suffix` still fits in 32 chars.
 */
export const uniqueCodeFromName = (name: string, taken: Set<string>): string => {
    const base = codeFromName(name);
    if (!taken.has(base)) return base;
    for (let n = 2; n < 1000; n += 1) {
        const suffix = `_${n}`;
        const candidate = base.slice(0, CODE_MAX - suffix.length).replace(/_+$/, '') + suffix;
        if (!taken.has(candidate)) return candidate;
    }
    // 998 leave types sharing one name is not a real scenario; failing loudly
    // beats returning a duplicate the unique index would reject anyway.
    throw new Error(`Could not derive a free leave-type code from "${name}"`);
};
