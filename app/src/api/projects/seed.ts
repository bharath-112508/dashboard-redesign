import type { InternalProject, SupportPlan } from '../types'

/** Fjordline's Driver app is delivered and in Maintenance with this support agreement (v4 design). */
export const DRIVER_APP_SUPPORT: SupportPlan = { until: '2027-08-30', used: 6, quota: 10 }

/**
 * Moves a stored Driver app without a support agreement to Maintenance, as the
 * prototype does on load, so stores saved before the v4 design pick it up.
 * Returns the same array when there is nothing to change.
 */
export const withDriverAppSupport = (companies: unknown): unknown => {
  if (!Array.isArray(companies)) return companies
  let changed = false
  const next = companies.map(c => {
    if (!c || typeof c !== 'object' || !Array.isArray(c.projects)) return c
    const i = c.projects.findIndex((p: { id?: string; sup?: unknown }) => p && p.id === 'fjp' && !p.sup)
    if (i < 0) return c
    changed = true
    return { ...c, projects: c.projects.map((p: object, j: number) => (j === i ? { ...p, state: 'maint', sup: { ...DRIVER_APP_SUPPORT } } : p)) }
  })
  return changed ? next : companies
}

/**
 * Internal projects, from the prototype's Projects seed (INT0). Team ids are
 * directory ids: 1 Rahul, 2 Vivek, 3 Chary, 4 Bhavana P, 5 Sofia.
 */
export const INTERNAL_PROJECTS_SEED: InternalProject[] = [
  {
    id: 'i1', name: 'DevOps board', desc: 'The board that tracks environments, releases and requests for every project.',
    area: 'Platform & tooling', state: 'active', pct: 70, due: '2026-10-31', team: [1, 2],
  },
  {
    id: 'i2', name: 'Viljetech website', desc: 'The public website and marketing pages.',
    area: 'Website & marketing', state: 'planned', pct: 0, start: '2026-11-03', due: '2026-12-15', team: [4, 3, 5],
  },
  {
    id: 'i3', name: 'Shared CI/CD templates', desc: 'Pipeline templates reused by every client project.',
    area: 'Infrastructure', state: 'done', pct: 100, due: '2026-09-20', team: [2],
  },
]
