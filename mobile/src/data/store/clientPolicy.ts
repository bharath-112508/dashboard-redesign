import { canSeeProject } from '../selectors/projects';
import { isClientRole, me } from '../selectors/session';
import type { Action } from './actions';
import type { AppState } from './state';

/**
 * Client policy (product owner): a client (cadmin, cuser) can only raise bugs and answer
 * the questions sent to them. They may report bugs and problems, reply on their bugs,
 * answer questions, view their projects and portal, and a client admin manages their own
 * team. They may not request changes, raise DevOps requests, start questions, comment on
 * or edit tickets, upload project files or log time.
 *
 * Enforced twice: the commands refuse with `CLIENT_REFUSED` (see `createCommands`), and the
 * reducer ignores any other action dispatched while a client is signed in.
 */
export const CLIENT_REFUSED = 'Client accounts can only report bugs and answer questions.';

/** Commands a client may call; every other command is refused for a client actor. */
export const CLIENT_COMMANDS: ReadonlySet<string> = new Set([
  'signIn',
  'signOut',
  'saveProfile',
  'markTicketRead',
  'createSupportRequest', // "Report a problem" only; a change request is refused inside
  'answerQuestion',
  'reportBug',
  'replyOnBug',
  'setBugStatus', // refuses clients itself ("The team updates the status.")
  'saveClientMember',
  'removeClientMember',
  'resetDemo',
]);

/** Refusal text for a client calling a command outside `CLIENT_COMMANDS`. */
export const clientRefusal = (command: string): string =>
  command === 'saveTimeEntry' || command === 'deleteTimeEntry' ? 'Your role does not log time' : CLIENT_REFUSED;

/** True when the signed-in person is a client. */
export const actorIsClient = (s: AppState): boolean => isClientRole(me(s)?.role);

/**
 * Reducer guard: may the signed-in client apply this action? Staff (and signed-out
 * state) are not limited here.
 */
export function clientActionAllowed(s: AppState, a: Action): boolean {
  const u = me(s);
  if (!u || !isClientRole(u.role)) return true;
  switch (a.type) {
    case 'session/signIn':
    case 'session/signOut':
    case 'demo/reset':
      return true;
    case 'profile/save':
      return a.personId === u.id;
    case 'tickets/create':
      // "Report a problem" on a maintenance project creates a client support ticket
      return !!a.ticket.client && a.ticket.support === 'problem' && canSeeProject(s, a.ticket.projectId);
    case 'questions/answer': {
      const q = s.questions.find((x) => x.id === a.id);
      return !!q && canSeeProject(s, q.projectId);
    }
    case 'bugs/create':
      return canSeeProject(s, a.bug.projectId);
    case 'bugs/reply': {
      const b = s.bugs.find((x) => x.id === a.id);
      return !!b && canSeeProject(s, b.projectId);
    }
    case 'clientTeam/add':
      return u.role === 'cadmin' && a.member.companyId === u.org;
    case 'clientTeam/update':
    case 'clientTeam/remove':
      return u.role === 'cadmin' && s.clientTeam.some((m) => m.id === a.id && m.companyId === u.org);
    default:
      return false;
  }
}
