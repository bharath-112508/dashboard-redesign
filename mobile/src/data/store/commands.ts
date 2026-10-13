import { DEMO_PASSWORD, TODAY } from '../clock';
import { DVF, LADDER, PROJECT_STATE, REMINDER_TIME, ROLE_LABEL } from '../constants';
import { addD, diff, dvDate, hashPw, hm } from '../format';
import { canDv, canEditDevopsSettings, canEditPermissions, myCan, myPerm } from '../selectors/access';
import { company, epicsOf, project, sprint, ticketsOf } from '../selectors/projects';
import { devopsByKey, nextDevopsKey } from '../selectors/devops';
import { isClientRole, me, personByEmail } from '../selectors/session';
import { nextTicketKey, subKey, subOf, ticket, tkOrSub } from '../selectors/tickets';
import { tilePalette } from '@/theme/colors';
import type {
  ClientBug,
  Company,
  CompanyContact,
  DevopsLog,
  DevopsProject,
  DevopsRule,
  FileRef,
  LeaveKind,
  MatrixRole,
  NotifPrefs,
  PermKey,
  Person,
  Project,
  ProjectKind,
  ProjectState,
  Role,
  Subtask,
  Ticket,
  TicketPrio,
  TicketStatus,
  TicketType,
  TimeEntry,
} from '../types';
import type { Action, DevopsPatch, DevopsSettingsList, SubtaskPatch, TicketPatch } from './actions';
import type { AppState } from './state';

// ── Results ────────────────────────────────────────────────────────────────

/**
 * Every command returns a Result. `toast` is the exact SPEC copy to show (may be ''
 * when the flow has no toast). A failure carries the message to show and, for form
 * validation, the field it belongs to.
 */
export type Ok<T = unknown> = { ok: true; toast: string } & (T extends object ? T : unknown);
export interface Fail {
  ok: false;
  error: string;
  field?: string;
}
export type Result<T = unknown> = Ok<T> | Fail;

const ok = <T extends object>(toast: string, extra?: T): Ok<T> => ({ ok: true, toast, ...(extra ?? {}) }) as Ok<T>;
const fail = (error: string, field?: string): Fail => ({ ok: false, error, field });
const REQUIRED = 'Required';
const blank = (v: unknown) => !String(v ?? '').trim();

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface ProfileInput {
  name: string;
  phone?: string;
  tz?: string;
  notif?: NotifPrefs;
  password?: string;
  repeat?: string;
}

export interface LogInput {
  /** edit mode: the entry being replaced */
  id?: number;
  /** ISO day, default TODAY */
  date?: string;
  /** 'c:<id>' | 'i:<id>' | 'x:admin' | '' */
  proj: string;
  /** "Log against": ticket or text (x:admin is always text) */
  mode: 'ticket' | 'text';
  /** ticket key, subtask id or positional subtask key */
  key?: string;
  text?: string;
  h?: number | string;
  m?: number | string;
  bill: boolean;
  note?: string;
}

export interface TicketInput {
  projectId: string;
  title: string;
  type?: TicketType;
  epicId?: string;
  sprintId?: string | null;
  prio?: TicketPrio;
  as?: string[];
  due?: string;
  est?: number | string;
  desc?: string;
}

export interface ProjectInput {
  kind: ProjectKind;
  companyId?: string;
  area?: string;
  name: string;
  desc?: string;
  start?: string;
  due?: string;
  team?: string[];
}

export interface UserInput {
  id?: number;
  name: string;
  email: string;
  role: Role;
  devType?: string;
  emp?: 'employee' | 'freelancer';
  projects?: 'all' | string[];
  active?: boolean;
  /** company id for client roles (default: the signed-in client's company, else daco) */
  org?: string;
}

export interface CompanyInput {
  name: string;
  logo?: string;
  industry?: string;
  country?: string;
  web?: string;
  notes?: string;
  /** add only: main contact name and email (become a portal admin contact) */
  contact?: string;
  contactEmail?: string;
}

export interface FollowUpInput {
  /** Follow-up / Call / Email / Meeting */
  type?: string;
  note?: string;
  /** ISO day of the next reminder */
  reminder?: string;
  /** client ladder: move to the next step (default true) */
  advance?: boolean;
  /** internal: next step name */
  nextName?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Ticket key prefix for a new project: initials or the first 3 letters, unique. */
function prefixFor(s: AppState, name: string): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3) : (words[0] ?? 'TK').slice(0, 3);
  if (base.length < 2) base = `${base}TK`.slice(0, 3);
  const used = new Set(s.projects.map((p) => p.keyPrefix));
  let out = base;
  for (let i = 2; used.has(out); i++) out = `${base}${i}`;
  return out;
}

/**
 * Commands: the API screens use to change state (via `useActions()`). Each command reads
 * the current state, resolves ids, keys, dates and the acting person, validates
 * impossible input, dispatches one named action and returns its toast text.
 */
export function createCommands(get: () => AppState, dispatch: (a: Action) => void) {
  const meName = () => me(get())?.name ?? '';
  const log = (text: string): DevopsLog => ({ by: meName(), when: 'Just now', text });
  const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
  const nextNum = () => get().nextId;
  const dvGuard = (key: string): Fail | DevopsProject => {
    const s = get();
    if (!canDv(s)) return fail("You can't edit the DevOps board");
    const d = s.devops.find((x) => x.key === key);
    return d ?? fail('DevOps project not found');
  };

  return {
    // ── Session and profile (V-01…V-04) ─────────────────────────────────────

    /** V-01: email + password (DECISIONS 7). */
    signIn(email: string, password: string): Result<{ personId: number }> {
      if (blank(email)) return fail('Enter your email.', 'email');
      const p = personByEmail(get(), email);
      if (!p) return fail("We don't recognise that email.", 'email');
      const good = p.pwHash ? hashPw(password) === p.pwHash || password === DEMO_PASSWORD : password === DEMO_PASSWORD;
      if (!good) return fail('That password is not right.', 'password');
      if (!p.active) return fail('This account is deactivated. Ask an admin to reactivate it.', 'email');
      dispatch({ type: 'session/signIn', personId: p.id });
      return ok('', { personId: p.id });
    },

    /** V-03 */
    signOut(): void {
      dispatch({ type: 'session/signOut' });
    },

    /** V-04: writes the directory person (A-17) and a demo password hash. */
    saveProfile(input: ProfileInput): Result {
      const u = me(get());
      if (!u) return fail('Not signed in');
      if (blank(input.name)) return fail('Add your name', 'name');
      const pw = input.password ?? '';
      if (pw && pw.length < 8) return fail('Password needs at least 8 characters', 'password');
      if (pw && pw !== (input.repeat ?? '')) return fail('Passwords do not match', 'repeat');
      dispatch({
        type: 'profile/save',
        personId: u.id,
        patch: {
          name: input.name.trim(),
          phone: input.phone ?? u.phone,
          tz: input.tz ?? u.tz,
          notif: input.notif ?? u.notif,
          ...(pw ? { pwHash: hashPw(pw) } : {}),
        },
      });
      return ok('Profile saved');
    },

    // ── Time (V-10…V-12) ───────────────────────────────────────────────────

    /**
     * V-10 / V-11 / V-12: add or replace an entry. Errors in SPEC order: "Pick a project
     * first", "Pick a ticket, or switch to text" (only when the project has open
     * tickets), "Describe what you worked on", "Add the time spent".
     */
    saveTimeEntry(input: LogInput): Result<{ id: number }> {
      const s = get();
      const u = me(s);
      if (!u || !myCan(s, 'Timesheet')) return fail('Your role does not log time');
      const proj = input.proj ?? '';
      const min = (Number(input.h) || 0) * 60 + (Number(input.m) || 0);
      const isAdmin = proj === 'x:admin';
      const mode = isAdmin ? 'text' : input.mode;
      const pid = proj.slice(2);
      const open = proj && !isAdmin ? ticketsOf(s, pid).filter((t) => t.st !== 'done' || t.key === input.key) : [];
      if (!proj) return fail('Pick a project first', 'proj');
      if (mode === 'ticket' && blank(input.key) && open.length) return fail('Pick a ticket, or switch to text', 'key');
      if (mode !== 'ticket' && blank(input.text)) return fail('Describe what you worked on', 'text');
      if (min <= 0) return fail('Add the time spent', 'time');
      const target = mode === 'ticket' && input.key ? tkOrSub(s, input.key) : null;
      const prev = input.id != null ? s.entries.find((e) => e.id === input.id) : undefined;
      const entry: TimeEntry = {
        id: prev?.id ?? nextNum(),
        who: prev?.who ?? u.name,
        date: input.date || TODAY,
        proj,
        key: target ? (target.subtask ? target.subtask.id : target.key) : '',
        task: target ? target.title : (input.text ?? '').trim() || 'Admin',
        min,
        bill: !!input.bill,
        note: (input.note ?? '').trim(),
        ...(prev?.team ? { team: true } : {}),
      };
      dispatch({ type: 'time/save', entry });
      return ok(`${hm(min)} logged`, { id: entry.id });
    },

    /** V-12 */
    deleteTimeEntry(id: number): Result {
      if (!get().entries.some((e) => e.id === id)) return fail('Entry not found');
      dispatch({ type: 'time/delete', id });
      return ok('Entry deleted');
    },

    // ── Tickets (V-20…V-31) ────────────────────────────────────────────────

    /** V-31: key = the project's prefix + (max+1) (A-13). */
    createTicket(input: TicketInput): Result<{ key: string }> {
      const s = get();
      const p = project(s, input.projectId);
      if (!p) return fail('Project not found');
      if (!myPerm(s, 'tickets.create')) return fail("You can't create tickets");
      if (blank(input.title)) return fail(REQUIRED, 'title');
      const epicId = input.epicId || epicsOf(s, p.id)[0]?.id || p.id;
      const key = nextTicketKey(s, p.keyPrefix);
      const t: Ticket = {
        key,
        title: input.title.trim(),
        projectId: p.id,
        epicId,
        sprintId: input.sprintId || null,
        type: input.type ?? 'Task',
        st: 'todo',
        prio: input.prio ?? 'Medium',
        start: '',
        due: input.due ?? '',
        est: Number(input.est) || 0,
        as: input.as ?? [],
        subs: [],
        desc: input.desc ?? '',
        att: [],
        blk: [],
        unread: 0,
        comments: [],
        subSeq: 1,
      };
      dispatch({ type: 'tickets/create', ticket: t });
      return ok(`${key} created`, { key });
    },

    /** V-21 / V-22 / V-27 / V-48: any ticket field. Status changes toast "Moved to …". */
    patchTicket(key: string, patch: TicketPatch): Result {
      const s = get();
      const t = ticket(s, key);
      if (!t) return fail('Ticket not found');
      if (isClientRole(me(s)?.role)) return fail('Only comments can be added from the portal.');
      if (patch.as && !myPerm(s, 'tickets.assign')) return fail("You can't assign tickets");
      if (patch.sprintId) {
        const sp = sprint(s, patch.sprintId);
        if (!sp) return fail('Sprint not found');
      }
      dispatch({ type: 'tickets/patch', key, patch });
      if (patch.st && patch.st !== t.st) {
        const labels: Record<TicketStatus, string> = { todo: 'To do', prog: 'In progress', review: 'Review', done: 'Done' };
        return ok(`Moved to ${labels[patch.st]}`);
      }
      return ok('');
    },

    /** V-20: opening a ticket clears its unread count (staff only). */
    markTicketRead(key: string): void {
      const s = get();
      const t = ticket(s, key);
      if (t?.unread && !isClientRole(me(s)?.role)) dispatch({ type: 'tickets/markRead', key });
    },

    /** V-29 (clients can comment too). */
    addTicketComment(key: string, text: string): Result {
      if (!ticket(get(), key)) return fail('Ticket not found');
      if (blank(text)) return fail('Write a comment first');
      dispatch({ type: 'tickets/addComment', key, comment: { who: meName(), t: text.trim(), when: 'just now' } });
      return ok('');
    },

    /** V-28: the file also shows in project Files. */
    attachToTicket(key: string, file: Pick<FileRef, 'n' | 'size'>): Result {
      if (!ticket(get(), key)) return fail('Ticket not found');
      dispatch({ type: 'tickets/attach', key, file: { n: file.n, size: file.size, when: TODAY, by: meName() } });
      return ok('Attachment added');
    },

    /** V-27: add a blocker (same project, not itself, not already linked). */
    linkBlocker(key: string, blockerKey: string): Result {
      const s = get();
      const t = ticket(s, key);
      const b = ticket(s, blockerKey);
      if (!t || !b || b.key === t.key || b.projectId !== t.projectId) return fail('Pick another task in this project');
      if (t.blk.includes(b.key)) return ok('');
      dispatch({ type: 'tickets/patch', key, patch: { blk: [...t.blk, b.key] } });
      return ok('');
    },

    /** V-27: Clear links. */
    clearBlockers(key: string): Result {
      if (!ticket(get(), key)) return fail('Ticket not found');
      dispatch({ type: 'tickets/patch', key, patch: { blk: [] } });
      return ok('');
    },

    // ── Subtasks (V-23…V-26) ───────────────────────────────────────────────

    /** V-23: returns the new subtask's stable id. */
    addSubtask(key: string, title: string): Result<{ id: string }> {
      const t = ticket(get(), key);
      if (!t) return fail('Ticket not found');
      if (blank(title)) return fail(REQUIRED, 'title');
      const sub: Subtask = { id: `${t.key}.s${t.subSeq}`, title: title.trim(), st: 'todo', prio: t.prio, as: '', due: '', note: '', comments: [] };
      dispatch({ type: 'subtasks/add', key, sub });
      return ok('Subtask added', { id: sub.id });
    },

    /** V-25: status, priority, assignee, due, estimate, notes. */
    patchSubtask(key: string, subId: string, patch: SubtaskPatch): Result {
      const t = ticket(get(), key);
      if (!t || !t.subs.some((x) => x.id === subId)) return fail('Subtask not found');
      dispatch({ type: 'subtasks/patch', key, subId, patch });
      return ok('');
    },

    /**
     * V-24: toggles done. Toast "Completed PMT-11.2" / "Reopened PMT-11.2"; with
     * `short` (subtask screen) "Marked done" / "Reopened".
     */
    toggleSubtask(key: string, subId: string, opts: { short?: boolean } = {}): Result {
      const t = ticket(get(), key);
      const x = t?.subs.find((y) => y.id === subId);
      if (!t || !x) return fail('Subtask not found');
      const done = x.st !== 'done';
      dispatch({ type: 'subtasks/patch', key, subId, patch: { st: done ? 'done' : 'todo' } });
      const k = subKey(t, subId);
      if (opts.short) return ok(done ? 'Marked done' : 'Reopened');
      return ok(done ? `Completed ${k}` : `Reopened ${k}`);
    },

    /** V-25: a comment on the subtask. */
    commentOnSubtask(key: string, subId: string, text: string): Result {
      if (!subOf(get(), subId)) return fail('Subtask not found');
      if (blank(text)) return fail('Write a comment first');
      dispatch({ type: 'subtasks/comment', key, subId, comment: { who: meName(), t: text.trim(), when: 'just now' } });
      return ok('');
    },

    /** V-26: logged time is kept (entries keep the stable id). */
    deleteSubtask(key: string, subId: string): Result {
      const t = ticket(get(), key);
      if (!t || !t.subs.some((x) => x.id === subId)) return fail('Subtask not found');
      dispatch({ type: 'subtasks/delete', key, subId });
      return ok('Subtask deleted');
    },

    // ── Projects (V-41, V-42, V-50, V-51, V-54) ───────────────────────────

    /** V-41: a planned project; returns its id (the screen then opens it). */
    createProject(input: ProjectInput): Result<{ id: string }> {
      const s = get();
      if (blank(input.name)) return fail(REQUIRED, 'name');
      if (input.kind === 'client' && !company(s, input.companyId)) return fail(REQUIRED, 'companyId');
      const id = uid('p');
      const p: Project = {
        id,
        kind: input.kind,
        ...(input.kind === 'client' ? { companyId: input.companyId } : { area: input.area || 'Platform & tooling' }),
        name: input.name.trim(),
        desc: input.desc ?? '',
        state: 'planned',
        pct: 0,
        start: input.start ?? '',
        due: input.due ?? '',
        team: input.team ?? [],
        keyPrefix: prefixFor(s, input.name),
      };
      dispatch({ type: 'projects/create', project: p });
      return ok('Project started', { id });
    },

    /** V-42: Maintenance without terms creates them; Completed sets 100%. */
    setProjectStatus(id: string, state: ProjectState): Result {
      const p = project(get(), id);
      if (!p) return fail('Project not found');
      const patch: { state: ProjectState; sup?: Project['sup']; pct?: number } = { state };
      if (state === 'maint' && !p.sup) patch.sup = { until: addD(TODAY, 365), used: 0, quota: 10 };
      if (state === 'done') patch.pct = 100;
      dispatch({ type: 'projects/patch', id, patch });
      return ok(`Status set to ${PROJECT_STATE[state].label}`);
    },

    /** V-54 */
    saveSupportTerms(id: string, until: string, quota: number | string): Result {
      const p = project(get(), id);
      if (!p) return fail('Project not found');
      if (blank(until)) return fail(REQUIRED, 'until');
      if (blank(quota)) return fail(REQUIRED, 'quota');
      dispatch({ type: 'projects/patch', id, patch: { sup: { used: p.sup?.used ?? 0, until, quota: Number(quota) || 0 } } });
      return ok('Support terms saved');
    },

    /** V-51 */
    saveProjectTeam(id: string, team: string[]): Result {
      if (!project(get(), id)) return fail('Project not found');
      dispatch({ type: 'projects/patch', id, patch: { team } });
      return ok('Team updated');
    },

    /** V-50 */
    addProjectFile(id: string, file: Pick<FileRef, 'n' | 'size'>): Result {
      if (!project(get(), id)) return fail('Project not found');
      dispatch({ type: 'projects/addFile', id, file: { n: file.n, size: file.size, when: TODAY, by: meName() } });
      return ok('File added');
    },

    // ── Epics and sprints (V-46…V-49) ──────────────────────────────────────

    /** V-49: replaces the pseudo-epic of a project without epics. */
    createEpic(projectId: string, name: string, req: string): Result<{ id: string }> {
      if (!project(get(), projectId)) return fail('Project not found');
      if (blank(name)) return fail(REQUIRED, 'name');
      if (blank(req)) return fail(REQUIRED, 'req');
      const id = uid('e');
      dispatch({ type: 'epics/create', epic: { id, projectId, name: name.trim(), state: 'planned', pct: 0, sprints: 0, req: req.trim() } });
      return ok('Epic created', { id });
    },

    /** V-46: "Sprint N+1", 1 or 2 weeks, starting the day after the last sprint's end. */
    createSprint(epicId: string, opts: { start?: string; weeks?: 1 | 2 } = {}): Result<{ id: string }> {
      const s = get();
      const L = s.sprints.filter((x) => x.epicId === epicId);
      const last = L.reduce((m, x) => (x.end > m ? x.end : m), TODAY);
      const start = opts.start || addD(last, 1);
      const id = uid('s');
      const name = `Sprint ${L.length + 1}`;
      dispatch({ type: 'sprints/create', sprint: { id, epicId, name, start, end: addD(start, opts.weeks === 1 ? 6 : 13), state: 'planned' } });
      return ok('Sprint added', { id });
    },

    /** V-47: planned → active; only one active sprint per epic (A-12). */
    startSprint(id: string): Result {
      const s = get();
      const sp = sprint(s, id);
      if (!sp) return fail('Sprint not found');
      const active = s.sprints.find((x) => x.epicId === sp.epicId && x.state === 'active' && x.id !== id);
      if (active) return fail(`Complete ${active.name} first`);
      dispatch({ type: 'sprints/start', id });
      return ok(`${sp.name} started`);
    },

    /** V-47: active → done; unfinished tickets move to the backlog. */
    completeSprint(id: string): Result {
      const sp = sprint(get(), id);
      if (!sp) return fail('Sprint not found');
      dispatch({ type: 'sprints/complete', id });
      return ok(`${sp.name} completed`);
    },

    /** V-48: Backlog (null) or a sprint. */
    moveTicketToSprint(key: string, sprintId: string | null): Result {
      if (!ticket(get(), key)) return fail('Ticket not found');
      dispatch({ type: 'tickets/patch', key, patch: { sprintId } });
      return ok('Moved');
    },

    // ── Support (V-55) ─────────────────────────────────────────────────────

    /** V-55: a client support ticket on a maintenance project. */
    createSupportRequest(input: { projectId: string; kind: 'problem' | 'change'; title: string; desc: string; prio?: TicketPrio }): Result<{ key: string }> {
      const s = get();
      const p = project(s, input.projectId);
      if (!p) return fail('Project not found');
      if (blank(input.title)) return fail(REQUIRED, 'title');
      if (blank(input.desc)) return fail(REQUIRED, 'desc');
      const key = nextTicketKey(s, p.keyPrefix);
      const problem = input.kind === 'problem';
      dispatch({
        type: 'tickets/create',
        ticket: {
          key,
          title: input.title.trim(),
          projectId: p.id,
          epicId: epicsOf(s, p.id)[0]?.id ?? p.id,
          sprintId: null,
          type: problem ? 'Bug' : 'Task',
          st: 'todo',
          prio: problem ? (input.prio ?? 'High') : 'Medium',
          due: addD(TODAY, problem ? 1 : 14),
          est: 0,
          as: p.team[0] ? [p.team[0]] : [],
          subs: [],
          desc: input.desc.trim(),
          att: [],
          blk: [],
          unread: 0,
          comments: [],
          client: true,
          support: input.kind,
          subSeq: 1,
        },
      });
      return ok('Sent to the support team', { key });
    },

    // ── Questions (V-53, V-60) ─────────────────────────────────────────────

    /** V-53: toast "Question sent to Daco". */
    createQuestion(input: { projectId: string; title: string; text: string; task?: string | null }): Result<{ id: number }> {
      const s = get();
      const p = project(s, input.projectId);
      if (!p) return fail('Project not found');
      if (blank(input.title)) return fail(REQUIRED, 'title');
      if (blank(input.text)) return fail(REQUIRED, 'text');
      const id = Math.max(0, ...s.questions.map((q) => q.id)) + 1;
      dispatch({
        type: 'questions/create',
        question: { id, by: meName(), title: input.title.trim(), text: input.text.trim(), when: 'just now', task: input.task || null, answer: '', projectId: p.id },
      });
      return ok(`Question sent to ${p.kind === 'client' ? p.co : 'the team'}`, { id });
    },

    /** V-60 */
    answerQuestion(id: number, answer: string): Result {
      if (!get().questions.some((q) => q.id === id)) return fail('Question not found');
      if (blank(answer)) return fail('Type your answer first', 'answer');
      dispatch({ type: 'questions/answer', id, answer: answer.trim(), by: meName() });
      return ok('Answer sent to the team');
    },

    // ── Bugs (V-61…V-63) ───────────────────────────────────────────────────

    /** V-61 */
    reportBug(input: { projectId: string; epicId?: string; title: string; desc: string; file?: Pick<FileRef, 'n' | 'size'> | null }): Result<{ id: string }> {
      const s = get();
      if (!project(s, input.projectId)) return fail(REQUIRED, 'projectId');
      if (blank(input.title)) return fail(REQUIRED, 'title');
      if (blank(input.desc)) return fail(REQUIRED, 'desc');
      const bug: ClientBug = {
        id: uid('cb'),
        title: input.title.trim(),
        desc: input.desc.trim(),
        atts: input.file ? [{ n: input.file.n, size: input.file.size, when: TODAY, by: meName() }] : [],
        epicId: input.epicId || epicsOf(s, input.projectId)[0]?.id,
        projectId: input.projectId,
        when: TODAY,
        by: meName(),
        st: 'todo',
      };
      dispatch({ type: 'bugs/create', bug });
      return ok('Bug reported. Thank you.', { id: bug.id });
    },

    /** V-62 */
    replyOnBug(id: string, text: string): Result {
      if (!get().bugs.some((b) => b.id === id)) return fail('Bug not found');
      if (blank(text)) return fail('Write a reply first');
      dispatch({ type: 'bugs/reply', id, comment: { who: meName(), t: text.trim(), when: 'just now' } });
      return ok('');
    },

    /** V-63 (staff) */
    setBugStatus(id: string, st: TicketStatus): Result {
      const s = get();
      if (!s.bugs.some((b) => b.id === id)) return fail('Bug not found');
      if (isClientRole(me(s)?.role)) return fail('The team updates the status.');
      dispatch({ type: 'bugs/setStatus', id, st });
      return ok('');
    },

    // ── Client team (V-64) ─────────────────────────────────────────────────

    /** V-64: add (no id) → "Invite sent"; edit → "Saved". Email format → "Check the email address". */
    saveClientMember(input: { id?: string; name: string; title: string; email: string }): Result<{ id: string }> {
      const s = get();
      const u = me(s);
      if (!u || u.role !== 'cadmin') return fail('Only client admins manage the team');
      if (blank(input.name)) return fail(REQUIRED, 'name');
      if (blank(input.title)) return fail(REQUIRED, 'title');
      if (blank(input.email)) return fail(REQUIRED, 'email');
      const email = input.email.trim().toLowerCase();
      if (!EMAIL.test(email)) return fail('Check the email address', 'email');
      const fields = { name: input.name.trim(), title: input.title.trim(), email };
      if (input.id) {
        if (!s.clientTeam.some((m) => m.id === input.id)) return fail('Member not found');
        dispatch({ type: 'clientTeam/update', id: input.id, patch: fields });
        return ok('Saved', { id: input.id });
      }
      const id = uid('ct');
      dispatch({ type: 'clientTeam/add', member: { id, companyId: u.org, ...fields } });
      return ok('Invite sent', { id });
    },

    removeClientMember(id: string): Result {
      if (!get().clientTeam.some((m) => m.id === id)) return fail('Member not found');
      dispatch({ type: 'clientTeam/remove', id });
      return ok('Member removed');
    },

    // ── Users (V-71, V-72) ─────────────────────────────────────────────────

    /** V-71: add → "Invite sent to x"; edit → "User saved"; duplicate email refused. */
    saveUser(input: UserInput): Result<{ id: number }> {
      const s = get();
      if (!myPerm(s, 'users.manage')) return fail("You can't add or edit users");
      if (blank(input.name)) return fail(REQUIRED, 'name');
      if (blank(input.email)) return fail(REQUIRED, 'email');
      const email = input.email.trim().toLowerCase();
      const dup = s.people.find((p) => p.email.toLowerCase() === email && p.id !== input.id);
      if (dup) return fail('Someone already uses that email', 'email');
      const client = isClientRole(input.role);
      const u = me(s);
      const org = client ? (input.org && input.org !== 'vt' ? input.org : isClientRole(u?.role) ? u!.org : 'daco') : 'vt';
      const fields: Partial<Person> = {
        name: input.name.trim(),
        email,
        role: input.role,
        org,
        devType: client ? undefined : input.devType || undefined,
        emp: client ? undefined : input.emp,
        projects: input.role === 'super' ? 'all' : (input.projects ?? []),
        active: input.active !== false,
      };
      if (input.id != null) {
        if (!s.people.some((p) => p.id === input.id)) return fail('User not found');
        dispatch({ type: 'users/update', id: input.id, patch: fields });
        return ok('User saved', { id: input.id });
      }
      const id = Math.max(0, ...s.people.map((p) => p.id)) + 1;
      const colour = client ? '#56657A' : tilePalette[id % tilePalette.length];
      dispatch({ type: 'users/add', person: { ...(fields as Person), id, colour, last: 'Invited', invited: true } });
      return ok(`Invite sent to ${email}`, { id });
    },

    /** V-72: deactivated people cannot sign in. */
    setUserActive(id: number, active: boolean): Result {
      const s = get();
      if (!myPerm(s, 'users.manage')) return fail("You can't edit users");
      if (!s.people.some((p) => p.id === id)) return fail('User not found');
      dispatch({ type: 'users/setActive', id, active });
      return ok(active ? 'User activated' : 'User deactivated');
    },

    /** V-72: not for super admins; time history is kept. */
    removeUser(id: number): Result {
      const s = get();
      const p = s.people.find((x) => x.id === id);
      if (!myPerm(s, 'users.manage')) return fail("You can't remove users");
      if (!p) return fail('User not found');
      if (p.role === 'super') return fail("A super admin can't be removed");
      if (p.id === s.session.personId) return fail("You can't remove yourself");
      dispatch({ type: 'users/remove', id });
      return ok('User removed');
    },

    // ── Leave (V-73, V-74) ─────────────────────────────────────────────────

    /**
     * V-73: approvers (leave.approve) add approved leave for anyone; others send a pending
     * request for themselves.
     */
    addLeave(input: { who?: string; kind: LeaveKind; from: string; to: string; reason?: string }): Result<{ id: number }> {
      const s = get();
      const u = me(s);
      if (!u || isClientRole(u.role)) return fail('Client users have no leave');
      if (blank(input.from)) return fail(REQUIRED, 'from');
      if (blank(input.to)) return fail(REQUIRED, 'to');
      if (input.to < input.from) return fail('End date is before start date', 'to');
      const approver = myPerm(s, 'leave.approve');
      const id = nextNum();
      dispatch({
        type: 'leave/add',
        leave: {
          id,
          who: approver ? input.who || u.name : u.name,
          kind: input.kind,
          from: input.from,
          to: input.to,
          days: diff(input.to, input.from) + 1,
          reason: (input.reason ?? '').trim(),
          st: approver ? 'approved' : 'pending',
          ...(approver ? { decidedBy: u.name, decidedWhen: TODAY } : {}),
        },
      });
      return ok(approver ? 'Leave added' : 'Request sent for approval', { id });
    },

    /** V-74 */
    decideLeave(id: number, st: 'approved' | 'rejected'): Result {
      const s = get();
      if (!myPerm(s, 'leave.approve')) return fail('Admins approve leave and comp-off.');
      const l = s.leaves.find((x) => x.id === id);
      if (!l) return fail('Request not found');
      dispatch({ type: 'leave/decide', id, st, by: meName(), when: TODAY });
      return ok(st === 'approved' ? 'Approved' : 'Rejected');
    },

    // ── Permissions (V-75) ─────────────────────────────────────────────────

    /** V-75: super and admin only; super's row is fixed. */
    togglePermission(role: MatrixRole, key: PermKey): Result {
      const s = get();
      if (!canEditPermissions(me(s)?.role)) return fail('Only admins change permissions');
      if (isClientRole(role)) return fail('Client roles have no permissions');
      dispatch({ type: 'perms/toggle', role, key });
      const on = !s.perms[role]?.[key];
      return ok(`${ROLE_LABEL[role]}: ${on ? 'allowed' : 'not allowed'}`);
    },

    // ── Companies (V-80…V-83) ──────────────────────────────────────────────

    /** V-80: returns the new company id (the screen opens it). */
    createCompany(input: CompanyInput): Result<{ id: string }> {
      const s = get();
      if (!myPerm(s, 'companies.edit')) return fail("You can't add companies");
      if (blank(input.name)) return fail(REQUIRED, 'name');
      const id = uid('c');
      const c: Company = {
        id,
        name: input.name.trim(),
        logo: input.logo || undefined,
        industry: input.industry ?? '',
        country: input.country || 'Norway',
        web: input.web ?? '',
        p: s.companies.length % tilePalette.length,
        notes: '',
        contacts: input.contact ? [{ name: input.contact.trim(), role: 'Main contact', email: input.contactEmail ?? '', projects: [], admin: true }] : [],
        ourRoles: {},
        archived: false,
      };
      dispatch({ type: 'companies/create', company: c });
      return ok('Company created', { id });
    },

    /** V-81 */
    updateCompany(id: string, input: Partial<CompanyInput>): Result {
      const s = get();
      if (!myPerm(s, 'companies.edit')) return fail("You can't edit companies");
      if (!company(s, id)) return fail('Company not found');
      if (input.name !== undefined && blank(input.name)) return fail(REQUIRED, 'name');
      const { contact: _c, contactEmail: _e, ...patch } = input;
      dispatch({ type: 'companies/update', id, patch: { ...patch, ...(patch.name ? { name: patch.name.trim() } : {}) } });
      return ok('Saved');
    },

    /** V-83 */
    setCompanyArchived(id: string, archived: boolean): Result {
      const s = get();
      if (!myPerm(s, 'companies.edit')) return fail("You can't edit companies");
      if (!company(s, id)) return fail('Company not found');
      dispatch({ type: 'companies/setArchived', id, archived });
      return ok(archived ? 'Company archived' : 'Company restored');
    },

    /** V-82: index null = add. */
    saveContact(companyId: string, index: number | null, contact: CompanyContact): Result {
      const s = get();
      if (!myPerm(s, 'companies.edit')) return fail("You can't edit companies");
      if (!company(s, companyId)) return fail('Company not found');
      if (blank(contact.name)) return fail(REQUIRED, 'name');
      if (blank(contact.email)) return fail(REQUIRED, 'email');
      dispatch({
        type: 'contacts/save',
        companyId,
        index,
        contact: { ...contact, name: contact.name.trim(), email: contact.email.trim(), role: contact.role ?? '', projects: contact.projects ?? [] },
      });
      return ok('Contact saved');
    },

    removeContact(companyId: string, index: number): Result {
      const s = get();
      if (!myPerm(s, 'companies.edit')) return fail("You can't edit companies");
      dispatch({ type: 'contacts/remove', companyId, index });
      return ok('');
    },

    // ── DevOps (V-52, V-91…V-100) ──────────────────────────────────────────

    /**
     * V-91: a DevOps record for a project without one (DECISIONS 3). Client onboarding
     * starts the client ladder. Returns the key (the screen then opens it).
     */
    createDevopsProject(input: { projectId: string; infra?: string; owner?: string; initDue: string; note?: string }): Result<{ key: string }> {
      const s = get();
      if (!canDv(s)) return fail("You can't edit the DevOps board");
      if (!project(s, input.projectId)) return fail(REQUIRED, 'projectId');
      if (s.devops.some((d) => d.projectId === input.projectId)) return fail('This project is already on the DevOps board', 'projectId');
      if (blank(input.initDue)) return fail(REQUIRED, 'initDue');
      const key = nextDevopsKey(s);
      const infra = input.infra || s.devopsSettings.statuses[0];
      const cl = infra === 'Client onboarding';
      const record: DevopsProject = {
        key,
        projectId: input.projectId,
        infra,
        from: cl ? 'Client' : 'Not set',
        prio: 'Medium',
        act: cl ? LADDER[0] : 'Not required',
        ...(cl ? { step: 0 } : {}),
        phase: (input.note ?? '').trim(),
        overdue: false,
        initDue: input.initDue,
        deploy: 'Waiting',
        dev: 'Not set',
        owner: input.owner || 'Unassigned',
        updatedBy: meName(),
        cicd: false,
        logs: [log('Project added to the board')],
        notes: [],
      };
      dispatch({ type: 'devops/create', record });
      return ok(`${key} created`, { key });
    },

    /** V-92: Client onboarding starts the ladder; Deployment Completed sets the deploy. */
    setDevopsStatus(key: string, infra: string): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      if (infra === d.infra) return ok('');
      const patch: DevopsPatch = { infra };
      if (infra === 'Client onboarding' && d.from !== 'Client') Object.assign(patch, { from: 'Client', act: LADDER[0], step: 0 });
      if (infra === 'Deployment Completed') patch.deploy = 'Completed';
      dispatch({ type: 'devops/patch', key, patch, by: meName(), log: log(`Status changed from ${d.infra} to ${infra}`) });
      return ok('Status updated');
    },

    /**
     * V-93: a detail field. Option fields take the option; date fields take an ISO day
     * (reminder adds 07:00 and recomputes overdue; latestDue needs a reason when the
     * requireNote rule is on and records "moved"; initDue is fixed once saved when
     * lockInitial is on).
     */
    setDevopsField(key: string, field: (typeof DVF)[number]['key'], value: string, reason?: string): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      const s = get();
      const def = DVF.find((f) => f.key === field);
      if (!def) return fail('Unknown field');
      if (def.options) {
        const patch: DevopsPatch = { [field]: value } as DevopsPatch;
        const step = (LADDER as readonly string[]).indexOf(value);
        if (field === 'act' && step >= 0) Object.assign(patch, { from: 'Client', step });
        if (field === 'infra' && value === 'Deployment Completed') patch.deploy = 'Completed';
        const old = (d as unknown as Record<string, string | undefined>)[field];
        dispatch({ type: 'devops/patch', key, patch, by: meName(), log: log(`${def.label} changed from ${old || 'Not set'} to ${value}`) });
        return ok('');
      }
      if (blank(value)) return fail(REQUIRED, 'value');
      const rules = s.devopsSettings.rules;
      if (field === 'initDue' && rules.lockInitial && d.initDue) return fail('Initial due date is fixed once saved.', 'value');
      if (field === 'latestDue' && rules.requireNote && blank(reason)) return fail(REQUIRED, 'reason');
      const patch: DevopsPatch = {};
      let shown = dvDate(value);
      if (field === 'reminder') {
        patch.reminder = `${value.slice(0, 10)}T${REMINDER_TIME}`;
        patch.overdue = value.slice(0, 10) < TODAY;
        shown = dvDate(patch.reminder);
      } else if (field === 'latestDue') {
        patch.latestDue = value;
        patch.reason = (reason ?? '').trim();
        const from = d.initDue || d.latestDue;
        patch.moved = from ? `${diff(value, from) >= 0 ? '+' : ''}${diff(value, from)} d` : 'moved';
      } else {
        patch.initDue = value;
      }
      dispatch({ type: 'devops/patch', key, patch, by: meName(), log: log(`${def.label} set to ${shown}${patch.reason ? ` · ${patch.reason}` : ''}`) });
      return ok('');
    },

    /** V-94: Next step (or "What happened so far" with field 'phase'). */
    setDevopsText(key: string, text: string, field: 'next' | 'phase' = 'next'): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      dispatch({ type: 'devops/patch', key, patch: { [field]: text.trim() }, by: meName(), log: log('Next step updated') });
      return ok('');
    },

    /**
     * V-95: Log follow-up. Required fields follow the Rules (requireNote,
     * requireReminder). Client ladder advances one step when `advance`; the internal
     * ladder marks the last step done and appends the next one.
     */
    logFollowUp(key: string, input: FollowUpInput): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      const s = get();
      const R = s.devopsSettings.rules;
      const ladder = s.devopsSettings.ladder.map((x) => x.n);
      const iladder = s.devopsSettings.iladder;
      if (R.requireNote && blank(input.note)) return fail(REQUIRED, 'note');
      if (R.requireReminder && blank(input.reminder)) return fail(REQUIRED, 'reminder');
      const note = (input.note ?? '').trim();
      const rem = input.reminder ? input.reminder.slice(0, 10) : '';
      const client = d.from === 'Client' && ladder.includes(d.act);
      const ix = client ? (d.step ?? ladder.indexOf(d.act)) : -1;
      const patch: DevopsPatch = {
        reminder: rem ? `${rem}T${REMINDER_TIME}` : d.reminder,
        overdue: rem ? rem < TODAY : false,
      };
      if (client && input.advance !== false && ix < ladder.length - 1) {
        patch.step = ix + 1;
        patch.act = ladder[ix + 1];
      }
      if (!client) {
        const L = (d.ifu ?? []).map((x, i, a) => (i === a.length - 1 && !x.done ? { ...x, done: true, note } : x));
        if (rem) L.push({ date: rem, name: input.nextName?.trim() || iladder[Math.min(L.length, iladder.length - 1)] });
        patch.ifu = L;
      }
      const text = `${input.type || 'Follow-up'}: ${note || 'logged'}${patch.act ? ` · moved to ${patch.act}` : ''}`;
      dispatch({ type: 'devops/patch', key, patch, by: meName(), log: log(text) });
      return ok('Follow-up logged');
    },

    /** V-96 */
    setDevPhase(key: string, phase: string): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      if (d.dev === phase) return ok('');
      dispatch({ type: 'devops/patch', key, patch: { dev: phase }, by: meName(), log: log(`Dev phase moved from ${d.dev} to ${phase}`) });
      return ok('');
    },

    /** V-97 */
    toggleCicd(key: string): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      dispatch({ type: 'devops/patch', key, patch: { cicd: !d.cicd }, by: meName(), log: log(`CI/CD switched ${d.cicd ? 'off' : 'on'}`) });
      return ok('');
    },

    /** V-98 */
    addDevopsNote(key: string, text: string): Result {
      const d = dvGuard(key);
      if ('ok' in d) return d;
      if (blank(text)) return fail('Write a note first');
      dispatch({ type: 'devops/addNote', key, note: log(text.trim()) });
      return ok('');
    },

    /** V-52: REQ-(max+1), Open; the DevOps log gets "Request REQ-n raised by X". */
    createDevopsRequest(input: { key: string; type: string; prio: string; to: string; text: string }): Result<{ id: number; rkey: string }> {
      const s = get();
      const d = devopsByKey(s, input.key);
      if (!d) return fail('DevOps project not found');
      if (blank(input.text)) return fail(REQUIRED, 'text');
      const n = Math.max(0, ...s.devopsRequests.map((r) => Number(r.rkey.split('-')[1]) || 0)) + 1;
      const rkey = `REQ-${n}`;
      const id = nextNum();
      dispatch({
        type: 'requests/create',
        request: { id, key: d.key, rkey, type: input.type, prio: input.prio, to: input.to, text: input.text.trim(), by: meName(), when: 'just now', status: 'Open', comments: [] },
        log: log(`Request ${rkey} raised by ${meName()}`),
      });
      return ok('Request sent to DevOps', { id, rkey });
    },

    /** V-99: Mark as done / Reopen (canDv). */
    setRequestStatus(id: number, status: 'Open' | 'Done'): Result {
      const s = get();
      if (!canDv(s)) return fail("You can't edit the DevOps board");
      const r = s.devopsRequests.find((x) => x.id === id);
      if (!r) return fail('Request not found');
      dispatch({ type: 'requests/setStatus', id, status, log: log(`Request ${r.rkey} ${status === 'Done' ? 'marked done' : 'reopened'}`) });
      return ok(status === 'Done' ? 'Marked as done' : 'Reopened');
    },

    /** V-99: reply on a request. */
    commentOnRequest(id: number, text: string): Result {
      if (!get().devopsRequests.some((r) => r.id === id)) return fail('Request not found');
      if (blank(text)) return fail('Write a reply first');
      dispatch({ type: 'requests/comment', id, comment: { who: meName(), t: text.trim(), when: 'just now' } });
      return ok('');
    },

    /** V-100: add (index null) or rename a status / phase. Renaming a status updates every project on it. */
    saveDevopsSettingsItem(list: DevopsSettingsList, index: number | null, name: string, days?: number | string): Result {
      const s = get();
      if (!canEditDevopsSettings(me(s)?.role)) return fail("You can't edit DevOps settings");
      if (blank(name)) return fail(REQUIRED, 'name');
      const n = name.trim();
      const names = list === 'statuses' ? s.devopsSettings.statuses : s.devopsSettings.phases.map((p) => p.n);
      if (names.some((x, i) => x === n && i !== index)) return fail('That name is already in the list', 'name');
      dispatch({ type: 'devopsSettings/saveItem', list, index, name: n, days: Number(days) || 0, by: meName() });
      return ok('');
    },

    /** V-100: projects on a removed status move to the first status. */
    removeDevopsSettingsItem(list: DevopsSettingsList, index: number): Result {
      const s = get();
      if (!canEditDevopsSettings(me(s)?.role)) return fail("You can't edit DevOps settings");
      if (s.devopsSettings[list].length <= 1) return fail('Keep at least one');
      dispatch({ type: 'devopsSettings/removeItem', list, index, by: meName() });
      return ok('');
    },

    /** V-100 */
    toggleDevopsRule(rule: DevopsRule): Result {
      if (!canEditDevopsSettings(me(get())?.role)) return fail("You can't edit DevOps settings");
      dispatch({ type: 'devopsSettings/toggleRule', rule });
      return ok('');
    },

    // ── Demo ───────────────────────────────────────────────────────────────

    /** Back to the seed (kitchen sink / tests); keeps the session. */
    resetDemo(): void {
      dispatch({ type: 'demo/reset' });
    },
  };
}

export type Commands = ReturnType<typeof createCommands>;
