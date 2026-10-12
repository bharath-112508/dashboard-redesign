import { TICKET_STATUS } from '@/data/constants';
import { sh } from '@/data/format';
import { CLIENT_COMPANY } from '@/data/seed/projects';
import { myTickets } from '@/data/selectors';
import type { AppState } from '@/data/store/state';
import type { Ticket } from '@/data/types';
import type { Tone } from '@/theme';

export interface BugCardVM {
  id: number;
  key: string;
  title: string;
  /** client status label (Received, Being fixed, Testing, Fixed) */
  status: string;
  tone: Tone;
  raised: string;
  /** last comment "who: text", or the description */
  last: string;
}

/**
 * S-BUGS: the client's bugs and change requests, open ones first, most recently created
 * first within each group (the prototype's order: PMT-35 above PMT-34; a new report on top).
 */
export function clientBugs(s: AppState): BugCardVM[] {
  const bugs = myTickets(s)
    .filter((t) => t.client)
    .sort((a, b) => b.id - a.id);
  const open = bugs.filter((t) => t.st !== 'done');
  const done = bugs.filter((t) => t.st === 'done');
  return [...open, ...done].map(bugCard);
}

function bugCard(t: Ticket): BugCardVM {
  const st = TICKET_STATUS[t.st];
  const lc = t.comments[t.comments.length - 1];
  return {
    id: t.id,
    key: t.key,
    title: t.title,
    status: st.client,
    tone: { dot: st.dot, soft: st.soft, ink: st.ink },
    raised: t.raised ? sh(t.raised) : '',
    last: lc ? `${lc.who}: ${lc.t}` : t.desc,
  };
}

/** S-BUG: projects a client can report on (the client company's active or maintenance projects). */
export function reportProjectOptions(s: AppState): string[] {
  return s.projects
    .filter((p) => p.company === CLIENT_COMPANY && (p.status === 'active' || p.status === 'maint'))
    .map((p) => p.name);
}
