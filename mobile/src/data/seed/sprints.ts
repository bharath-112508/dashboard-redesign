import type { Sprint } from '../types';

/** Sprints (v5 `SPR`). Internal project i1 uses its pseudo-epic id 'i1'. */
export const SPRINTS: Sprint[] = [
  { id: 'm1', epicId: 'mob', name: 'Sprint 1', start: '2026-09-21', end: '2026-10-04', state: 'done' },
  { id: 'm2', epicId: 'mob', name: 'Sprint 2', start: '2026-10-05', end: '2026-10-18', state: 'active' },
  { id: 'm3', epicId: 'mob', name: 'Sprint 3', start: '2026-10-19', end: '2026-11-01', state: 'planned' },
  { id: 'w3', epicId: 'web', name: 'Sprint 3', start: '2026-09-28', end: '2026-10-11', state: 'active' },
  { id: 'w4', epicId: 'web', name: 'Sprint 4', start: '2026-10-12', end: '2026-10-25', state: 'planned' },
  { id: 'n1s', epicId: 'n1', name: 'Sprint 1', start: '2026-10-06', end: '2026-10-19', state: 'active' },
  { id: 'i1s', epicId: 'i1', name: 'Sprint 4', start: '2026-10-05', end: '2026-10-16', state: 'active' },
];
