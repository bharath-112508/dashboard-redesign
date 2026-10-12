/**
 * UI lookup tables (DATA.md §2). Colours come from the theme; these tables only bind
 * domain values to labels, tones and icon names.
 */
import type { Tone } from '@/theme/colors';
import type { IconName } from '@/components/icons';
import type {
  LeaveStatus,
  ProjectStatus,
  Role,
  SprintState,
  StaffRole,
  SupportPrio,
  TicketPrio,
  TicketStatus,
  TicketType,
} from './types';

export const STAFF_ALL: readonly Role[] = ['pm', 'admin', 'super'];
export const IC_STAFF: readonly Role[] = ['dev', 'free', 'devops'];

/** Ticket status: staff label, client label and tone (ST + CST). */
export const TICKET_STATUS: Record<TicketStatus, { label: string; client: string; short: string } & Tone> = {
  todo: { label: 'To do', client: 'Received', short: 'To do', dot: '#A9B6C5', soft: '#E7EEFB', ink: '#22354C' },
  prog: { label: 'In progress', client: 'Being fixed', short: 'Doing', dot: '#4870E8', soft: '#DCE5FA', ink: '#1F3FAF' },
  review: { label: 'Review', client: 'Testing', short: 'Review', dot: '#9F89E5', soft: '#E6DFFA', ink: '#3F2E94' },
  done: { label: 'Done', client: 'Fixed', short: 'Done', dot: '#3F9079', soft: '#D6E9E2', ink: '#195040' },
};

export const TICKET_STATUS_ORDER: readonly TicketStatus[] = ['todo', 'prog', 'review', 'done'];

/** Ticket type tile (TY). */
export const TICKET_TYPE: Record<TicketType, { soft: string; ink: string; icon: IconName }> = {
  Bug: { soft: '#F6DDD0', ink: '#7A3818', icon: 'bug' },
  Task: { soft: '#DCE5FA', ink: '#1F3FAF', icon: 'square-check-big' },
  Story: { soft: '#D6E9E2', ink: '#195040', icon: 'bookmark' },
};

/** Priority glyphs (PR). Critical uses the red badge instead. */
export const PRIORITY: Record<Exclude<TicketPrio, 'Critical'>, { color: string; icon: IconName }> = {
  Urgent: { color: '#D2724A', icon: 'chevrons-up' },
  High: { color: '#B98A2F', icon: 'chevron-up' },
  Medium: { color: '#4870E8', icon: 'equal' },
  Low: { color: '#A9B6C5', icon: 'chevron-down' },
};

/** Support request status (STP). */
export const SUPPORT_STATUS: Record<TicketStatus, { label: string; soft: string; ink: string }> = {
  todo: { label: 'Received', soft: '#E7EEFB', ink: '#22354C' },
  prog: { label: 'Being fixed', soft: '#DCE5FA', ink: '#1F3FAF' },
  review: { label: 'Testing', soft: '#E6DFFA', ink: '#3F2E94' },
  done: { label: 'Fixed', soft: '#D6E9E2', ink: '#195040' },
};

/** Support priority (PRC). */
export const SUPPORT_PRIO: Record<SupportPrio, { soft: string; ink: string }> = {
  Blocking: { soft: '#FBE7E3', ink: '#8E2A1F' },
  Annoying: { soft: '#FBEDC2', ink: '#7A5C0E' },
  Minor: { soft: '#EEF2F6', ink: '#33445A' },
};

/** Project status pills (PS). */
export const PROJECT_STATUS: Record<ProjectStatus, { label: string } & Tone> = {
  active: { label: 'In progress', soft: '#DCE5FA', ink: '#1F3FAF', dot: '#4870E8' },
  done: { label: 'Completed', soft: '#D6E9E2', ink: '#195040', dot: '#3F9079' },
  planned: { label: 'Planned', soft: '#E7EEFB', ink: '#22354C', dot: '#A9B6C5' },
  maint: { label: 'Maintenance', soft: '#DFF1F0', ink: '#1F6F6E', dot: '#3E908F' },
};

/** Project status sheet rows (S-PSS), in display order. */
export const PROJECT_STATUS_OPTIONS: readonly { key: ProjectStatus; label: string; desc: string; icon: IconName }[] = [
  { key: 'planned', label: 'Planned', desc: 'Not started yet', icon: 'calendar-clock' },
  { key: 'active', label: 'In progress', desc: 'Building: sprints, epics and tickets', icon: 'hammer' },
  { key: 'maint', label: 'Maintenance', desc: 'Live. Support plan, requests and upkeep', icon: 'wrench' },
  { key: 'done', label: 'Completed', desc: 'Handed over. No support plan', icon: 'circle-check' },
];

/** Sprint state (SS). */
export const SPRINT_STATE: Record<SprintState, { label: string } & Tone> = {
  active: { label: 'Active', soft: '#DCE5FA', ink: '#1F3FAF', dot: '#4870E8' },
  done: { label: 'Done', soft: '#D6E9E2', ink: '#195040', dot: '#3F9079' },
  planned: { label: 'Planned', soft: '#E7EEFB', ink: '#22354C', dot: '#A9B6C5' },
};

/** Leave status (LS). */
export const LEAVE_STATUS: Record<LeaveStatus, Tone> = {
  Approved: { soft: '#D6E9E2', ink: '#195040', dot: '#3F9079' },
  Pending: { soft: '#FBEDC2', ink: '#7A5C0E', dot: '#B98A2F' },
  Rejected: { soft: '#FBE7E3', ink: '#8E2A1F', dot: '#C0392B' },
};

/** DevOps phase colours (PHC), keyed by phase name; unknown phases use the fallback. */
export const PHASE_TONE: Record<string, Tone> = {
  'Client onboarding': { soft: '#E7EEFB', ink: '#22354C', dot: '#A9B6C5' },
  'Client first tenant setup': { soft: '#E6DFFA', ink: '#3F2E94', dot: '#9F89E5' },
  'First project deployment': { soft: '#DCE5FA', ink: '#1F3FAF', dot: '#4870E8' },
  'CI/CD setup': { soft: '#D6E9E2', ink: '#195040', dot: '#3F9079' },
  Live: { soft: '#D6E9E2', ink: '#195040', dot: '#2F7F68' },
};
export const PHASE_TONE_FALLBACK: Tone = { soft: '#E7EEFB', ink: '#22354C', dot: '#A9B6C5' };

/** KPI icon map (KIC). */
export const KPI_ICON: Record<string, IconName> = {
  'Open tickets': 'ticket',
  'My open tickets': 'ticket',
  Critical: 'siren',
  'Critical open': 'siren',
  Overdue: 'alarm-clock',
  'Overdue tickets': 'alarm-clock',
  'Logged this week': 'timer',
  'Active projects': 'folder-kanban',
  Approvals: 'calendar-check',
  'Questions for you': 'message-circle-question',
  'Open bugs': 'bug',
  'Daco platform': 'chart-pie',
  'Next milestone': 'flag',
  'Projects in setup': 'server-cog',
  'Reminders due': 'bell-ring',
  'CI/CD live': 'git-branch',
};

/** Staff roles shown on Users & roles, in order, with their access text (S-USER). */
export const STAFF_ROLES: readonly StaffRole[] = [
  'Super admin',
  'Admin',
  'Project manager',
  'Developer',
  'DevOps engineer',
  'Freelancer',
];

export const ROLE_ACCESS: Record<StaffRole, string> = {
  'Super admin': 'Everything, including budget and users',
  Admin: 'All projects, users and settings',
  'Project manager': 'Projects, tickets, team hours, approvals',
  Developer: 'Assigned projects, own tickets and time',
  'DevOps engineer': 'DevOps board, infra tickets, own time',
  Freelancer: 'Assigned tickets and own time, no hour target',
};

/** Support plan choices (S-PLAN). */
export const PLAN_TYPES = [
  ['both', 'Hours + SLA'],
  ['sla', 'SLA only'],
  ['hours', 'Hours only'],
] as const;
export const PLAN_TYPE_LABEL = { both: 'Support hours + SLA', sla: 'SLA only', hours: 'Support hours only' } as const;
export const PLAN_RESPONSE = ['1 hour', '4 business hours', '1 business day'] as const;
export const PLAN_FIX = ['1 business day', '2 business days', '5 business days'] as const;
export const PLAN_COVER = ['Business hours', '24/7'] as const;

/** Minutes options on the Log time sheet. */
export const LOG_MINUTES = [0, 5, 10, 15, 30, 45] as const;

/** Bucket of time that is not on a client project. */
export const INTERNAL_PROJECT = 'Internal';
export const INTERNAL_LABEL = 'Internal · Admin & meetings';
