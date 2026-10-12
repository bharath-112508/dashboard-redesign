import type {
  ClientBug,
  ClientTeamMember,
  Comment,
  Company,
  CompanyContact,
  DevopsLog,
  DevopsProject,
  DevopsRequest,
  DevopsRule,
  Epic,
  FileRef,
  Leave,
  LeaveSt,
  MatrixRole,
  PermKey,
  Person,
  Project,
  Question,
  Sprint,
  Subtask,
  Ticket,
  TicketStatus,
  TimeEntry,
} from '../types';

/** Ticket fields `tickets/patch` may change (V-21/22/27/48 and the client read flag). */
export type TicketPatch = Partial<Pick<Ticket, 'title' | 'st' | 'prio' | 'sprintId' | 'as' | 'start' | 'due' | 'est' | 'desc' | 'blk' | 'unread' | 'epicId'>>;
export type SubtaskPatch = Partial<Pick<Subtask, 'title' | 'st' | 'prio' | 'as' | 'due' | 'est' | 'note'>>;
export type ProjectPatch = Partial<Pick<Project, 'name' | 'desc' | 'state' | 'pct' | 'start' | 'due' | 'team' | 'sup' | 'area'>>;
export type PersonPatch = Partial<Omit<Person, 'id'>>;
export type CompanyPatch = Partial<Pick<Company, 'name' | 'industry' | 'country' | 'web' | 'logo' | 'notes'>>;
export type DevopsPatch = Partial<Omit<DevopsProject, 'key' | 'projectId' | 'logs' | 'notes'>>;
export type DevopsSettingsList = 'statuses' | 'phases';

/**
 * Every mutation of the app state, as a named action. Payloads are complete (ids, keys,
 * dates and the acting person are resolved by the commands), so the reducer is pure.
 * Screens never build these: they call the commands from `useActions()`.
 */
export type Action =
  // Session and profile (V-01…V-04)
  | { type: 'session/signIn'; personId: number }
  | { type: 'session/signOut' }
  | { type: 'profile/save'; personId: number; patch: PersonPatch }
  // Time (V-10, V-12)
  | { type: 'time/save'; entry: TimeEntry }
  | { type: 'time/delete'; id: number }
  // Tickets (V-20…V-22, V-27…V-29, V-31, V-48)
  | { type: 'tickets/create'; ticket: Ticket }
  | { type: 'tickets/patch'; key: string; patch: TicketPatch }
  | { type: 'tickets/markRead'; key: string }
  | { type: 'tickets/addComment'; key: string; comment: Comment }
  | { type: 'tickets/attach'; key: string; file: FileRef }
  // Subtasks (V-23…V-26)
  | { type: 'subtasks/add'; key: string; sub: Subtask }
  | { type: 'subtasks/patch'; key: string; subId: string; patch: SubtaskPatch }
  | { type: 'subtasks/comment'; key: string; subId: string; comment: Comment }
  | { type: 'subtasks/delete'; key: string; subId: string }
  // Projects (V-41, V-42, V-50, V-51, V-54)
  | { type: 'projects/create'; project: Project }
  | { type: 'projects/patch'; id: string; patch: ProjectPatch }
  | { type: 'projects/addFile'; id: string; file: FileRef }
  // Epics and sprints (V-46, V-47, V-49)
  | { type: 'epics/create'; epic: Epic }
  | { type: 'sprints/create'; sprint: Sprint }
  | { type: 'sprints/start'; id: string }
  | { type: 'sprints/complete'; id: string }
  // Client portal (V-53, V-60…V-64)
  | { type: 'questions/create'; question: Question }
  | { type: 'questions/answer'; id: number; answer: string; by: string }
  | { type: 'bugs/create'; bug: ClientBug }
  | { type: 'bugs/reply'; id: string; comment: Comment }
  | { type: 'bugs/setStatus'; id: string; st: TicketStatus }
  | { type: 'clientTeam/add'; member: ClientTeamMember }
  | { type: 'clientTeam/update'; id: string; patch: Partial<Omit<ClientTeamMember, 'id' | 'companyId'>> }
  | { type: 'clientTeam/remove'; id: string }
  // Users, leave, permissions (V-71…V-75)
  | { type: 'users/add'; person: Person }
  | { type: 'users/update'; id: number; patch: PersonPatch }
  | { type: 'users/setActive'; id: number; active: boolean }
  | { type: 'users/remove'; id: number }
  | { type: 'leave/add'; leave: Leave }
  | { type: 'leave/decide'; id: number; st: Exclude<LeaveSt, 'pending'>; by: string; when: string }
  | { type: 'perms/toggle'; role: MatrixRole; key: PermKey }
  // Companies (V-80…V-83)
  | { type: 'companies/create'; company: Company }
  | { type: 'companies/update'; id: string; patch: CompanyPatch }
  | { type: 'companies/setArchived'; id: string; archived: boolean }
  | { type: 'contacts/save'; companyId: string; index: number | null; contact: CompanyContact }
  | { type: 'contacts/remove'; companyId: string; index: number }
  // DevOps (V-52, V-91…V-100)
  | { type: 'devops/create'; record: DevopsProject }
  | { type: 'devops/patch'; key: string; patch: DevopsPatch; by: string; log?: DevopsLog }
  | { type: 'devops/addNote'; key: string; note: DevopsLog }
  | { type: 'requests/create'; request: DevopsRequest; log: DevopsLog }
  | { type: 'requests/setStatus'; id: number; status: DevopsRequest['status']; log: DevopsLog }
  | { type: 'requests/comment'; id: number; comment: Comment }
  | { type: 'devopsSettings/saveItem'; list: DevopsSettingsList; index: number | null; name: string; days?: number; by: string }
  | { type: 'devopsSettings/removeItem'; list: DevopsSettingsList; index: number; by: string }
  | { type: 'devopsSettings/toggleRule'; rule: DevopsRule }
  // Demo
  | { type: 'demo/reset' };

export type ActionType = Action['type'];
