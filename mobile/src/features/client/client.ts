/**
 * Pure helpers of the client portal (S5-CLIENTS, S5-PORTAL, S5-QUESTIONS, S5-BUGS).
 * Unit-tested in __tests__/client.test.ts.
 */
import { TICKET_STATUS } from '@/data/constants';
import { isOpenQuestion } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { ClientBug, Company, Question, TicketStatus } from '@/data/types';
import type { ToneName } from '@/theme';

export const bugStatusLabel = (st: TicketStatus): string => TICKET_STATUS[st].client;
export const bugTone = (st: TicketStatus): ToneName => TICKET_STATUS[st].tone;

export type BugFilter = 'all' | 'mine' | 'done';

/** Bugs segment: All · Reported by me · Fixed. */
export function filterBugs(list: ClientBug[], v: BugFilter, me: string): ClientBug[] {
  return list.filter((b) => v === 'all' || (v === 'mine' ? b.by === me : b.st === 'done'));
}

export type QuestionFilter = 'wait' | 'done';

/** Questions segment: Waiting for you (open) · Answered. */
export function filterQuestions(list: Question[], v: QuestionFilter): Question[] {
  return list.filter((q) => (v === 'wait' ? isOpenQuestion(q) : !!q.answer));
}

export interface ClientSummary {
  company: Company;
  projectNames: string[];
  waiting: number;
  openBugs: number;
  contacts: number;
}

/**
 * Clients list (S5-CLIENTS): non-archived companies that use the portal, i.e. with at
 * least one contact with portal access (projects to see) or an open question or bug
 * (integration decision); with waiting questions, open bugs (by project, A-16) and contacts.
 */
export function clientSummaries(s: AppState): ClientSummary[] {
  return s.companies
    .filter((c) => !c.archived)
    .map((c) => {
      const P = s.projects.filter((p) => p.companyId === c.id);
      const ids = new Set(P.map((p) => p.id));
      return {
        company: c,
        projectNames: P.map((p) => p.name),
        waiting: s.questions.filter((q) => ids.has(q.projectId) && isOpenQuestion(q)).length,
        openBugs: s.bugs.filter((b) => ids.has(b.projectId) && b.st !== 'done').length,
        contacts: c.contacts.length,
        portal: c.contacts.some((x) => x.admin || x.projects.some((id) => ids.has(id))),
      };
    })
    .filter((x) => x.portal || x.waiting > 0 || x.openBugs > 0)
    .map(({ portal: _portal, ...x }) => x);
}
