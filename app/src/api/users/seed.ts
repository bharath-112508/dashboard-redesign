import type { Db, LeaveRequest } from '../types'
import { DEFAULT_DEV_TYPES, DEFAULT_PERMS } from './access'

/** The prototype's four leave requests (Employee timesheets, `hr.leave`), assigned to seed people. */
const LEAVE_SEED: LeaveRequest[] = [
  { id: '1', userId: '3', type: 'Annual', from: '2026-08-10', to: '2026-08-14', reason: 'Summer holiday', status: 'Approved', decidedBy: 'Rahul', decidedWhen: '2026-07-20' },
  { id: '2', userId: '3', type: 'Sick', from: '2026-09-22', to: '2026-09-22', reason: 'Fever', status: 'Approved', decidedBy: 'Vivek', decidedWhen: '2026-09-22' },
  { id: '3', userId: '4', type: 'Annual', from: '2026-10-27', to: '2026-10-30', reason: 'Family visit', status: 'Pending' },
  { id: '4', userId: '2', type: 'Personal', from: '2026-07-03', to: '2026-07-03', reason: 'Moving house', status: 'Rejected', decidedBy: 'Rahul', decidedWhen: '2026-06-28' },
]

/** Collections WP-07 adds to the db. Spread into createSeed. */
export const USERS_SEED: Pick<Db, 'leave' | 'notifications' | 'access'> = {
  leave: LEAVE_SEED,
  notifications: [],
  access: { perms: DEFAULT_PERMS, devTypes: DEFAULT_DEV_TYPES },
}
