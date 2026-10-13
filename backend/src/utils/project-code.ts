import { PROJECT_CODE_MAX } from '../constants/project.js';

/**
 * Auto-derivation of a project `code` (the permanent issue-key prefix,
 * e.g. `ATLAS-142`). Project codes are globally unique — see the unique
 * index on `projects.code` — so the *uniqueness* guarantee lives in the
 * service (which knows what's already taken). These helpers only handle the
 * pure string derivation so they can be unit-tested without the DB.
 *
 * Rules (per product decision):
 *  - Multi-word name  → initials of the significant words. "Atlas CRM
 *    Migration" → `ACM`, "Website Redesign 2026" → `WR` (pure-number tokens
 *    like "2026" carry no letter, so they're dropped).
 *  - Single-word name → first 3 letters. "Vilje" → `VIL`.
 *  - On collision the service appends the smallest free number (`WR`, `WR2`,
 *    `WR3`, …) via {@link pickProjectCode}.
 *
 * The base is always uppercase, starts with a letter, and is capped short
 * enough to leave room for a numeric suffix — so every result satisfies the
 * `PROJECT_CODE_REGEX` (`^[A-Z][A-Z0-9_-]{0,39}$`).
 */

// Filler words that shouldn't eat an initial — dropped unless the whole name
// is made of them.
const STOPWORDS = new Set(['THE', 'A', 'AN', 'AND', 'OF', 'FOR', 'TO', 'IN', 'ON', 'AT', 'BY']);

// Leave headroom for a numeric suffix so `base + <n>` can never exceed the cap.
const BASE_MAX = Math.max(2, PROJECT_CODE_MAX - 4);

/**
 * Derive the base code from a project name. Always returns a valid,
 * uppercase, letter-leading string (never empty) — falls back to `PRJ`
 * for a name with no letters at all.
 */
export const deriveProjectCodeBase = (name: string): string => {
    const tokens = name
        .toUpperCase()
        .split(/[^A-Z0-9]+/)
        .filter(Boolean);
    // "Significant" = carries a letter, so a pure-number token ("2026") is
    // skipped rather than producing a digit-leading initial.
    let words = tokens.filter((t) => /[A-Z]/.test(t));
    const meaningful = words.filter((w) => !STOPWORDS.has(w));
    if (meaningful.length > 0) words = meaningful;

    let base: string;
    if (words.length >= 2) {
        base = words.map((w) => w[0]).join('');
    } else if (words.length === 1) {
        base = words[0].slice(0, 3);
    } else {
        base = 'PRJ';
    }

    if (!/^[A-Z]/.test(base)) base = `P${base}`;
    base = base.slice(0, BASE_MAX);
    return base || 'PRJ';
};

/**
 * Pick the first free code for `base` given the set of already-taken codes
 * (compared case-insensitively). Returns `base` if free, else `base2`,
 * `base3`, … The final `Date.now()` fallback is unreachable in practice —
 * it only guards against a pathological, fully-saturated namespace.
 */
export const pickProjectCode = (base: string, taken: ReadonlySet<string>): string => {
    const takenUpper = new Set<string>();
    for (const c of taken) takenUpper.add(c.toUpperCase());

    if (!takenUpper.has(base.toUpperCase())) return base;
    for (let n = 2; n < 100_000; n++) {
        const candidate = `${base}${n}`;
        if (!takenUpper.has(candidate.toUpperCase())) return candidate;
    }
    return `${base}${Date.now()}`;
};
