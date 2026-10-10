import type { Tone } from './model'

/**
 * Figures the Dashboard shows that have no store in this build yet. They are
 * the prototype's sample values, kept in one place so they are easy to find
 * and replace:
 * - leave and comp-off approvals belong to Users (WP-07);
 * - hours sold per project (budgets) are not on the project model.
 * Everything else on the Dashboard is computed from the shared stores.
 */

export interface StaticListRow {
  tag: string
  tone: Tone
  title: string
  meta: string
  right?: string
  rightTone?: 'red' | 'amber' | 'ink'
}

export const APPROVALS: StaticListRow[] = [
  { tag: 'Leave', tone: 'amber', title: 'Chary · Annual leave', meta: '20–22 Oct · 3 days', right: 'Review', rightTone: 'ink' },
  { tag: 'Leave', tone: 'amber', title: 'Bhavana P · Sick leave', meta: '8 Oct · 1 day', right: 'Review', rightTone: 'ink' },
  { tag: 'Comp-off', tone: 'blue', title: 'Vivek · +1 day', meta: 'Worked Sat 4 Oct release', right: 'Review', rightTone: 'ink' },
  { tag: 'Comp-off', tone: 'blue', title: 'Rahul · use 1 day', meta: 'Fri 17 Oct', right: 'Review', rightTone: 'ink' },
]

export const LEAVE_ATTENDANCE: StaticListRow[] = [
  { tag: 'Off today', tone: 'grey', title: 'Bhavana P', meta: 'Annual leave · back Mon 13 Oct' },
  { tag: 'Pending', tone: 'amber', title: 'Chary · 3 days', meta: 'Annual leave · 20–22 Oct', right: 'Approve', rightTone: 'ink' },
  { tag: 'Pending', tone: 'amber', title: 'Vivek · comp-off', meta: 'For Sat 4 Oct release', right: 'Approve', rightTone: 'ink' },
]

export interface StaticBudget {
  title: string
  hours: number
  sold: number
  meta: string
}

export const BUDGETS: StaticBudget[] = [
  { title: 'Daco · Daco platform', hours: 342, sold: 400, meta: '342h of 400h · 58h left' },
  { title: 'Daco · Intranet', hours: 188, sold: 160, meta: '188h of 160h · 28h over budget' },
  { title: 'Nordlys · Business portal', hours: 96, sold: 240, meta: '96h of 240h · 144h left' },
  { title: 'Fjord Logistics · Driver app', hours: 41, sold: 120, meta: '41h of 120h · 79h left' },
]
