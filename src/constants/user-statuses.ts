/**
 * User account statuses (Data_Model.md §1.1).
 * Only `active` users can log in; deactivation is non-destructive.
 */
export const USER_STATUSES = {
    ACTIVE: 'active',
    DEACTIVATED: 'deactivated',
} as const;

export type UserStatus = (typeof USER_STATUSES)[keyof typeof USER_STATUSES];
