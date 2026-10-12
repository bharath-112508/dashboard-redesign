import type {
  Comment,
  DevopsRuleKey,
  LeaveStatus,
  LeaveType,
  LogLine,
  PortalPerm,
  ProjectStatus,
  QMsg,
  StaffRole,
  SupportPlan,
  Ticket,
  TicketStatus,
  TimeEntry,
} from '../types';
import type { UiPrefs } from './state';

/**
 * Every mutation of the app state, as a named action. Payloads are complete (ids, keys,
 * dates and the acting person are resolved before dispatch), so the reducer is pure.
 * Screens do not build these by hand: they call the commands from `useActions()`.
 */
export type Action =
  // Session (M-01…M-04)
  | { type: 'session/signIn'; user: string }
  | { type: 'session/signOut' }
  | { type: 'session/switchAccount' }
  | { type: 'session/setEmailDraft'; email: string }
  // Notifications and profile (M-06, M-07, M-09)
  | { type: 'notifications/markRead'; id: string }
  | { type: 'notifications/markAllRead'; ids: string[] }
  | { type: 'profile/setPush'; on: boolean }
  // Tickets (M-12, M-13, M-20, M-21, M-22)
  | { type: 'tickets/setStatus'; id: number; st: TicketStatus }
  | { type: 'tickets/addComment'; id: number; comment: Comment }
  | { type: 'tickets/setDesc'; id: number; desc: string }
  | { type: 'tickets/create'; ticket: Ticket }
  // Time (M-14, M-15, M-16, M-34)
  | { type: 'time/addEntry'; entry: TimeEntry }
  // Questions (M-23)
  | { type: 'questions/addMessage'; id: number; msg: QMsg }
  // Leave (M-35, M-36)
  | { type: 'leave/add'; leave: { id: number; who: string; type: LeaveType; from: string; to: string; reason: string } }
  | { type: 'leave/decide'; id: number; st: Exclude<LeaveStatus, 'Pending'>; by: string; when: string }
  // Projects and maintenance (M-28…M-33)
  | { type: 'projects/setStatus'; project: string; status: ProjectStatus }
  | { type: 'projects/savePlan'; project: string; plan: SupportPlan }
  | { type: 'maintenance/toggleBilling'; project: string; requestId: string }
  | { type: 'maintenance/assign'; project: string; requestId: string; who: string }
  | { type: 'maintenance/toggleTask'; project: string; taskId: string }
  // DevOps (M-37, M-38)
  | { type: 'devops/advancePhase'; project: string; next: string; line: LogLine }
  | { type: 'devops/adjustReminder'; index: number; delta: 1 | -1; line: LogLine }
  | { type: 'devops/addReminder'; line: LogLine }
  | { type: 'devops/toggleRule'; rule: DevopsRuleKey; line: LogLine }
  | { type: 'devops/movePhaseUp'; index: number; line: LogLine }
  | { type: 'devops/addPhase'; name: string; line: LogLine }
  // Companies and users (M-40, M-41)
  | { type: 'companies/setPortalPerm'; company: string; contact: string; perm: PortalPerm; on: boolean }
  | { type: 'companies/toggleArchived'; company: string }
  | { type: 'users/setRole'; name: string; role: StaffRole }
  | { type: 'users/toggleActive'; name: string }
  // UI preferences (any screen)
  | { type: 'ui/set'; patch: Partial<UiPrefs> }
  // Demo
  | { type: 'demo/reset' };

export type ActionType = Action['type'];
