import type { Leave } from '../types';

/**
 * Leave (v5 `LEAVE0`, 6 requests). Kinds are the web `LeaveType` values (DECISIONS 2,
 * B-3): Annual, Sick, Holiday, Personal.
 */
export const LEAVE: Leave[] = [
  { id: 1, who: 'Chary', kind: 'Annual', from: '2026-10-20', to: '2026-10-22', days: 3, reason: 'Family trip', st: 'pending' },
  { id: 2, who: 'Bhavana P', kind: 'Sick', from: '2026-10-08', to: '2026-10-08', days: 1, reason: 'Fever', st: 'pending' },
  { id: 3, who: 'Vivek', kind: 'Holiday', from: '2026-10-04', to: '2026-10-04', days: 1, reason: 'Worked Sat 4 Oct release', st: 'pending' },
  { id: 4, who: 'Rahul', kind: 'Personal', from: '2026-10-17', to: '2026-10-17', days: 1, reason: '', st: 'pending' },
  { id: 5, who: 'Chary', kind: 'Annual', from: '2026-09-15', to: '2026-09-16', days: 2, reason: '', st: 'approved', decidedBy: 'Vivek', decidedWhen: '2026-09-01' },
  { id: 6, who: 'Arjun', kind: 'Annual', from: '2026-11-02', to: '2026-11-06', days: 5, reason: 'Holiday', st: 'approved', decidedBy: 'Vivek', decidedWhen: '2026-10-01' },
];
