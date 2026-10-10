import type { LeaveType, PermissionGroup, Role } from '../types'

/** Role columns of the Roles & permissions matrix, in the prototype's order. */
export const ROLE_ORDER: Role[] = ['super', 'admin', 'dev', 'devops', 'pm', 'cadmin', 'cuser']

/** Descriptions from the prototype's role seed (ROLES0). */
export const ROLE_BLURB: Record<Role, string> = {
  super: 'Full access to every company, project and setting.',
  admin: 'Manages companies, projects, people and sprints.',
  dev: 'Works on tickets and logs time in assigned projects.',
  devops: 'Runs infra, environments and DevOps requests. Only role that sees the DevOps board.',
  pm: 'Plans epics and sprints, follows up tickets and time in their projects.',
  cadmin: 'Manages their own colleagues and what they see in the portal.',
  cuser: 'Sees their projects, answers questions and reports bugs.',
}

export interface PermissionDef {
  id: string
  group: PermissionGroup
  label: string
  hint: string
}

/**
 * The matrix rows. The first twelve are the prototype's PERMS. `cp.people` and
 * `tk.bug` are used by the client roles' defaults but were not listed in the
 * prototype, so they are added here (see the WP-07 notes).
 */
export const PERMISSIONS: PermissionDef[] = [
  { id: 'ws.users', group: 'Workspace', label: 'Manage users & roles', hint: 'Invite, edit and remove users' },
  { id: 'ws.companies', group: 'Workspace', label: 'Manage companies', hint: 'Create, edit and archive companies' },
  { id: 'ws.settings', group: 'Workspace', label: 'Workspace settings', hint: 'Sequences, rules and integrations' },
  { id: 'cp.people', group: 'Workspace', label: 'Manage client colleagues', hint: 'Add and edit people in their own company' },
  { id: 'pr.create', group: 'Projects', label: 'Create projects', hint: 'Start client or internal projects' },
  { id: 'pr.view', group: 'Projects', label: 'View assigned projects', hint: 'Board, list and timeline' },
  { id: 'pr.plan', group: 'Projects', label: 'Plan epics & sprints', hint: 'Create and edit epics and sprints' },
  { id: 'tk.edit', group: 'Tickets', label: 'Create & edit tickets', hint: 'Status, assignees, dates' },
  { id: 'tk.comment', group: 'Tickets', label: 'Comment', hint: 'On tickets and questions' },
  { id: 'tk.files', group: 'Tickets', label: 'See files', hint: 'Attachments on tickets' },
  { id: 'tk.bug', group: 'Tickets', label: 'Report bugs', hint: 'From the client portal' },
  { id: 'ts.log', group: 'Time & money', label: 'Log time', hint: 'Own timesheet' },
  { id: 'ts.all', group: 'Time & money', label: "See everyone's timesheets", hint: 'Team and company reports' },
  { id: 'ts.export', group: 'Time & money', label: 'Export reports', hint: 'CSV and PDF downloads' },
]

export const PERMISSION_GROUPS: PermissionGroup[] = ['Workspace', 'Projects', 'Tickets', 'Time & money']

const ALL_PERMS = PERMISSIONS.map(p => p.id)

/** The prototype's default permissions per role (DEF). Super admin always holds all of them. */
export const DEFAULT_PERMS: Record<Role, string[]> = {
  super: ALL_PERMS,
  admin: ['ws.companies', 'pr.create', 'pr.view', 'pr.plan', 'tk.edit', 'tk.comment', 'ts.log', 'ts.all', 'ts.export', 'tk.files'],
  pm: ['pr.view', 'pr.plan', 'tk.edit', 'tk.comment', 'ts.log', 'ts.all', 'ts.export', 'tk.files'],
  dev: ['pr.view', 'tk.edit', 'tk.comment', 'ts.log', 'tk.files'],
  devops: ['pr.view', 'tk.edit', 'tk.comment', 'ts.log', 'tk.files'],
  cadmin: ['pr.view', 'tk.comment', 'tk.bug', 'cp.people', 'tk.files', 'ts.export'],
  cuser: ['pr.view', 'tk.comment', 'tk.bug'],
}

export const DEFAULT_DEV_TYPES = ['Frontend', 'Backend', 'Full-stack', 'Mobile', 'DevOps', 'QA', 'Designer']

export const LEAVE_TYPES: LeaveType[] = ['Annual', 'Sick', 'Holiday', 'Personal']

/** Annual leave days a person starts with. Only Annual leave counts against this. */
export const ANNUAL_ALLOWANCE = 25

/** Hours a weekday should be logged for an employee. Freelancers have no required hours. */
export const DAY_HOURS = 8

/** Colours for people added from the Users page (the directory colour palette). */
export const NEW_PERSON_COLOURS = ['#4870E8', '#3E908F', '#B98A2F', '#D2724A', '#3F9079', '#3E6FA8', '#9F89E5']
export const CLIENT_PERSON_COLOUR = '#56657A'

/** Matches the prototype's email check. */
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Only super admins and admins can change people and the permission matrix (DECISIONS 1 and 5). */
export const canEditPeople = (role: Role) => role === 'super' || role === 'admin'

/** Client roles belong to a company; Viljetech roles belong to 'vt'. */
export const CLIENT_ROLES: Role[] = ['cadmin', 'cuser']
export const isClientRoleKey = (role: Role) => CLIENT_ROLES.includes(role)
