import type { AppState } from '../store/state';
import type { DevopsProject, Leave } from '../types';
import { me } from './session';

/** Pending leave of other people (approvers: staffAll). */
export function pendingApprovals(s: AppState): Leave[] {
  const name = me(s)?.name;
  return s.leaves.filter((l) => l.st === 'Pending' && l.who !== name);
}

/** The signed-in person's leave, newest first. */
export function myLeaves(s: AppState): Leave[] {
  const name = me(s)?.name;
  return s.leaves.filter((l) => l.who === name).sort((a, b) => (a.from < b.from ? 1 : -1));
}

/** DevOps projects whose reminder is due today or late. */
export function remindersDue(s: AppState): DevopsProject[] {
  return s.devops.filter((d) => d.remIn <= 0);
}

/** Next phase name of a DevOps project, or null at the last phase. */
export function nextPhase(s: AppState, d: DevopsProject): string | null {
  const ph = s.devopsSettings.phases;
  return ph[ph.indexOf(d.phase) + 1] ?? null;
}
