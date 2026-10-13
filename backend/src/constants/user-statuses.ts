/**
 * User account statuses (Data_Model.md §1.1).
 * Only `active` users can log in; deactivation is non-destructive.
 */
export const USER_STATUSES = {
    ACTIVE: 'active',
    DEACTIVATED: 'deactivated',
} as const;

export type UserStatus = (typeof USER_STATUSES)[keyof typeof USER_STATUSES];

/**
 * Employment type — how a person is engaged, independent of their platform
 * role. A Freelancer and a Staff engineer can both be `role: 'employee'`;
 * this is the HR distinction, not an authorization one.
 *
 * Optional-with-default rather than required: every user created before this
 * field existed reads back as `staff`, so no migration and no `undefined`
 * branch in consumers. Set it explicitly when engaging a freelancer.
 */
export const EMPLOYMENT_TYPES = {
    STAFF: 'staff',
    FREELANCER: 'freelancer',
} as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[keyof typeof EMPLOYMENT_TYPES];

export const EMPLOYMENT_TYPE_VALUES: readonly EmploymentType[] = Object.values(EMPLOYMENT_TYPES);
