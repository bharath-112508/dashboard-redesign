import { describe, it, expect } from 'vitest';
import { PERMISSIONS, PERMISSION_VALUES } from './permissions.js';
import { SYSTEM_ROLE_DEFINITIONS } from './system-role-definitions.js';
import { SYSTEM_ROLE_KEYS } from './role-keys.js';

describe('payroll permissions', () => {
    it('exposes the four payroll permissions in the catalog', () => {
        for (const p of [
            PERMISSIONS.PAYROLL_READ,
            PERMISSIONS.PAYROLL_WRITE,
            PERMISSIONS.PAYSLIP_GENERATE,
            PERMISSIONS.LETTER_GENERATE,
        ]) {
            expect(PERMISSION_VALUES).toContain(p);
        }
    });

    it('bundles payroll permissions into the manager role', () => {
        const manager = SYSTEM_ROLE_DEFINITIONS.find((r) => r.key === SYSTEM_ROLE_KEYS.MANAGER)!;
        expect(manager.permissions).toContain(PERMISSIONS.PAYROLL_READ);
        expect(manager.permissions).toContain(PERMISSIONS.LETTER_GENERATE);
    });

    it('does NOT bundle payroll into employee', () => {
        const employee = SYSTEM_ROLE_DEFINITIONS.find((r) => r.key === SYSTEM_ROLE_KEYS.EMPLOYEE)!;
        expect(employee.permissions).not.toContain(PERMISSIONS.PAYROLL_READ);
    });
});
