/**
 * Entity types (mobile-spec-v5 DELTA §3). Names and ids follow the web app
 * (`app/src/api/types.ts`); tickets and time keep v5's mobile shape. People are
 * referenced by **name** in team lists, assignees, leave, entries and owners (B-2).
 */

// ── Roles, people, session ──────────────────────────────────────────────────

/** System roles (web `Role`). A freelancer is a `dev` with `emp: 'freelancer'`. */
export type Role = 'super' | 'admin' | 'pm' | 'dev' | 'devops' | 'cadmin' | 'cuser';
export type ClientRole = 'cadmin' | 'cuser';
export type StaffRole = Exclude<Role, ClientRole>;

/** Face keys of the staff photos in assets/faces (media.js VT_FACES_M / VT_FACES_W). */
export type FaceKey = 'm0' | 'm1' | 'm2' | 'm4' | 'm5' | 'm6' | 'w0' | 'w1';

export interface NotifPrefs {
  tickets: boolean;
  due: boolean;
  questions: boolean;
  weekly: boolean;
}

/** A person in the directory (web `Person`). */
export interface Person {
  id: number;
  name: string;
  email: string;
  /** 'vt' for Viljetech staff, otherwise the client company id. */
  org: string;
  role: Role;
  devType?: string;
  emp?: 'freelancer' | 'employee';
  /** 'all', or the ids of the projects this person works on. */
  projects: 'all' | string[];
  /** Avatar colour (web seed values, DECISIONS 2 / B-1). */
  colour: string;
  active: boolean;
  invited?: boolean;
  /** Free text: "Now", "2h ago", "Invited". */
  last: string;
  phone?: string;
  tz?: string;
  notif?: NotifPrefs;
  /** '' = no photo (initials); undefined = the built-in face; a data URL when uploaded. */
  photo?: string;
  /** Demo hash of a password set in Profile (V-04). Without it the demo password applies. */
  pwHash?: string;
}

export interface Session {
  /** signed-in person, or null */
  personId: number | null;
}

// ── Permissions ────────────────────────────────────────────────────────────

/**
 * Action permissions (SPEC §2.3; ids stay as v5 defines them, A-7). Web
 * `AccessConfig.perms` ids: tickets.create→tk.edit, tickets.assign→tk.edit,
 * projects.create→pr.create, sprints.manage→pr.plan, time.others→ts.all,
 * companies.edit→ws.companies, users.manage→ws.users, devops.edit and leave.approve
 * have no web id. `time.others` is in the matrix but gates nothing (A-6).
 */
export type PermKey =
  | 'tickets.create'
  | 'tickets.assign'
  | 'sprints.manage'
  | 'time.others'
  | 'leave.approve'
  | 'companies.edit'
  | 'projects.create'
  | 'users.manage'
  | 'devops.edit';

/** Roles with an editable row in the matrix (super always has every permission). */
export type MatrixRole = Exclude<Role, 'super'>;
export type PermMatrix = Record<MatrixRole, Partial<Record<PermKey, boolean>>>;

/** Page names of the access map (web `session/access.ts`). */
export type Page =
  | 'Dashboard'
  | 'Companies'
  | 'Projects'
  | 'Tickets'
  | 'Clients'
  | 'Timesheet'
  | 'Employee Timesheets'
  | 'DevOps Board v6'
  | 'Users';

// ── Companies and projects ─────────────────────────────────────────────────

/** Web `CompanyContact` (without personId). */
export interface CompanyContact {
  name: string;
  role: string;
  email: string;
  /** ids of this company's projects the contact sees in the portal */
  projects: string[];
  /** portal admin */
  admin?: boolean;
}

/** Web `Company`; its projects live in the flat project list (`companyId`). */
export interface Company {
  id: string;
  name: string;
  industry: string;
  country: string;
  web: string;
  /** uploaded logo (data URL); '' = initials; undefined = media logo if any */
  logo?: string;
  /** palette index */
  p: number;
  notes: string;
  contacts: CompanyContact[];
  /** company role per person name ("Responsible from Viljetech") */
  ourRoles: Record<string, string>;
  archived: boolean;
}

export type ProjectState = 'planned' | 'active' | 'maint' | 'done' | 'hold';
export type ProjectKind = 'client' | 'internal';

/** Support agreement of a maintenance project (web `SupportPlan`). */
export interface SupportPlan {
  /** ISO day */
  until: string;
  /** hours used this month */
  used: number;
  /** hours per month */
  quota: number;
}

/** A client project (web `ClientProject`) or an internal project (web `InternalProject`). */
export interface Project {
  id: string;
  kind: ProjectKind;
  /** client projects */
  companyId?: string;
  /** internal projects (AREAS) */
  area?: string;
  name: string;
  desc: string;
  state: ProjectState;
  pct: number;
  start?: string;
  /** ISO day or '' */
  due: string;
  /** person names */
  team: string[];
  sup?: SupportPlan;
  /** ticket key prefix for new tickets (A-13), e.g. PMT; internal i1 uses INT */
  keyPrefix: string;
}

/** Web `EpicSummary` + projectId. A project without epics gets a pseudo-epic (selector). */
export interface Epic {
  id: string;
  projectId: string;
  name: string;
  state: ProjectState;
  pct: number;
  /** planned sprint count shown in the prototype ("Sprint 2 of 8") */
  sprints: number;
  /** requirement text (new epics) */
  req?: string;
}

export type SprintState = 'planned' | 'active' | 'done';

/** In state: created, started and completed by the user (A-12: one active per epic). */
export interface Sprint {
  id: string;
  epicId: string;
  name: string;
  start: string;
  end: string;
  state: SprintState;
}

// ── Tickets ────────────────────────────────────────────────────────────────

export type TicketStatus = 'todo' | 'prog' | 'review' | 'done';
export type TicketPrio = 'Critical' | 'High' | 'Medium' | 'Low';
export type TicketType = 'Task' | 'Story' | 'Bug';

export interface Comment {
  who: string;
  t: string;
  /** display text: "2h ago", "just now" */
  when: string;
}

/** A file reference (ticket attachment, project file, bug attachment). */
export interface FileRef {
  n: string;
  /** "14 KB" */
  size: string;
  /** ISO day */
  when: string;
  by?: string;
}

/**
 * A subtask. `id` is stable (A-11): "PMT-11.s2". The displayed key is positional
 * ("PMT-11.2", see `subKey`), but links and time entries use the id.
 */
export interface Subtask {
  id: string;
  title: string;
  st: TicketStatus;
  prio?: TicketPrio;
  /** single assignee name, '' = unassigned */
  as: string;
  due: string;
  /** hours */
  est?: number;
  note: string;
  comments: Comment[];
}

export interface Ticket {
  key: string;
  title: string;
  projectId: string;
  /** epic id, or the project id for a project without epics (pseudo-epic) */
  epicId: string;
  /** null = backlog */
  sprintId: string | null;
  type: TicketType;
  st: TicketStatus;
  prio: TicketPrio;
  start?: string;
  due?: string;
  /** hours */
  est: number;
  /** assignee names */
  as: string[];
  subs: Subtask[];
  desc: string;
  att: FileRef[];
  /** keys of blocking tickets */
  blk: string[];
  /** unread comments for the assignees (seed; cleared on open, V-20) */
  unread: number;
  comments: Comment[];
  /** raised from the client portal */
  client?: boolean;
  /** a support request on a maintenance project */
  support?: 'problem' | 'change';
  /** next subtask number (keeps subtask ids unique after deletes) */
  subSeq: number;
}

// ── Time ───────────────────────────────────────────────────────────────────

/**
 * A time entry in minutes. `proj` is 'c:<id>' (client project), 'i:<id>' (internal) or
 * 'x:admin'. `key` is '' (text entry), a ticket key, or a subtask id. Web `TimeEntry`
 * stores `bill`/`non` hours per project; mobile keeps v5's shape.
 * `who` = '*' marks the demo owner (the signed-in person, as v5's `mine`); `team`
 * marks the generated team entries (hidden for the signed-in person).
 */
export interface TimeEntry {
  id: number;
  who: string;
  date: string;
  proj: string;
  key: string;
  task: string;
  min: number;
  bill: boolean;
  note: string;
  team?: boolean;
}

// ── Leave ──────────────────────────────────────────────────────────────────

/** Web `LeaveType` values (DECISIONS 2 / B-3). */
export type LeaveKind = 'Annual' | 'Sick' | 'Holiday' | 'Personal';
export type LeaveSt = 'pending' | 'approved' | 'rejected';

export interface Leave {
  id: number;
  /** person name */
  who: string;
  kind: LeaveKind;
  from: string;
  to: string;
  days: number;
  reason: string;
  st: LeaveSt;
  decidedBy?: string;
  /** ISO day */
  decidedWhen?: string;
}

// ── Client portal ──────────────────────────────────────────────────────────

/** Web `Question` minus chat. */
export interface Question {
  id: number;
  /** asker (staff name) */
  by: string;
  title: string;
  text: string;
  when: string;
  /** linked ticket key */
  task: string | null;
  answer: string;
  answeredBy?: string;
  projectId: string;
  solved?: boolean;
}

export interface ClientBug {
  id: string;
  title: string;
  desc: string;
  atts: FileRef[];
  epicId?: string;
  projectId: string;
  /** ISO day */
  when: string;
  by: string;
  st: TicketStatus;
}

export interface ClientTeamMember {
  id: string;
  companyId: string;
  name: string;
  email: string;
  title: string;
}

// ── DevOps ─────────────────────────────────────────────────────────────────

export interface DevopsLog {
  by: string;
  /** display text: "2 d ago", "Just now" */
  when: string;
  text: string;
}

export interface InternalFollowUp {
  /** ISO day */
  date: string;
  name: string;
  done?: boolean;
  note?: string;
}

/**
 * A DevOps record. Project-specific (DECISIONS 3): name, tile and company come from
 * the linked project (`projectId`), never from the record. Dates are ISO (A-14):
 * days "2026-11-30", reminders "2026-10-12T07:00".
 */
export interface DevopsProject {
  key: string;
  projectId: string;
  /** status (one of devopsSettings.statuses) */
  infra: string;
  /** Action from: Client / Development team / DevOps / Not set */
  from: string;
  prio: string;
  /** Action status (ladder step name or "Not required") */
  act: string;
  /** client ladder step index */
  step?: number;
  /** what happened so far */
  phase?: string;
  /** next step text */
  next?: string;
  actDate?: string;
  reminder?: string;
  overdue: boolean;
  initDue?: string;
  latestDue?: string;
  /** "+20 d" */
  moved?: string;
  reason?: string;
  deploy: string;
  depType?: string;
  /** dev phase */
  dev: string;
  owner: string;
  updatedBy: string;
  cicd: boolean;
  /** internal follow-ups */
  ifu?: InternalFollowUp[];
  /** newest first */
  logs: DevopsLog[];
  /** newest first */
  notes: DevopsLog[];
}

export interface Deployment {
  v: string;
  name: string;
  st: 'Live' | 'Rolled back';
  when: string;
  note?: string;
}

export interface DevopsRequest {
  id: number;
  /** DevOps key (the project name is derived from its projectId) */
  key: string;
  rkey: string;
  type: string;
  prio: string;
  to: string;
  text: string;
  by: string;
  when: string;
  status: 'Open' | 'Done';
  comments: Comment[];
}

export type DevopsRule = 'requireNote' | 'requireReminder' | 'lockInitial' | 'lockDevDue';

export interface DevopsSettings {
  statuses: string[];
  /** client follow-up ladder: name + hours after the previous step */
  ladder: { n: string; h: number }[];
  /** internal ladder names */
  iladder: string[];
  /** dev phases with typical days */
  phases: { n: string; d: number }[];
  rules: Record<DevopsRule, boolean>;
  /** ladder step index from which a step shows red */
  esc: number;
  /** DevOps owners and request assignees (A-8, web DvSettings.people) */
  people: string[];
}
