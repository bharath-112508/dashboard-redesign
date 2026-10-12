import { TODAY } from '../clock';
import { hm, sh } from '../format';
import { DEMO_PASSWORD } from '../seed/people';
import { notificationsFor } from '../selectors/notifications';
import { findPersonByEmail, me } from '../selectors/session';
import type {
  DevopsRuleKey,
  LeaveStatus,
  LeaveType,
  LogLine,
  PortalPerm,
  ProjectStatus,
  StaffRole,
  SupportPlan,
  Ticket,
  TicketStatus,
} from '../types';
import type { Action } from './actions';
import type { AppState, UiPrefs } from './state';

export type SignInResult = { ok: true; user: string } | { ok: false; field: 'email' | 'password'; message: string };

export interface LogTimeInput {
  /** ISO day, defaults to TODAY */
  day?: string;
  ticketId?: number | null;
  /** project name, or 'Internal' */
  project: string;
  /** what was worked on when there is no ticket */
  text?: string;
  hours: number;
  bill: boolean;
  note?: string;
}

export interface ClientTicketInput {
  project: string;
  kind: 'Bug' | 'Change';
  title: string;
  desc: string;
  att?: string[];
}

export interface LeaveInput {
  type: LeaveType;
  from: string;
  to: string;
  reason: string;
}

/**
 * Commands: the API screens use to change state (via `useActions()`). Each command
 * reads the current state, resolves ids / keys / the acting person, and dispatches
 * one named action. They return what the caller needs for its toast.
 * Validation of form fields stays in the sheets (exact copy in SPEC.md); commands only
 * guard against impossible input.
 */
export function createCommands(get: () => AppState, dispatch: (a: Action) => void) {
  const meName = () => me(get())?.name ?? '';
  const line = (text: string): LogLine => [sh(TODAY), meName(), text];

  return {
    // ── Session ──
    /** M-01: email + password (DECISIONS.md 5). */
    signIn(email: string, password: string): SignInResult {
      if (!email.trim()) return { ok: false, field: 'email', message: 'Enter your email.' };
      const person = findPersonByEmail(get(), email);
      if (!person || !person.role) return { ok: false, field: 'email', message: 'We don’t recognise that email.' };
      if (password !== DEMO_PASSWORD) return { ok: false, field: 'password', message: 'That password is not right.' };
      if (!person.active) {
        return { ok: false, field: 'email', message: 'This account is deactivated. Ask an admin to reactivate it.' };
      }
      dispatch({ type: 'session/setEmailDraft', email: email.trim() });
      dispatch({ type: 'session/signIn', user: person.name });
      return { ok: true, user: person.name };
    },
    /** M-02: tap a sample account row (no password, as in the prototype). */
    signInAs(name: string): void {
      dispatch({ type: 'session/signIn', user: name });
    },
    /** M-04 */
    signOut(): void {
      dispatch({ type: 'session/signOut' });
    },
    /** M-03: back to Sign in, keeping the email draft. */
    switchAccount(): void {
      dispatch({ type: 'session/switchAccount' });
    },
    setEmailDraft(email: string): void {
      dispatch({ type: 'session/setEmailDraft', email });
    },

    // ── Notifications and profile ──
    markRead(id: string): void {
      dispatch({ type: 'notifications/markRead', id });
    },
    /** M-07: marks every notification in the signed-in person's feed. */
    markAllRead(): void {
      const s = get();
      const person = me(s);
      if (!person?.role) return;
      dispatch({ type: 'notifications/markAllRead', ids: notificationsFor(person.role).map((n) => n.id) });
    },
    /** M-09 */
    setPush(on: boolean): void {
      dispatch({ type: 'profile/setPush', on });
    },

    // ── Tickets ──
    /** M-12. Returns the toast text. */
    setTicketStatus(id: number, st: TicketStatus): string | null {
      const t = get().tickets.find((x) => x.id === id);
      if (!t || t.st === st) return null;
      dispatch({ type: 'tickets/setStatus', id, st });
      const label = { todo: 'To do', prog: 'In progress', review: 'Review', done: 'Done' }[st];
      return `${t.key} moved to ${label}`;
    },
    /** M-13: text and/or attachments; "Sent a photo" when there is no text. */
    addTicketComment(id: number, text: string, att: string[] = []): boolean {
      if (!text.trim() && !att.length) return false;
      dispatch({
        type: 'tickets/addComment',
        id,
        comment: { who: meName(), t: text.trim() || 'Sent a photo', when: 'just now', att },
      });
      return true;
    },
    /** M-20 */
    setTicketDesc(id: number, desc: string): void {
      dispatch({ type: 'tickets/setDesc', id, desc });
    },
    /** M-21 / M-22. Returns the new ticket (its key is for the toast "PMT-36 sent to Viljetech"). */
    createClientTicket(input: ClientTicketInput): Ticket {
      const s = get();
      const id = Math.max(0, ...s.tickets.map((t) => t.id)) + 1;
      const key = `PMT-${36 + s.tickets.filter((t) => t.client).length - 2}`;
      const epic = s.tickets.find((t) => t.proj === input.project)?.epic ?? 'General';
      const ticket: Ticket = {
        id, key, title: input.title.trim(), proj: input.project, epic, sprint: 'Backlog',
        type: input.kind === 'Change' ? 'Task' : 'Bug', st: 'todo', prio: 'Medium', due: '', est: 0, hrs: 0, as: [],
        client: true, reporter: meName(), raised: TODAY, desc: input.desc.trim(), att: input.att ?? [], comments: [],
      };
      dispatch({ type: 'tickets/create', ticket });
      return ticket;
    },

    // ── Time ──
    /** M-14…M-16, M-34. Also adds the hours to the ticket. Returns the toast text. */
    addTimeEntry(input: LogTimeInput): string {
      const s = get();
      const tk = input.ticketId ?? null;
      dispatch({
        type: 'time/addEntry',
        entry: {
          id: s.nextId, d: input.day ?? TODAY, tk, proj: input.project, text: (input.text ?? '').trim(),
          h: input.hours, bill: input.bill, note: (input.note ?? '').trim(), who: meName(),
        },
      });
      const t = tk == null ? null : s.tickets.find((x) => x.id === tk);
      return `Logged ${hm(input.hours)}${t ? ` on ${t.key}` : ''}`;
    },

    // ── Questions ──
    /** M-23: the side follows the signed-in role. */
    addQuestionMessage(id: number, text: string, att: string[] = []): boolean {
      if (!text.trim() && !att.length) return false;
      const person = me(get());
      dispatch({
        type: 'questions/addMessage',
        id,
        msg: { side: person?.role === 'client' ? 'client' : 'vt', who: meName(), t: text.trim() || 'Sent a photo', when: 'just now', att },
      });
      return true;
    },

    // ── Leave ──
    /** M-35 */
    addLeave(input: LeaveInput): void {
      dispatch({ type: 'leave/add', leave: { id: get().nextId, who: meName(), ...input, reason: input.reason.trim() } });
    },
    /** M-36. Returns the toast text. */
    decideLeave(id: number, st: Exclude<LeaveStatus, 'Pending'>): string {
      dispatch({ type: 'leave/decide', id, st, by: meName(), when: TODAY });
      return st === 'Approved' ? 'Request approved' : 'Request rejected';
    },

    // ── Projects and maintenance ──
    /** M-28. Returns the toast text. Picking Maintenance without a plan is the sheet's job (M-29). */
    setProjectStatus(project: string, status: ProjectStatus): string {
      dispatch({ type: 'projects/setStatus', project, status });
      const label = { active: 'In progress', planned: 'Planned', maint: 'Maintenance', done: 'Completed' }[status];
      return `${project} marked ${label}`;
    },
    /** M-29: saves the plan, moves the project to maintenance and opens Support. Returns the toast. */
    savePlan(project: string, plan: SupportPlan): string {
      const isNew = !get().projects.find((p) => p.name === project)?.plan;
      dispatch({ type: 'projects/savePlan', project, plan });
      return isNew ? `${project} is now in maintenance` : 'Support plan saved';
    },
    /** M-30 */
    toggleRequestBilling(project: string, requestId: string): void {
      dispatch({ type: 'maintenance/toggleBilling', project, requestId });
    },
    /** M-31: assigns the signed-in person (DECISIONS.md 5). Returns the toast. */
    assignRequest(project: string, requestId: string): string {
      const who = meName();
      dispatch({ type: 'maintenance/assign', project, requestId, who });
      return `${requestId} assigned to ${who}`;
    },
    /** M-32 */
    toggleUpkeepTask(project: string, taskId: string): void {
      dispatch({ type: 'maintenance/toggleTask', project, taskId });
    },

    // ── DevOps ──
    /** M-37. Returns the toast "{p} → {next}", or null at the last phase. */
    advanceDevopsPhase(project: string): string | null {
      const s = get();
      const d = s.devops.find((x) => x.p === project);
      if (!d) return null;
      const phases = s.devopsSettings.phases;
      const next = phases[phases.indexOf(d.phase) + 1];
      if (!next) return null;
      dispatch({ type: 'devops/advancePhase', project, next, line: line(`Moved from ${d.phase} to ${next}.`) });
      return `${project} → ${next}`;
    },
    /** M-38: ± days on a reminder (not the first; minimum 1). */
    adjustReminder(index: number, delta: 1 | -1): void {
      const r = get().devopsSettings.seq[index];
      if (!r || index === 0 || r.d + delta < 1) return;
      dispatch({ type: 'devops/adjustReminder', index, delta, line: line(`${r.n} set to +${r.d + delta} days`) });
    },
    addReminder(): void {
      const seq = get().devopsSettings.seq;
      const n = `Reminder ${seq.length + 1}`;
      const d = (seq[seq.length - 1]?.d ?? 0) + 7;
      dispatch({ type: 'devops/addReminder', line: line(`Added ${n} at +${d} days`) });
    },
    toggleRule(rule: DevopsRuleKey, label: string): void {
      const on = get().devopsSettings.rules[rule];
      dispatch({ type: 'devops/toggleRule', rule, line: line(`${label}${on ? ' off' : ' on'}`) });
    },
    movePhaseUp(index: number): void {
      const p = get().devopsSettings.phases[index];
      if (!p || index === 0) return;
      dispatch({ type: 'devops/movePhaseUp', index, line: line(`Moved ${p} up`) });
    },
    addPhase(name: string): boolean {
      const v = name.trim();
      if (!v) return false;
      dispatch({ type: 'devops/addPhase', name: v, line: line(`Added phase ${v}`) });
      return true;
    },

    // ── Companies and users ──
    /** M-40 */
    setPortalPerm(company: string, contact: string, perm: PortalPerm, on: boolean): void {
      dispatch({ type: 'companies/setPortalPerm', company, contact, perm, on });
    },
    /** M-40. Returns the toast. */
    toggleCompanyArchived(company: string): string {
      const was = get().companies.find((c) => c.name === company)?.archived;
      dispatch({ type: 'companies/toggleArchived', company });
      return was ? 'Company restored' : 'Company archived';
    },
    /** M-41. Changes the Users & roles label (not the demo account's sign-in role). */
    setUserRole(name: string, role: StaffRole): string {
      dispatch({ type: 'users/setRole', name, role });
      return `${name} is now ${role}`;
    },
    /** M-41. Returns the toast. */
    toggleUserActive(name: string): string {
      const was = get().people.find((p) => p.name === name)?.active;
      dispatch({ type: 'users/toggleActive', name });
      return was ? 'Account deactivated' : 'Account reactivated';
    },

    // ── UI ──
    setUi(patch: Partial<UiPrefs>): void {
      dispatch({ type: 'ui/set', patch });
    },
    /** Remember the selected view of one project (DECISIONS.md 5). */
    setProjectView(project: string, view: UiPrefs['projectView'][string]): void {
      dispatch({ type: 'ui/set', patch: { projectView: { ...get().ui.projectView, [project]: view } } });
    },

    // ── Demo ──
    /** Restore all mock data to the seed (keeps the session). */
    resetDemoData(): void {
      dispatch({ type: 'demo/reset' });
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;
