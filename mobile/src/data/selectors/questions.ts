import type { AppState } from '../store/state';
import type { Question } from '../types';

export interface QuestionStatus {
  label: string;
  soft: string;
  ink: string;
  dot: string;
  /** trailing Viljetech messages waiting for the client (0 when nothing waits) */
  waiting: number;
  /** needs the client: red ring and the Questions tab badge */
  needsClient: boolean;
}

/** Question status (prototype qStat, SPEC S-QUESTIONS). */
export function questionStatus(q: Question): QuestionStatus {
  if (q.solved) return { label: 'Solved', soft: '#D6E9E2', ink: '#195040', dot: '#3F9079', waiting: 0, needsClient: false };
  let n = 0;
  for (let i = q.msgs.length - 1; i >= 0 && q.msgs[i].side === 'vt'; i--) n++;
  const clientReplied = q.msgs.some((m) => m.side === 'client');
  if (n && !clientReplied) {
    return { label: 'Needs your answer', soft: '#FBE7E3', ink: '#8E2A1F', dot: '#C0392B', waiting: n, needsClient: true };
  }
  if (n) {
    return { label: `${n} new repl${n > 1 ? 'ies' : 'y'}`, soft: '#DCE5FA', ink: '#1F3FAF', dot: '#4870E8', waiting: n, needsClient: true };
  }
  return { label: 'Waiting for Viljetech', soft: '#FBEDC2', ink: '#7A5C0E', dot: '#B98A2F', waiting: 0, needsClient: false };
}

/** Questions that need the client (Home KPI, Questions tab badge, More tile). */
export function questionsNeedingClient(s: AppState): Question[] {
  return s.questions.filter((q) => questionStatus(q).needsClient);
}

export function questionById(s: AppState, id: number): Question | undefined {
  return s.questions.find((q) => q.id === id);
}
