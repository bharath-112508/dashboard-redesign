import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PASSWORD_REGEX } from '../constants/auth.js';
import { ERROR_CODES } from '../constants/error-codes.js';
import { AppError } from './app-error.js';

/**
 * Throws `422 PASSWORD_POLICY_VIOLATION` if the input fails the plan §7.2
 * policy (length 10–12, upper + lower + digit + special). Used from the
 * service layer for password fields that Zod only structurally validates
 * (e.g. `POST /users { initial_password }`).
 */
export const assertPasswordPolicy = (password: string): void => {
    if (!PASSWORD_REGEX.test(password)) {
        throw AppError.unprocessable(
            `Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters ` +
                'and include upper, lower, number, and special character.',
            ERROR_CODES.PASSWORD_POLICY_VIOLATION
        );
    }
};
