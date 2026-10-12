import type { Company, CompanyRole, InternalProject, ProjectRef, ProjectState, SupportPlan } from '../api/types'
import { TODAY, diff, short } from '../lib/dates'

export const STATE_LABEL: Record<ProjectState, string> = { planned: 'Planned', active: 'Active', hold: 'On hold', maint: 'Maintenance', done: 'Completed' }

/** Board columns, left to right. */
export const STATE_COLUMNS: readonly ProjectState[] = ['planned', 'active', 'hold', 'maint', 'done']

/** Lists sort active first, then on hold, planned, maintenance and completed. */
const SORT_RANK: Record<ProjectState, number> = { active: 0, hold: 1, planned: 2, maint: 3, done: 4 }

/** Pill colours: text, background and dot. */
export const STATE_TONE: Record<ProjectState, { ink: string; soft: string; dot: string }> = {
  active: { ink: '#1F3FAF', soft: '#DCE5FA', dot: '#4870E8' },
  planned: { ink: '#22354C', soft: '#E7EEFB', dot: '#A9B6C5' },
  hold: { ink: '#7A5C0E', soft: '#FBEDC2', dot: '#C99A2E' },
  maint: { ink: '#1F6F6E', soft: '#DFF1F0', dot: '#3E908F' },
  done: { ink: '#195040', soft: '#D6E9E2', dot: '#3F9079' },
}

export const AREAS = ['Platform & tooling', 'Infrastructure', 'Website & marketing', 'Design system', 'Operations', 'Research'] as const

/** One project on the Projects page, client or internal. */
export interface ProjectItem {
  ref: ProjectRef
  name: string
  desc: string
  state: ProjectState
  pct: number
  start: string
  due: string
  team: number[]
  kind: 'client' | 'internal'
  companyId: string | null
  /** The client company's name, or '' for internal projects. */
  companyName: string
  /** The internal project's area, or '' for client projects. */
  area: string
  epics: number
  /** Support agreement of a client project in Maintenance. */
  sup: SupportPlan | null
}

/**
 * Every project as one list. Projects of archived companies are left out, as
 * the search already does.
 */
export const projectItems = (companies: readonly Company[], internal: readonly InternalProject[]): ProjectItem[] => [
  ...companies
    .filter(c => !c.archived)
    .flatMap(c =>
      c.projects.map<ProjectItem>(p => ({
        ref: { kind: 'client', companyId: c.id, id: p.id },
        name: p.name,
        desc: p.desc,
        state: p.state,
        pct: p.pct,
        start: p.start ?? '',
        due: p.due,
        team: p.team,
        kind: 'client',
        companyId: c.id,
        companyName: c.name,
        area: '',
        epics: p.epics.length,
        sup: p.sup ?? null,
      })),
    ),
  ...internal.map<ProjectItem>(p => ({
    ref: { kind: 'internal', id: p.id },
    name: p.name,
    desc: p.desc,
    state: p.state,
    pct: p.pct,
    start: p.start ?? '',
    due: p.due,
    team: p.team,
    kind: 'internal',
    companyId: null,
    companyName: '',
    area: p.area,
    epics: 0,
    sup: null,
  })),
]

/** The key React uses for a project item. */
export const refKey = (ref: ProjectRef) => (ref.kind === 'client' ? `c:${ref.companyId}:${ref.id}` : `i:${ref.id}`)

/** Ordered by state rank, then by deadline (no deadline last). */
export const sortProjects = <T extends { state: ProjectState; due: string; name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => SORT_RANK[a.state] - SORT_RANK[b.state] || dueSort(a.due) - dueSort(b.due) || a.name.localeCompare(b.name))

const dueSort = (due: string) => (due ? Date.parse(due) : Number.MAX_SAFE_INTEGER)

/** The deadline is past, and the project is not completed or in maintenance. */
export const isOverdue = (p: { due: string; state: ProjectState }) => p.state !== 'done' && p.state !== 'maint' && !!p.due && p.due < TODAY

/** "30 Aug", with the year when it is not this year ("30 Aug 2027"). */
const shortYear = (iso: string) => (iso.slice(0, 4) === TODAY.slice(0, 4) ? short(iso) : `${short(iso)} ${iso.slice(0, 4)}`)

/** "Support until 30 Aug 2027". */
export const supportUntil = (sup: SupportPlan) => `Support until ${shortYear(sup.until)}`

/**
 * Due label and tone: "Support until …" in maintenance, "Completed 20 Sep",
 * "Overdue 3 Oct", "12 Oct · 2d" within 14 days, or the date.
 */
export const dueLabel = (
  due: string,
  state: ProjectState,
  sup?: SupportPlan | null,
): { text: string; tone: 'overdue' | 'soon' | 'normal' | 'none' } => {
  if (state === 'maint' && sup) return { text: supportUntil(sup), tone: 'normal' }
  if (!due) return { text: 'No deadline', tone: 'none' }
  if (isOverdue({ due, state })) return { text: `Overdue ${short(due)}`, tone: 'overdue' }
  if (state === 'done') return { text: `Completed ${short(due)}`, tone: 'normal' }
  const days = diff(due, TODAY)
  if (days >= 0 && days <= 14) return { text: `${short(due)} · ${days}d`, tone: 'soon' }
  return { text: short(due), tone: 'normal' }
}

/** The state a new project gets from its start date: planned when it starts after today, otherwise active. */
export const stateFromStart = (start: string): ProjectState => (start && start > TODAY ? 'planned' : 'active')

/** Company roles and what each one may do (the prototype's ROLES and PERMS). */
export const COMPANY_ROLES: readonly CompanyRole[] = ['Super admin', 'Admin', 'Developer', 'Viewer']

export const ROLE_INFO: Record<CompanyRole, { desc: string; perms: boolean[] }> = {
  'Super admin': { desc: 'Full access to every company, project and setting.', perms: [true, true, true, true, true] },
  Admin: { desc: 'Manages this company and its projects.', perms: [true, true, true, true, false] },
  Developer: { desc: 'Works on tickets in the assigned projects.', perms: [true, false, true, false, false] },
  Viewer: { desc: 'Read-only access to the assigned projects.', perms: [true, false, false, false, false] },
}

export const PERMISSIONS = [
  'See assigned projects and tickets',
  'Create projects and sprints',
  'Edit tickets, log time',
  'Manage contacts and people',
  'Company settings and archiving',
] as const

/** The My timesheet page limited to one project (v5 "Timesheet" button on project cards). */
export const timesheetHref = (projectId: string, name: string) =>
  `/timesheet?project=${encodeURIComponent(projectId)}&name=${encodeURIComponent(name)}`

/** What a project link shows: the project's name and, for a client project, its company. Null when the project is gone. */
export interface LinkedProject {
  ref: ProjectRef
  name: string
  kind: 'client' | 'internal'
  /** The client company's name, or '' for an internal project. */
  companyName: string
  /** The internal project's area, or '' for a client project. */
  area: string
  state: ProjectState
}

/** Looks a project link up, including projects of archived companies. */
export const linkedProject = (
  ref: ProjectRef | null | undefined,
  companies: readonly Company[] | undefined,
  internal: readonly InternalProject[] | undefined,
): LinkedProject | null => {
  if (!ref) return null
  if (ref.kind === 'client') {
    const c = companies?.find(x => x.id === ref.companyId)
    const p = c?.projects.find(x => x.id === ref.id)
    return c && p ? { ref, name: p.name, kind: 'client', companyName: c.name, area: '', state: p.state } : null
  }
  const p = internal?.find(x => x.id === ref.id)
  return p ? { ref, name: p.name, kind: 'internal', companyName: '', area: p.area, state: p.state } : null
}
