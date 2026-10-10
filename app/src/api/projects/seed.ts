import type { InternalProject } from '../types'

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
