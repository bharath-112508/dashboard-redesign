/**
 * User roles (plan §2.2 / API_Contract Appendix A).
 */
export const ROLES = {
    ADMIN: 'admin',
    MANAGER: 'manager',
    EMPLOYEE: 'employee',
    CLIENT: 'client',
} as const;

export type RoleType = (typeof ROLES)[keyof typeof ROLES];
