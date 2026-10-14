import { useQuery } from '@tanstack/react-query'
import { apiMode } from '../http/config'
import { fetchLeaveBook, type LeaveBook } from '../http/leave'
import { readSession } from '../session/store'
import { ANNUAL_ALLOWANCE, LEAVE_TYPES } from './access'
import { annualLeft, annualPending, annualUsed } from './derive'
import type { LeaveRequest, PersonId } from '../types'

/** The design's leave book: four types, Annual leave with a fixed allowance counted from the requests. */
export const mockLeaveBook = (leave: LeaveRequest[], personId: PersonId): LeaveBook => ({
  types: LEAVE_TYPES,
  main: 'Annual',
  allowance: ANNUAL_ALLOWANCE,
  used: annualUsed(leave, personId),
  pending: annualPending(leave, personId),
  left: annualLeft(leave, personId),
})

const EMPTY: LeaveBook = { types: [], main: '', allowance: 0, used: 0, pending: 0, left: 0 }

/** Leave types and a person's balance: the design's in mock mode, the backend's in API mode. */
export const useLeaveBook = (leave: LeaveRequest[], personId: PersonId): LeaveBook => {
  const q = useQuery({
    queryKey: ['leaveBook', personId],
    queryFn: () => fetchLeaveBook(personId, readSession()),
    enabled: apiMode,
  })
  if (!apiMode) return mockLeaveBook(leave, personId)
  return q.data ?? EMPTY
}

/** "Annual leave", "Casual Leave": the main type as a leave label. */
export const leaveLabel = (main: string) => (!main ? 'Leave' : /leave$/i.test(main) ? main : `${main} leave`)
