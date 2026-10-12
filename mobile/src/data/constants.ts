/**
 * Lookup tables (DELTA D-DATA-26). Colours are tone names or token hex values from the
 * prototype; screens resolve tones with `tones[name]` from '@/theme'.
 */
import type { ToneName } from '@/theme/colors';

import type {
  DevopsSettings,
  FaceKey,
  LeaveKind,
  Page,
  PermKey,
  PermMatrix,
  ProjectState,
  Role,
  TicketPrio,
  TicketStatus,
  TicketType,
} from './types';

// ── Roles ──────────────────────────────────────────────────────────────────

export const ROLES: readonly Role[] = ['super', 'admin', 'pm', 'dev', 'devops', 'cadmin', 'cuser'];

/** `ROLE_L` */
export const ROLE_LABEL: Record<Role, string> = {
  super: 'Super admin',
  admin: 'Admin',
  pm: 'Project manager',
  dev: 'Developer',
  devops: 'DevOps engineer',
  cadmin: 'Client admin',
  cuser: 'Client user',
};

/** Role pill colours `RL` (background / ink). */
export const ROLE_COLOURS: Record<Role, { bg: string; ink: string }> = {
  super: { bg: '#1B2D45', ink: '#FFFFFF' },
  admin: { bg: '#E7EEFB', ink: '#1F3FAF' },
  pm: { bg: '#EEE9FB', ink: '#5B3FB8' },
  dev: { bg: '#DFF1EA', ink: '#195040' },
  devops: { bg: '#E6F0F7', ink: '#1D5A7A' },
  cadmin: { bg: '#FBF1D6', ink: '#7A5C0E' },
  cuser: { bg: '#FBE7E3', ink: '#A5302B' },
};

/** Page access `ACC` (identical to web `session/access.ts`). '*' = every page. */
export const PAGE_ACCESS: Record<Role, '*' | readonly Page[]> = {
  super: '*',
  admin: '*',
  pm: ['Dashboard', 'Companies', 'Projects', 'Tickets', 'Clients', 'Timesheet', 'Employee Timesheets'],
  dev: ['Dashboard', 'Companies', 'Projects', 'Tickets', 'Timesheet'],
  devops: ['Dashboard', 'DevOps Board v6', 'Timesheet'],
  cadmin: ['Dashboard', 'Clients', 'Users'],
  cuser: ['Dashboard', 'Clients'],
};

// ── Permissions ────────────────────────────────────────────────────────────

/** `PERMS`: key and label, in display order. */
export const PERMS: readonly { key: PermKey; label: string }[] = [
  { key: 'tickets.create', label: 'Create tickets' },
  { key: 'tickets.assign', label: 'Assign tickets' },
  { key: 'sprints.manage', label: 'Start and complete sprints' },
  { key: 'time.others', label: "See other people's time" },
  { key: 'leave.approve', label: 'Approve leave and comp-off' },
  { key: 'companies.edit', label: 'Add and edit companies' },
  { key: 'projects.create', label: 'Start projects' },
  { key: 'users.manage', label: 'Add and edit users' },
  { key: 'devops.edit', label: 'Edit the DevOps board' },
];

/** `PDEF`: default matrix. Client roles have no entries. */
export const PDEF: PermMatrix = {
  admin: {
    'tickets.create': true,
    'tickets.assign': true,
    'sprints.manage': true,
    'time.others': true,
    'leave.approve': true,
    'companies.edit': true,
    'projects.create': true,
    'users.manage': true,
    'devops.edit': true,
  },
  pm: {
    'tickets.create': true,
    'tickets.assign': true,
    'sprints.manage': true,
    'time.others': true,
    'companies.edit': true,
    'projects.create': true,
  },
  dev: { 'tickets.create': true },
  devops: { 'devops.edit': true },
  cadmin: {},
  cuser: {},
};

// ── Tickets ────────────────────────────────────────────────────────────────

/** `ST` staff labels and tone; `CST` client labels. */
export const TICKET_STATUS: Record<TicketStatus, { label: string; client: string; tone: ToneName }> = {
  todo: { label: 'To do', client: 'Received', tone: 'grey' },
  prog: { label: 'In progress', client: 'Being fixed', tone: 'blue' },
  review: { label: 'Review', client: 'Testing', tone: 'violet' },
  done: { label: 'Done', client: 'Fixed', tone: 'green' },
};
export const TICKET_STATUSES: readonly TicketStatus[] = ['todo', 'prog', 'review', 'done'];

/** `PRC` priority dot colours (v4 glyphs and "Urgent" are gone). */
export const PRIORITY_DOT: Record<TicketPrio, string> = {
  Critical: '#C0392B',
  High: '#D2724A',
  Medium: '#4870E8',
  Low: '#A9B6C5',
};
export const PRIORITIES: readonly TicketPrio[] = ['Critical', 'High', 'Medium', 'Low'];

/** `PRB` soft priority chips (subtask hero). */
export const PRIORITY_SOFT: Record<TicketPrio, { bg: string; ink: string }> = {
  Critical: { bg: '#FBE7E3', ink: '#8E2A1F' },
  High: { bg: '#F6DDD0', ink: '#7A3818' },
  Medium: { bg: '#E7EEFB', ink: '#1F3FAF' },
  Low: { bg: '#EEF3FB', ink: '#22354C' },
};

/** `TYC` type tag colours. */
export const TYPE_TAG: Record<TicketType, { bg: string; ink: string }> = {
  Bug: { bg: '#FBE7E3', ink: '#8E2A1F' },
  Task: { bg: '#DCE5FA', ink: '#1F3FAF' },
  Story: { bg: '#D6E9E2', ink: '#195040' },
};
export const TICKET_TYPES: readonly TicketType[] = ['Task', 'Story', 'Bug'];

// ── Projects ───────────────────────────────────────────────────────────────

/** `PST` project state label and tone. */
export const PROJECT_STATE: Record<ProjectState, { label: string; tone: ToneName }> = {
  planned: { label: 'Planned', tone: 'grey' },
  active: { label: 'Active', tone: 'blue' },
  maint: { label: 'Maintenance', tone: 'teal' },
  done: { label: 'Completed', tone: 'green' },
  hold: { label: 'On hold', tone: 'amber' },
};

/** Internal project areas. */
export const AREAS = ['Platform & tooling', 'Infrastructure', 'Website & marketing', 'Design system', 'Operations', 'Research'] as const;

export const DEVTYPES = ['Frontend', 'Backend', 'Mobile', 'Full stack', 'DevOps', 'QA'] as const;

export const COUNTRIES = ['Norway', 'Sweden', 'Denmark', 'Finland', 'India', 'United Kingdom'] as const;

export const TIME_ZONES = ['Europe/Oslo', 'Europe/Stockholm', 'Europe/London', 'Asia/Kolkata', 'America/New_York'] as const;

// ── Leave ──────────────────────────────────────────────────────────────────

/** Web `LeaveType` values (DECISIONS 2 / B-3), with display labels. */
export const LEAVE_KINDS: readonly { kind: LeaveKind; label: string }[] = [
  { kind: 'Annual', label: 'Annual leave' },
  { kind: 'Sick', label: 'Sick leave' },
  { kind: 'Holiday', label: 'Public holiday' },
  { kind: 'Personal', label: 'Personal leave' },
];

/** Annual leave days per year (user detail balance). */
export const ANNUAL_LEAVE_DAYS = 25;

// ── People display ─────────────────────────────────────────────────────────

/**
 * Avatar colours for names that are not directory people (DevOps owners Raj and
 * Ganesh, client team members). Directory people use `person.colour`.
 */
export const NAME_COLOURS: Record<string, string> = {
  Ganesh: '#3F9079',
  Raj: '#9F89E5',
};
export const DEFAULT_AVATAR = '#56657A';

/** Staff faces `FACE` (staff viewers only). */
export const FACE_OF: Record<string, FaceKey> = {
  Rahul: 'm0',
  Vivek: 'm1',
  Chary: 'm2',
  'Bhavana P': 'w0',
  Arjun: 'm4',
  Raj: 'm5',
  Ganesh: 'm6',
  Sofia: 'w1',
};

// ── DevOps ─────────────────────────────────────────────────────────────────

/** `INFRA`: the seed statuses. */
export const INFRA = [
  'Not started',
  'Client onboarding',
  'Dev project deployment',
  'Prod product deployment',
  'Deployment Completed',
  'Internally deployment',
  'Adding new services',
] as const;

/** `IST`: status tone. Unknown (user-added) statuses are blue. */
export const DEVOPS_STATUS_TONE: Record<string, ToneName> = {
  'Not started': 'grey',
  'Client onboarding': 'amber',
  'Dev project deployment': 'blue',
  'Prod product deployment': 'violet',
  'Deployment Completed': 'green',
  'Internally deployment': 'teal',
  'Adding new services': 'blue',
};
export const devopsTone = (status: string): ToneName => DEVOPS_STATUS_TONE[status] ?? 'blue';

export type DevopsPhase = 'Planned' | 'In progress' | 'Maintenance' | 'Completed';
/** `PHASES` board groups and their tones. */
export const DEVOPS_PHASES: readonly { phase: DevopsPhase; tone: ToneName }[] = [
  { phase: 'Planned', tone: 'grey' },
  { phase: 'In progress', tone: 'blue' },
  { phase: 'Maintenance', tone: 'teal' },
  { phase: 'Completed', tone: 'green' },
];
/** `phaseOf` */
export function phaseOf(status: string): DevopsPhase {
  if (status === 'Not started') return 'Planned';
  if (status === 'Deployment Completed') return 'Completed';
  if (status === 'Adding new services') return 'Maintenance';
  return 'In progress';
}

/** Client follow-up ladder `LADDER` and hour offsets `OFFS`. */
export const LADDER = ['Waiting for client', 'Reminder 1', 'Reminder 2', 'Reminder 3', 'Inform Marcus', 'Escalate'] as const;
export const OFFS = [0, 48, 72, 120, 144, 168] as const;
/** Internal (dev team) ladder `ILADDER`. */
export const ILADDER = ['Waiting for dev team', 'Follow-up 1', 'Follow-up 2', 'Inform team lead', 'Escalate'] as const;
/** Dev phases `DEVSTEPS` and typical days `DEVDAYS`. */
export const DEVSTEPS = ['Not started', 'Development', 'Testing', 'Client validation', 'Production'] as const;
export const DEVDAYS: Record<string, number> = { Development: 30, Testing: 14, 'Client validation': 10, Production: 0 };

/** DevOps owners and request assignees (A-8). */
export const DEVOPS_PEOPLE = ['Chary', 'Vivek', 'Raj', 'Ganesh', 'Rahul', 'Arjun'] as const;

export const DEVOPS_REQUEST_TYPES = ['Deployment', 'Environment', 'Configuration', 'Security', 'Access', 'Other'] as const;

/** Detail fields `DVF`: key, label, options (null = date field). */
export type DevopsFieldKey = 'infra' | 'prio' | 'from' | 'act' | 'deploy' | 'depType' | 'dev' | 'owner' | 'initDue' | 'latestDue' | 'reminder';
export const DVF: readonly { key: DevopsFieldKey; label: string; options: readonly string[] | null }[] = [
  { key: 'infra', label: 'Status', options: INFRA },
  { key: 'prio', label: 'Priority', options: ['Critical', 'High', 'Medium', 'Low', 'Not set'] },
  { key: 'from', label: 'Action from', options: ['Client', 'Development team', 'DevOps', 'Not set'] },
  { key: 'act', label: 'Action status', options: [...LADDER, 'Not required'] },
  { key: 'deploy', label: 'Deployment status', options: ['Waiting', 'In progress', 'Completed', 'Not set'] },
  { key: 'depType', label: 'Deployment type', options: ['ALSO', 'Client environment', 'Not set'] },
  { key: 'dev', label: 'Dev phase', options: ['Not started', 'Development', 'Testing', 'Client validation', 'Production', 'Not set'] },
  { key: 'owner', label: 'DevOps owner', options: [...DEVOPS_PEOPLE.filter((p) => p !== 'Arjun'), 'Unassigned'] },
  { key: 'initDue', label: 'Initial due date', options: null },
  { key: 'latestDue', label: 'Estimated deployment', options: null },
  { key: 'reminder', label: 'Next reminder', options: null },
];

/** Default DevOps settings (seed). */
export const DEFAULT_DEVOPS_SETTINGS: DevopsSettings = {
  statuses: [...INFRA],
  ladder: LADDER.map((n, i) => ({ n, h: OFFS[i] })),
  iladder: [...ILADDER],
  phases: Object.entries(DEVDAYS).map(([n, d]) => ({ n, d })),
  rules: { requireNote: true, requireReminder: true, lockInitial: true, lockDevDue: true },
  esc: 4,
  people: [...DEVOPS_PEOPLE],
};

/** Reminder time of day appended to DevOps reminder dates. */
export const REMINDER_TIME = '07:00';
