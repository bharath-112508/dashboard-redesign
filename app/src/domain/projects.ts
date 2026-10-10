import type { Company, CompanyRole, InternalProject, ProjectRef, ProjectState } from '../api/types'
import { TODAY, diff, short } from '../lib/dates'

export const STATE_LABEL: Record<ProjectState, string> = { planned: 'Planned', active: 'Active', hold: 'On hold', done: 'Done' }

/** Board columns, left to right. */
export const STATE_COLUMNS: readonly ProjectState[] = ['planned', 'active', 'hold', 'done']

/** Lists sort active first, then on hold, planned and done. */
const SORT_RANK: Record<ProjectState, number> = { active: 0, hold: 1, planned: 2, done: 3 }

/** Pill colours: text, background and dot. */
export const STATE_TONE: Record<ProjectState, { ink: string; soft: string; dot: string }> = {
  active: { ink: '#1F3FAF', soft: '#DCE5FA', dot: '#4870E8' },
  planned: { ink: '#22354C', soft: '#E7EEFB', dot: '#A9B6C5' },
  hold: { ink: '#7A5C0E', soft: '#FBEDC2', dot: '#C99A2E' },
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
  })),
]

/** The key React uses for a project item. */
export const refKey = (ref: ProjectRef) => (ref.kind === 'client' ? `c:${ref.companyId}:${ref.id}` : `i:${ref.id}`)

/** Ordered by state rank, then by deadline (no deadline last). */
export const sortProjects = <T extends { state: ProjectState; due: string; name: string }>(items: readonly T[]): T[] =>
  [...items].sort((a, b) => SORT_RANK[a.state] - SORT_RANK[b.state] || dueSort(a.due) - dueSort(b.due) || a.name.localeCompare(b.name))

const dueSort = (due: string) => (due ? Date.parse(due) : Number.MAX_SAFE_INTEGER)

/** The deadline is past, and the project is not done. */
export const isOverdue = (p: { due: string; state: ProjectState }) => p.state !== 'done' && !!p.due && p.due < TODAY

/** Due label and tone: "Overdue 3 Oct", "12 Oct · 2d" within 14 days, or the date. */
export const dueLabel = (due: string, state: ProjectState): { text: string; tone: 'overdue' | 'soon' | 'normal' | 'none' } => {
  if (!due) return { text: 'No deadline', tone: 'none' }
  if (isOverdue({ due, state })) return { text: `Overdue ${short(due)}`, tone: 'overdue' }
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
