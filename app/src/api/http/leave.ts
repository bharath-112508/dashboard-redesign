import { ApiError, api } from './client'
import { allPages } from './companies'
import { isClientRole } from '../session/access'
import { fmt, range } from '../../lib/dates'
import type { LeaveRequest, LeaveStatus, Notification, PersonId, Session } from '../types'
import type { UsersCommand } from '../users/commands'

type BackendLeave = {
  id: string
  user_id: string
  user?: { id: string; full_name: string } | null
  requested_leave_type?: { id: string; code: string; name: string } | null
  start_date: string
  end_date: string
  reason: string
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'
  acted_at?: string | null
}
type BackendLeaveType = { id: string; code: string; name: string; is_unlimited: boolean; is_earned: boolean }
type BackendBalance = {
  leave_type: BackendLeaveType
  allocated: number
  carried_forward: number
  adjusted: number
  used: number
  pending: number
  available: number
}

const STATUS: Record<string, LeaveStatus> = { pending: 'Pending', approved: 'Approved', rejected: 'Rejected' }

const leaveFrom = (r: BackendLeave): LeaveRequest => ({
  id: r.id,
  userId: r.user?.id ?? r.user_id,
  type: r.requested_leave_type?.name ?? 'Leave',
  from: r.start_date,
  to: r.end_date,
  reason: r.reason,
  status: STATUS[r.status],
  ...(r.acted_at ? { decidedWhen: r.acted_at.slice(0, 10) } : {}),
})

/**
 * Leave requests the person may see: their own, a manager's direct reports',
 * everyone's for an admin (whose own come from a second read, since the
 * backend's admin list leaves them out). Cancelled requests are not shown;
 * the design has no Cancelled state.
 */
export const fetchLeave = async (session: Session | null): Promise<LeaveRequest[]> => {
  if (!session || isClientRole(session.role)) return []
  const [list, own] = await Promise.all([
    allPages<BackendLeave>('/leaves'),
    session.role === 'super' ? allPages<BackendLeave>(`/leaves?user_id=${session.personId}`) : Promise.resolve([]),
  ])
  const byId = new Map([...list, ...own].map(r => [r.id, r]))
  return [...byId.values()].filter(r => r.status !== 'cancelled').map(leaveFrom)
}

/**
 * Leave notices for the profile page, built from decided requests in the
 * design's words (the backend's notifications can be read only by their owner).
 */
export const fetchLeaveNotices = async (session: Session | null): Promise<Notification[]> =>
  (await fetchLeave(session))
    .filter(r => r.status !== 'Pending')
    .sort((a, b) => (b.decidedWhen ?? '').localeCompare(a.decidedWhen ?? ''))
    .map((r, i) => ({
      id: i + 1,
      userId: r.userId,
      kind: 'leave' as const,
      // "Your Annual leave" in the design; a backend name already ends in "Leave".
      text: `Your ${/leave$/i.test(r.type) ? r.type : `${r.type} leave`}, ${range(r.from, r.to)}, was ${r.status === 'Approved' ? 'approved' : 'rejected'}.`,
      when: r.decidedWhen ? fmt(r.decidedWhen) : '',
    }))

/** What the leave section shows: the types to pick from and the main type's balance. */
export interface LeaveBook {
  types: string[]
  main: string
  allowance: number
  used: number
  pending: number
  left: number
}

/**
 * The backend's leave types and one person's balance of the main type (the
 * first limited, non-earned type: Casual leave).
 */
export const fetchLeaveBook = async (personId: PersonId, session: Session | null): Promise<LeaveBook> => {
  const types = await api.get<BackendLeaveType[]>('/leave-types')
  const year = new Date().getFullYear()
  const rows = await api.get<BackendBalance[]>(
    personId === session?.personId ? `/leave-balances/me?year=${year}` : `/leave-balances?user_id=${personId}&year=${year}`,
  )
  const limited = (t: BackendLeaveType) => !t.is_unlimited && !t.is_earned
  const row = rows.find(r => r.leave_type.code === 'CL') ?? rows.find(r => limited(r.leave_type))
  const main = row?.leave_type.name ?? types.find(limited)?.name ?? ''
  return {
    types: types.map(t => t.name),
    main,
    allowance: row ? row.allocated + row.carried_forward + row.adjusted : 0,
    used: row?.used ?? 0,
    pending: row?.pending ?? 0,
    left: row?.available ?? 0,
  }
}

// ─── Writes ──────────────────────────────────────────────────────────────

type LeaveCommand = Extract<UsersCommand, { type: 'leave.create' | 'leave.decide' }>
export const isLeaveApiCommand = (cmd: { type: string }): cmd is LeaveCommand => cmd.type === 'leave.create' || cmd.type === 'leave.decide'

/** Sends a leave request or a decision to the backend. */
export const sendLeaveCommand = async (cmd: LeaveCommand, session: Session | null): Promise<{ id?: string }> => {
  if (cmd.type === 'leave.create') {
    const r = cmd.request
    const type = (await api.get<BackendLeaveType[]>('/leave-types')).find(t => t.name === r.type)
    if (!type) throw new ApiError(422, 'VALIDATION_ERROR', `${r.type} is not a leave type on the backend.`)
    const { id } = await api.post<{ id: string }>('/leaves', {
      leave_type_id: type.id,
      start_date: r.from,
      end_date: r.to,
      // The backend needs a reason; the form's is optional.
      reason: r.reason.trim() || r.type,
      ...(r.userId !== session?.personId ? { user_id: r.userId } : {}),
    })
    return { id }
  }
  if (cmd.status === 'Approved') await api.post(`/leaves/${cmd.id}/approve`, {})
  else await api.post(`/leaves/${cmd.id}/reject`, { approver_remarks: `Rejected by ${cmd.by}` })
  return {}
}
