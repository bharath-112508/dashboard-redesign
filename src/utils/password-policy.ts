import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../constants/auth.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from './app-error.js';

/**
 * The password policy, as configured in Settings → Security.
 *
 * These six fields were editable and read by nothing — the real rule was a
 * hardcoded `PASSWORD_REGEX` of `{10,12}` plus all four character classes. An
 * admin could tighten the policy, watch it save, and be wrong about their own
 * security posture. The stored values are now the only definition of the rule.
 */
export interface PasswordPolicy {
    min_length: number;
    max_length: number;
    require_upper: boolean;
    require_lower: boolean;
    require_number: boolean;
    require_special: boolean;
}

/** Used when a settings row predates these fields. Matches the old hardcoded rule. */
export const PASSWORD_POLICY_FALLBACK: PasswordPolicy = {
    min_length: PASSWORD_MIN_LENGTH,
    max_length: PASSWORD_MAX_LENGTH,
    require_upper: true,
    require_lower: true,
    require_number: true,
    require_special: true,
};

const CLASS_RULES = [
    { flag: 'require_upper', test: /[A-Z]/, label: 'an uppercase letter' },
    { flag: 'require_lower', test: /[a-z]/, label: 'a lowercase letter' },
    { flag: 'require_number', test: /\d/, label: 'a number' },
    { flag: 'require_special', test: /[^\da-zA-Z]/, label: 'a special character' },
] as const satisfies readonly { flag: keyof PasswordPolicy; test: RegExp; label: string }[];

/**
 * Pure — takes the `security` subdocument rather than reading settings itself.
 *
 * This module must not import `settings.service`: the service imports back
 * from here to publish the policy on `GET /settings/public`, and a static
 * cycle between the two would leave one side's exports undefined depending on
 * which module Node happens to evaluate first.
 */
export const resolvePasswordPolicy = (security?: Partial<PasswordPolicyFields> | null): PasswordPolicy => {
    const f = PASSWORD_POLICY_FALLBACK;
    return {
        min_length: security?.password_min_length ?? f.min_length,
        max_length: security?.password_max_length ?? f.max_length,
        require_upper: security?.password_require_upper ?? f.require_upper,
        require_lower: security?.password_require_lower ?? f.require_lower,
        require_number: security?.password_require_number ?? f.require_number,
        require_special: security?.password_require_special ?? f.require_special,
    };
};

/** The shape `resolvePasswordPolicy` reads off `system_settings.security`. */
export interface PasswordPolicyFields {
    password_min_length: number;
    password_max_length: number;
    password_require_upper: boolean;
    password_require_lower: boolean;
    password_require_number: boolean;
    password_require_special: boolean;
}

/** Human-readable summary of the active policy — error copy and the FE hint. */
export const describePasswordPolicy = (policy: PasswordPolicy): string => {
    const classes = CLASS_RULES.filter((r) => policy[r.flag]).map((r) => r.label);
    const range = `${policy.min_length}–${policy.max_length} characters`;
    return classes.length ? `${range}, and include ${classes.join(', ')}` : range;
};

/**
 * Every rule the password breaks, not just the first — someone told only "too
 * short" will lengthen it, resubmit, and then be told "needs a digit".
 */
export const findPasswordViolations = (password: string, policy: PasswordPolicy): string[] => {
    const problems: string[] = [];
    if (password.length < policy.min_length) problems.push(`be at least ${policy.min_length} characters`);
    if (password.length > policy.max_length) problems.push(`be at most ${policy.max_length} characters`);
    for (const rule of CLASS_RULES) {
        if (policy[rule.flag] && !rule.test.test(password)) problems.push(`include ${rule.label}`);
    }
    return problems;
};

/**
 * Throws `422 PASSWORD_POLICY_VIOLATION` when the input fails the configured
 * policy. This is the **single** enforcement point — change-password,
 * reset-password, create-user and add-representative all route through it, so
 * there is exactly one place the rule can be wrong.
 */
export const assertPasswordPolicy = async (password: string): Promise<void> => {
    // Imported lazily — see the note on `resolvePasswordPolicy`. A static
    // import here would close the cycle with `settings.service`.
    const { getOrInitSettings } = await import('../services/settings.service.js');
    const policy = resolvePasswordPolicy((await getOrInitSettings()).security);
    const problems = findPasswordViolations(password, policy);
    if (problems.length === 0) return;
    throw AppError.unprocessable(`Password must ${problems.join(', ')}.`, ERROR_CODES.PASSWORD_POLICY_VIOLATION);
};
