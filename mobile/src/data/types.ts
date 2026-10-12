/**
 * Entity types (DATA.md §1). Field names follow the prototype so the seed reads like
 * DATA.md; the web-app equivalents are noted where they differ.
 */

// ── People and session ────────────────────────────────────────────────────────

export type Role = 'super' | 'admin' | 'pm' | 'dev' | 'free' | 'devops' | 'client';

/** Labels used on the Users & roles screens (web: Person.role). */
export type StaffRole =
  | 'Super admin'
  | 'Admin'
  | 'Project manager'
  | 'Developer'
  | 'DevOps engineer'
  | 'Freelancer';

export type FaceKey = 'm0' | 'm1' | 'm2' | 'm4' | 'm6' | 'w0';

export interface Person {
  name: string;
  /** Account role used for sign-in (web: Person.role). Lars Moen has no account. */
  role: Role | null;
  /** Display label, e.g. "Developer · Frontend". */
  title: string;
  email: string;
  color: string;
  face?: FaceKey;
  /** Client people always render as initials. */
  client?: boolean;
  /** Users & roles overlay (web: Person.role / AccessConfig). */
  staffRole?: StaffRole;
  /** Users & roles overlay (web: Person.active). */
  active: boolean;
}

// ── Tickets ──────────────────────────────────────────────────────────────────

export type TicketStatus = 'todo' | 'prog' | 'review' | 'done';
export type TicketType = 'Bug' | 'Task' | 'Story';
export type TicketPrio = 'Critical' | 'Urgent' | 'High' | 'Medium' | 'Low';

export interface Comment {
  who: string;
  t: string;
  when: string;
  att?: string[];
}

export interface Ticket {
  id: number;
  key: string;
  title: string;
  /** project name */
  proj: string;
  epic: string;
  sprint: string;
  type: TicketType;
  st: TicketStatus;
  prio: TicketPrio;
  /** ISO date or '' */
  due: string;
  /** estimate, hours */
  est: number;
  /** logged hours */
  hrs: number;
  /** assignee names */
  as: string[];
  /** [done, total] */
  subs?: [number, number];
  desc: string;
  att: string[];
  comments: Comment[];
  /** raised by the client */
  client?: boolean;
  reporter?: string;
  raised?: string;
}

// ── Projects and companies ───────────────────────────────────────────────────

export type ProjectStatus = 'active' | 'planned' | 'done' | 'maint';

export interface SupportPlan {
  type: 'both' | 'sla' | 'hours';
  hours: number;
  roll: 'expire' | 'roll';
  over: 'bill' | 'ask';
  resp: string;
  fix: string;
  cover: 'Business hours' | '24/7';
  start: string;
  renew: string;
  url: string;
  win: string;
  auto: boolean;
}

export interface Project {
  name: string;
  company: string;
  pct: number;
  status: ProjectStatus;
  /** delivery / go-live date */
  deliv?: string;
  sup?: { until: string; used: number; quota: number };
  /** support plan (prototype MCFG + mcfg overlay); null when none */
  plan: SupportPlan | null;
}

export type PortalPerm = 'Board' | 'Timeline' | 'Questions' | 'Bugs';

export interface Contact {
  name: string;
  role: 'Client admin' | 'Client user';
  email: string;
  portal: Record<PortalPerm, boolean>;
}

export interface Company {
  name: string;
  archived: boolean;
  /** hours logged this month (prototype COH) */
  hoursThisMonth: number;
  contacts: Contact[];
}

export type SprintState = 'done' | 'active' | 'planned';

export interface Sprint {
  /** project */
  p: string;
  /** epic */
  e: string;
  /** sprint name */
  n: string;
  st: SprintState;
  /** start ISO */
  a: string;
  /** end ISO */
  b: string;
}

// ── Maintenance (mobile-only) ────────────────────────────────────────────────

export type SupportPrio = 'Blocking' | 'Annoying' | 'Minor';

export interface SupportRequest {
  id: string;
  t: string;
  type: 'Bug' | 'Change';
  prio: SupportPrio;
  st: TicketStatus;
  /** assignee name, '' when unassigned */
  as: string;
  by: string;
  opened: string;
  sla: string;
  risk: boolean;
  hrs: number;
  /** outside plan (billable) */
  outside: boolean;
}

export interface UpkeepTask {
  id: string;
  title: string;
  due: string;
  who: string;
  done: boolean;
}

export interface Environment {
  label: string;
  url: string;
  health: string;
}

export interface Release {
  v: string;
  date: string;
  text: string;
}

export interface MaintData {
  uptime: string;
  inc: string;
  ver: string;
  dep: string;
  env: Environment[];
  /** [month, hours] */
  hist: [string, number][];
  req: SupportRequest[];
  rel: Release[];
  tasks: UpkeepTask[];
}

export interface MonthlyReport {
  opened: number;
  closed: number;
  sla: string;
  up: string;
  done: string[];
  split: [label: 'Bugs' | 'Changes' | 'Upkeep', hours: number][];
}

// ── Questions, leave, time ───────────────────────────────────────────────────

export interface QMsg {
  side: 'vt' | 'client';
  who: string;
  t: string;
  when: string;
  att?: string[];
}

export interface Question {
  id: number;
  title: string;
  text: string;
  by: string;
  when: string;
  /** ticket key */
  tk: string;
  att: string[];
  msgs: QMsg[];
  solved: boolean;
}

export type LeaveType = 'Leave' | 'Comp-off';
export type LeaveStatus = 'Pending' | 'Approved' | 'Rejected';

export interface Leave {
  id: number;
  who: string;
  type: LeaveType;
  from: string;
  to: string;
  reason: string;
  st: LeaveStatus;
  decidedBy?: string;
  decidedWhen?: string;
}

/** '*' = the demo owner: whoever is signed in sees these as their own entries. */
export const ANY_USER = '*';

export interface TimeEntry {
  id: number | string;
  /** ISO day */
  d: string;
  /** ticket id or null */
  tk: number | null;
  /** project name ('Internal' for admin and meetings) */
  proj?: string;
  /** free-text work description when there is no ticket */
  text: string;
  h: number;
  bill: boolean;
  note: string;
  who: string;
}

// ── DevOps ───────────────────────────────────────────────────────────────────

export interface Deployment {
  v: string;
  note: string;
  st: 'Live' | 'Rolled back';
  day: string;
}

/** [day label, who, text] */
export type LogLine = [day: string, who: string, text: string];

export interface DevopsProject {
  p: string;
  co: string;
  phase: string;
  rem: string;
  /** days until the reminder; < 0 is late */
  remIn: number;
  est: string;
  ci: boolean;
  deps: Deployment[];
  /** newest first */
  log: LogLine[];
}

export interface Reminder {
  n: string;
  /** days after phase start */
  d: number;
}

export type DevopsRuleKey = 'skipWeekends' | 'pauseOnClient' | 'notifyPm';

export interface DevopsSettings {
  seq: Reminder[];
  rules: Record<DevopsRuleKey, boolean>;
  phases: string[];
  statuses: string[];
  /** newest first */
  log: LogLine[];
}

// ── Notifications ────────────────────────────────────────────────────────────

export type NotificationTarget =
  | { kind: 'ticket'; id: number }
  | { kind: 'question'; id: number }
  | { kind: 'project'; name: string }
  | { kind: 'leave' }
  | { kind: 'devops'; project: string };

export interface AppNotification {
  id: string;
  /** lucide icon name */
  icon: string;
  tone: { bg: string; fg: string };
  text: string;
  when: string;
  target: NotificationTarget;
  /** which feed it belongs to */
  feed: 'staff' | 'client';
  /** roles that never see it */
  hideFor?: Role[];
}
