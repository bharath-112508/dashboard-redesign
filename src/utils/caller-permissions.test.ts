// src/utils/caller-permissions.test.ts
import { describe, expect, it } from 'vitest';

import { callerCan } from './caller-permissions.js';
import { PERMISSIONS } from '../constants/permissions.js';

describe('callerCan', () => {
    it('true when the permission is held', () => {
        expect(callerCan(['timesheet.read'], PERMISSIONS.TIMESHEET_READ)).toBe(true);
    });
    it('false when not held', () => {
        expect(callerCan(['task.read'], PERMISSIONS.TIMESHEET_READ)).toBe(false);
    });
    it('system.admin wildcard satisfies everything', () => {
        expect(callerCan(['system.admin'], PERMISSIONS.BILLING_RATE_READ)).toBe(true);
    });
    it('undefined/empty held → false (pre-Step-47 tokens)', () => {
        expect(callerCan(undefined, PERMISSIONS.TASK_READ)).toBe(false);
        expect(callerCan([], PERMISSIONS.TASK_READ)).toBe(false);
    });
});
