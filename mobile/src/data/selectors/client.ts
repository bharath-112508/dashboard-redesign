import type { AppState } from '../store/state';
import type { ClientBug, ClientTeamMember, Question } from '../types';
import { projVis } from './projects';
import { isClientRole, me } from './session';

/** Open = no answer and not solved. */
export const isOpenQuestion = (q: Question): boolean => !q.answer && !q.solved;

/**
 * Open questions (`openQs`): every open question for staff; for clients only those on
 * their visible projects (Questions tab badge).
 */
export function openQuestions(s: AppState): Question[] {
  const u = me(s);
  const vis = new Set(projVis(s).map((p) => p.id));
  return s.questions.filter((q) => isOpenQuestion(q) && (!isClientRole(u?.role) || vis.has(q.projectId)));
}

/** Questions on one project. */
export function questionsOf(s: AppState, projectId: string): Question[] {
  return s.questions.filter((q) => q.projectId === projectId);
}

/** Questions on the projects the signed-in person can see. */
export function visibleQuestions(s: AppState): Question[] {
  const vis = new Set(projVis(s).map((p) => p.id));
  return s.questions.filter((q) => vis.has(q.projectId));
}

/** Bugs on the visible projects (A-16: filtered by project, not by company id). */
export function visibleBugs(s: AppState): ClientBug[] {
  const vis = new Set(projVis(s).map((p) => p.id));
  return s.bugs.filter((b) => vis.has(b.projectId));
}

/** Bugs of a company's projects (staff portal view). */
export function bugsOfCompany(s: AppState, companyId: string): ClientBug[] {
  const ids = new Set(s.projects.filter((p) => p.companyId === companyId).map((p) => p.id));
  return s.bugs.filter((b) => ids.has(b.projectId));
}

export function bug(s: AppState, id: string | null | undefined): ClientBug | null {
  return (id && s.bugs.find((b) => b.id === id)) || null;
}

export function question(s: AppState, id: number | string | null | undefined): Question | null {
  return s.questions.find((q) => String(q.id) === String(id)) ?? null;
}

/** A company's client team (cadmin "Your team"). */
export function clientTeamOf(s: AppState, companyId: string): ClientTeamMember[] {
  return s.clientTeam.filter((m) => m.companyId === companyId);
}
