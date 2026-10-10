import type { Company } from '../api/types'
import { isOverdue } from './projects'

export type CompanyStateLabel = 'Active' | 'New' | 'No active work' | 'Archived'

/**
 * The state shown on a company card (the prototype's coState). Archived is
 * separate. Active if any project is active; New when there are no projects or
 * all are planned; otherwise "No active work".
 */
export const companyState = (c: Company): CompanyStateLabel => {
  if (c.archived) return 'Archived'
  if (c.projects.some(p => p.state === 'active')) return 'Active'
  if (c.projects.every(p => p.state === 'planned')) return 'New'
  return 'No active work'
}

export interface CompanyStats {
  active: number
  projects: number
  overdue: number
  /** Average progress of all projects, or null when there are none. */
  avgPct: number | null
  /** Directory ids of people on any project of the company. */
  people: number[]
}

export const companyStats = (c: Company): CompanyStats => {
  const people = new Set<number>()
  c.projects.forEach(p => p.team.forEach(id => people.add(id)))
  return {
    active: c.projects.filter(p => p.state === 'active').length,
    projects: c.projects.length,
    overdue: c.projects.filter(p => isOverdue(p)).length,
    avgPct: c.projects.length ? Math.round(c.projects.reduce((s, p) => s + p.pct, 0) / c.projects.length) : null,
    people: [...people],
  }
}

/** Filter tabs on the list. "All" leaves archived companies out; they have their own tab. */
export type CompanyFilter = 'all' | 'active' | 'new' | 'archived'

export const matchesFilter = (c: Company, f: CompanyFilter): boolean => {
  const state = companyState(c)
  switch (f) {
    case 'all':
      return !c.archived
    case 'active':
      return state === 'Active'
    case 'new':
      return state === 'New'
    case 'archived':
      return c.archived
  }
}

/** Free-text match on name, industry or country. */
export const matchesQuery = (c: Company, q: string): boolean => {
  const t = q.trim().toLowerCase()
  if (!t) return true
  return [c.name, c.industry, c.country].some(v => v.toLowerCase().includes(t))
}

/** Companies that a person can be added to. Archived companies are hidden from pickers. */
export const selectableCompanies = (companies: readonly Company[]) => companies.filter(c => !c.archived)
