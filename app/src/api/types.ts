import type { DevopsDb } from './devops/types'

export type TaskType = 'Bug' | 'Task' | 'Story'
export type Priority = 'Critical' | 'Urgent' | 'High' | 'Medium' | 'Low'
export type ClientPriority = 'Low' | 'Medium' | 'High' | 'Critical'
export type SprintState = 'done' | 'active' | 'planned'

export interface Status {
  id: string
  name: string
  /** Palette index used for the status colour. */
  p: number
}

export interface Epic {
  id: string
  name: string
  p: number
  desc?: string
  goal?: string
  story?: string
  criteria?: string[]
  critDone?: Record<number, boolean>
  target?: string
  inScope?: string[]
  outScope?: string[]
  reqs?: string[]
  risks?: string[]
  questions?: string[]
}

export type EpicListField = 'inScope' | 'outScope' | 'reqs' | 'risks' | 'questions' | 'criteria'

export interface Sprint {
  id: string
  epic: string
  name: string
  start: string
  end: string
  members: string[]
  state: SprintState
  summary?: string
  goal?: string
  why?: string
  goals?: string[]
  goalsDone?: Record<number, boolean>
}

export interface Activity {
  kind: 'history' | 'comment'
  who: string
  what?: string
  text?: string
  when: string
}

export interface Attachment {
  name: string
  size: string
  date: string
  /** Data URL for small uploads; empty when the file was too large to keep. */
  url?: string
}

export interface ChatFile {
  name: string
  size: string
  url: string
  img: boolean
}

export interface ChatMessage {
  who: string
  side: 'client' | 'team'
  text: string
  when: string
  files: ChatFile[]
}

export interface Subtask {
  t: string
  done: boolean
  /** Id of the full subtask record once it has been opened. */
  sid?: number
  due?: string
  assignee?: string
  note?: string
}

export interface ClientBugInfo {
  reported: string
  chat: ChatMessage[]
}

export interface Task {
  id: number
  title: string
  type: TaskType
  status: string
  prio: Priority
  due: string
  assignee: string
  assignees?: string[]
  contribs: string[]
  est: string
  desc: string
  atts: Attachment[]
  subs: Subtask[]
  deps: number[]
  epic: string
  sprint: string | null
  start: string
  time: Record<string, number>
  acts: Activity[]
  /** Set on subtask records: id of the parent task. */
  parent?: number
  subKey?: string
  /** A ticket created from the plan view that has no title yet. */
  isNew?: boolean
  /** Present when the client reported this bug from the Clients page. */
  clientBug?: ClientBugInfo
}

/**
 * One timesheet entry, shared by the Dashboard quick log, My timesheet, the
 * Tickets timesheet and Employee timesheets. Hours are numbers. `userId` is
 * the person's id in the directory; `user` is their display name, kept so the
 * current Tickets views can still show it.
 */
export interface TimeEntry {
  id: number
  date: string
  userId: number
  user: string
  type: string
  /** Ticket id, or null for a text entry (then `area` is set). */
  task: number | null
  area?: string
  epic?: string
  /**
   * Project the time is booked to: `c:<client project id>` or `i:<internal project id>`.
   * Set by My timesheet. When a writer leaves it out and `task` is set, the
   * store fills it in from the ticket's epic (see api/timesheet/projects.ts).
   */
  project?: string
  notes: string
  bill: number
  non: number
}

/** A week (Monday's ISO date) that a person has submitted. Present means locked. */
export interface WeekSubmission {
  userId: number
  /** Monday of the week, 'YYYY-MM-DD'. */
  week: string
  /** Display time of the submit, e.g. '12 Oct 2026, 14:05'. */
  when: string
}

/** System roles. The keys are used by the session, the page access map and the directory. */
export type Role = 'super' | 'admin' | 'pm' | 'dev' | 'devops' | 'cadmin' | 'cuser'

/** A developer type (discipline). The list is editable in Users (access.devTypes), so this is any name from it. */
export type DevType = string

export interface NotifPrefs {
  tickets: boolean
  due: boolean
  questions: boolean
  weekly: boolean
}

/**
 * A person in the directory. This is the one record for a person's name,
 * role, colour and photo; everything else refers to people by `id`.
 */
export interface Person {
  id: number
  name: string
  email: string
  /** 'vt' for Viljetech staff, otherwise the id of the client company. */
  org: string
  role: Role
  devType?: DevType
  emp?: 'freelancer' | 'employee'
  /** 'all', or the ids of the projects this person works on. */
  projects: 'all' | string[]
  /** Personal colour for avatars on the team side. */
  colour: string
  active: boolean
  invited?: boolean
  /** Free text shown in Users, such as "Now" or "2h ago". */
  last: string
  phone?: string
  tz?: string
  notif?: NotifPrefs
  /** A data URL when uploaded, '' for no photo, undefined for the built-in face. */
  photo?: string
  /** SHA-256 hex of a password set from the profile. Without it, the demo password applies. */
  pwHash?: string
}

/** The signed-in user. Stored per browser in localStorage under `vt.session`. */
export interface Session {
  personId: number
  name: string
  email: string
  role: Role
  /** Organisation name: 'Viljetech', or the client company's name. */
  org: string
  /** Company id, for client users. */
  orgId?: string
  emp?: 'freelancer' | 'employee'
  phone?: string
  tz?: string
  notif?: Partial<NotifPrefs>
}

export type CompanyRole = 'Super admin' | 'Admin' | 'Developer' | 'Viewer'

export interface CompanyContact {
  /** The directory person this contact is, when there is one. */
  personId: number | null
  name: string
  role: string
  email: string
  /** Ids of the company's projects this contact works on. */
  projects: string[]
  admin?: boolean
}

export type ProjectState = 'active' | 'planned' | 'done' | 'hold'

export interface EpicSummary {
  id: string
  name: string
  state: ProjectState
  pct: number
  sprints: number
}

export interface ClientProject {
  id: string
  name: string
  desc: string
  state: ProjectState
  pct: number
  due: string
  start?: string
  /** Directory person ids. */
  team: number[]
  epics: EpicSummary[]
}

export interface Company {
  id: string
  name: string
  industry: string
  country: string
  web: string
  /** A data URL. When missing, the logo comes from lib/media.ts. */
  logo?: string
  /** Palette index used for the company colour. */
  p: number
  notes: string
  contacts: CompanyContact[]
  projects: ClientProject[]
  /** Company role per directory person id. */
  ourRoles: Record<number, CompanyRole>
  archived: boolean
  archivedAt: string | null
}

export interface InternalProject {
  id: string
  name: string
  desc: string
  area: string
  state: ProjectState
  pct: number
  start?: string
  due: string
  /** Directory person ids. */
  team: number[]
}

export interface Question {
  id: number
  by: string
  title: string
  text: string
  when: string
  task: number | null
  answer: string
  answeredWhen?: string
  comments?: ChatMessage[]
  photos?: ChatFile[]
  solved?: boolean
  qtype?: string
  qprio?: string
  fromDevops?: boolean
  /** DevOps project key (e.g. OPS-101) for questions raised from the DevOps board. */
  project?: string
  sprint?: string | null
  /** How many client messages the team has already seen (Tickets page unread badge). */
  seenT?: number
}

export type RequestStatus = 'Open' | 'In progress' | 'Done'

export interface RequestComment {
  by: string
  text: string
  when: string
  side: 'tickets' | 'devops'
}

export interface DevopsRequest {
  id: number
  key: string
  pname: string
  rkey: string
  type: string
  prio: Priority
  to: string
  text: string
  by: string
  when: string
  raised: string
  status: RequestStatus
  comments: RequestComment[]
  history?: { by: string; text: string; when: string }[]
  desc?: string
  due?: string
  start?: string
  est?: string
  logs?: { h: number; by: string; when: string; date?: string; notes?: string }[]
  /** How many DevOps replies / which status the Tickets side has already seen (for unread badges). */
  seenT?: number
  statusSeen?: string
}

export interface Workspace {
  statuses: Status[]
  epics: Epic[]
  sprints: Sprint[]
  /** Which DevOps project (key in the devops resource) each epic is linked to. */
  devopsLinks: Record<string, string>
}

export interface Db {
  version: number
  workspace: Workspace
  tasks: Task[]
  entries: TimeEntry[]
  weekSubmissions: WeekSubmission[]
  questions: Question[]
  requests: DevopsRequest[]
  devops: DevopsDb
  people: Person[]
  companies: Company[]
  internalProjects: InternalProject[]
}

/** Points at one project: a client project inside its company, or an internal project. */
export type ProjectRef = { kind: 'client'; companyId: string; id: string } | { kind: 'internal'; id: string }

// ---- WP-07: users, access, leave and notifications

/** Permission groups in the Roles & permissions matrix, in display order. */
export type PermissionGroup = 'Workspace' | 'Projects' | 'Tickets' | 'Time & money'

/** Permission ids per role, plus the developer types offered on user forms. */
export interface AccessConfig {
  /** Display and admin data. Page access is still decided by the role map in session/access.ts (DECISIONS 5). */
  perms: Record<Role, string[]>
  devTypes: string[]
}

export type LeaveType = 'Annual' | 'Sick' | 'Holiday' | 'Personal'
export type LeaveStatus = 'Pending' | 'Approved' | 'Rejected'

export interface LeaveRequest {
  id: number
  /** Directory person id. */
  userId: number
  type: LeaveType
  /** ISO dates, both inclusive. */
  from: string
  to: string
  reason: string
  status: LeaveStatus
  decidedBy?: string
  decidedWhen?: string
}

/** A note recorded for one person, such as the outcome of their leave request. */
export interface Notification {
  id: number
  userId: number
  kind: 'leave'
  text: string
  when: string
}

/**
 * The collections WP-07 adds to the shared db. This second declaration merges
 * into the Db interface above, so the file stays append-only.
 */
export interface Db {
  leave: LeaveRequest[]
  notifications: Notification[]
  access: AccessConfig
}

/**
 * A member a client company added to its team on the Clients portal. Company
 * contacts are not copied here: the team reads them from the company, and this
 * list only holds people who are not contacts (DECISIONS item 3).
 */
export interface ClientTeamMember {
  id: string
  /** The client company (Company.id) the member belongs to. */
  companyId: string
  name: string
  email: string
  title?: string
}
