import type { DevopsProject, Ticket } from '../types';
import type { Action } from './actions';
import { clientActionAllowed } from './clientPolicy';
import { createInitialState, type AppState } from './state';

const mapTicket = (s: AppState, key: string, f: (t: Ticket) => Ticket): AppState => ({
  ...s,
  tickets: s.tickets.map((t) => (t.key === key ? f(t) : t)),
});

const mapDevops = (s: AppState, key: string, f: (d: DevopsProject) => DevopsProject): AppState => ({
  ...s,
  devops: s.devops.map((d) => (d.key === key ? f(d) : d)),
});

const bumpId = (s: AppState, id: number) => Math.max(s.nextId, id + 1);

/**
 * Pure reducer: (state, action) → next state. An action a signed-in client may not take
 * (`clientActionAllowed`, the client policy) leaves the state unchanged.
 */
export function reducer(s: AppState, a: Action): AppState {
  return clientActionAllowed(s, a) ? apply(s, a) : s;
}

function apply(s: AppState, a: Action): AppState {
  switch (a.type) {
    // ── Session and profile ──
    case 'session/signIn':
      return { ...s, session: { personId: a.personId } };
    case 'session/signOut':
      return { ...s, session: { personId: null } };
    case 'profile/save':
    case 'users/update':
      return {
        ...s,
        people: s.people.map((p) => (p.id === (a.type === 'profile/save' ? a.personId : a.id) ? { ...p, ...a.patch } : p)),
      };

    // ── Time ──
    case 'time/save': {
      const exists = s.entries.some((e) => e.id === a.entry.id);
      return {
        ...s,
        entries: exists ? s.entries.map((e) => (e.id === a.entry.id ? a.entry : e)) : [a.entry, ...s.entries],
        nextId: bumpId(s, a.entry.id),
      };
    }
    case 'time/delete':
      return { ...s, entries: s.entries.filter((e) => e.id !== a.id) };

    // ── Tickets ──
    case 'tickets/create':
      return { ...s, tickets: [...s.tickets, a.ticket] };
    case 'tickets/patch':
      return mapTicket(s, a.key, (t) => ({ ...t, ...a.patch }));
    case 'tickets/markRead':
      return mapTicket(s, a.key, (t) => (t.unread ? { ...t, unread: 0 } : t));
    case 'tickets/addComment':
      return mapTicket(s, a.key, (t) => ({ ...t, comments: [...t.comments, a.comment] }));
    case 'tickets/attach':
      return mapTicket(s, a.key, (t) => ({ ...t, att: [...t.att, a.file] }));

    // ── Subtasks ──
    case 'subtasks/add':
      return mapTicket(s, a.key, (t) => ({ ...t, subs: [...t.subs, a.sub], subSeq: t.subSeq + 1 }));
    case 'subtasks/patch':
      return mapTicket(s, a.key, (t) => ({ ...t, subs: t.subs.map((x) => (x.id === a.subId ? { ...x, ...a.patch } : x)) }));
    case 'subtasks/comment':
      return mapTicket(s, a.key, (t) => ({
        ...t,
        subs: t.subs.map((x) => (x.id === a.subId ? { ...x, comments: [...x.comments, a.comment] } : x)),
      }));
    case 'subtasks/delete':
      return mapTicket(s, a.key, (t) => ({ ...t, subs: t.subs.filter((x) => x.id !== a.subId) }));

    // ── Projects ──
    case 'projects/create':
      return { ...s, projects: [...s.projects, a.project] };
    case 'projects/patch':
      return { ...s, projects: s.projects.map((p) => (p.id === a.id ? { ...p, ...a.patch } : p)) };
    case 'projects/addFile':
      return { ...s, files: { ...s.files, [a.id]: [a.file, ...(s.files[a.id] ?? [])] } };

    // ── Epics and sprints ──
    case 'epics/create':
      return { ...s, epics: [...s.epics, a.epic] };
    case 'sprints/create':
      return { ...s, sprints: [...s.sprints, a.sprint] };
    case 'sprints/start':
      return { ...s, sprints: s.sprints.map((x) => (x.id === a.id ? { ...x, state: 'active' } : x)) };
    case 'sprints/complete':
      return {
        ...s,
        sprints: s.sprints.map((x) => (x.id === a.id ? { ...x, state: 'done' } : x)),
        tickets: s.tickets.map((t) => (t.sprintId === a.id && t.st !== 'done' ? { ...t, sprintId: null } : t)),
      };

    // ── Client portal ──
    case 'questions/create':
      return { ...s, questions: [...s.questions, a.question] };
    case 'questions/answer':
      return { ...s, questions: s.questions.map((q) => (q.id === a.id ? { ...q, answer: a.answer, answeredBy: a.by } : q)) };
    case 'bugs/create':
      return { ...s, bugs: [a.bug, ...s.bugs] };
    case 'bugs/reply':
      return { ...s, bugChat: { ...s.bugChat, [a.id]: [...(s.bugChat[a.id] ?? []), a.comment] } };
    case 'bugs/setStatus':
      return { ...s, bugs: s.bugs.map((b) => (b.id === a.id ? { ...b, st: a.st } : b)) };
    case 'clientTeam/add':
      return { ...s, clientTeam: [...s.clientTeam, a.member] };
    case 'clientTeam/update':
      return { ...s, clientTeam: s.clientTeam.map((m) => (m.id === a.id ? { ...m, ...a.patch } : m)) };
    case 'clientTeam/remove':
      return { ...s, clientTeam: s.clientTeam.filter((m) => m.id !== a.id) };

    // ── Users, leave, permissions ──
    case 'users/add':
      return { ...s, people: [...s.people, a.person], nextId: bumpId(s, a.person.id) };
    case 'users/setActive':
      return { ...s, people: s.people.map((p) => (p.id === a.id ? { ...p, active: a.active } : p)) };
    case 'users/remove':
      return { ...s, people: s.people.filter((p) => p.id !== a.id) };
    case 'leave/add':
      return { ...s, leaves: [a.leave, ...s.leaves], nextId: bumpId(s, a.leave.id) };
    case 'leave/decide':
      return {
        ...s,
        leaves: s.leaves.map((l) => (l.id === a.id ? { ...l, st: a.st, decidedBy: a.by, decidedWhen: a.when } : l)),
      };
    case 'perms/toggle': {
      const row = s.perms[a.role] ?? {};
      return { ...s, perms: { ...s.perms, [a.role]: { ...row, [a.key]: !row[a.key] } } };
    }

    // ── Companies ──
    case 'companies/create':
      return { ...s, companies: [...s.companies, a.company] };
    case 'companies/update':
      return { ...s, companies: s.companies.map((c) => (c.id === a.id ? { ...c, ...a.patch } : c)) };
    case 'companies/setArchived':
      return { ...s, companies: s.companies.map((c) => (c.id === a.id ? { ...c, archived: a.archived } : c)) };
    case 'contacts/save':
      return {
        ...s,
        companies: s.companies.map((c) =>
          c.id !== a.companyId
            ? c
            : {
                ...c,
                contacts:
                  a.index == null ? [...c.contacts, a.contact] : c.contacts.map((x, i) => (i === a.index ? a.contact : x)),
              },
        ),
      };
    case 'contacts/remove':
      return {
        ...s,
        companies: s.companies.map((c) => (c.id === a.companyId ? { ...c, contacts: c.contacts.filter((_, i) => i !== a.index) } : c)),
      };

    // ── DevOps ──
    case 'devops/create':
      return { ...s, devops: [...s.devops, a.record] };
    case 'devops/patch':
      return mapDevops(s, a.key, (d) => ({
        ...d,
        ...a.patch,
        updatedBy: a.by,
        logs: a.log ? [a.log, ...d.logs] : d.logs,
      }));
    case 'devops/addNote':
      return mapDevops(s, a.key, (d) => ({ ...d, notes: [a.note, ...d.notes], updatedBy: a.note.by }));
    case 'requests/create': {
      const withLog = mapDevops(s, a.request.key, (d) => ({ ...d, logs: [a.log, ...d.logs] }));
      return { ...withLog, devopsRequests: [a.request, ...s.devopsRequests], nextId: bumpId(s, a.request.id) };
    }
    case 'requests/setStatus': {
      const req = s.devopsRequests.find((r) => r.id === a.id);
      const withLog = req ? mapDevops(s, req.key, (d) => ({ ...d, logs: [a.log, ...d.logs], updatedBy: a.log.by })) : s;
      return { ...withLog, devopsRequests: s.devopsRequests.map((r) => (r.id === a.id ? { ...r, status: a.status } : r)) };
    }
    case 'requests/comment':
      return {
        ...s,
        devopsRequests: s.devopsRequests.map((r) => (r.id === a.id ? { ...r, comments: [...r.comments, a.comment] } : r)),
      };
    case 'devopsSettings/saveItem': {
      const set = s.devopsSettings;
      if (a.list === 'phases') {
        const item = { n: a.name, d: a.days ?? 0 };
        const phases = a.index == null ? [...set.phases, item] : set.phases.map((p, i) => (i === a.index ? item : p));
        return { ...s, devopsSettings: { ...set, phases } };
      }
      const old = a.index == null ? null : set.statuses[a.index];
      const statuses = a.index == null ? [...set.statuses, a.name] : set.statuses.map((x, i) => (i === a.index ? a.name : x));
      const devops =
        old && old !== a.name
          ? s.devops.map((d) =>
              d.infra === old
                ? { ...d, infra: a.name, updatedBy: a.by, logs: [{ by: a.by, when: 'Just now', text: `Status renamed to ${a.name}` }, ...d.logs] }
                : d,
            )
          : s.devops;
      return { ...s, devops, devopsSettings: { ...set, statuses } };
    }
    case 'devopsSettings/removeItem': {
      const set = s.devopsSettings;
      if (set[a.list].length <= 1) return s;
      if (a.list === 'phases') return { ...s, devopsSettings: { ...set, phases: set.phases.filter((_, i) => i !== a.index) } };
      const old = set.statuses[a.index];
      const statuses = set.statuses.filter((_, i) => i !== a.index);
      const first = statuses[0];
      const devops = s.devops.map((d) =>
        d.infra === old
          ? { ...d, infra: first, updatedBy: a.by, logs: [{ by: a.by, when: 'Just now', text: `Status ${old} was removed` }, ...d.logs] }
          : d,
      );
      return { ...s, devops, devopsSettings: { ...set, statuses } };
    }
    case 'devopsSettings/toggleRule':
      return {
        ...s,
        devopsSettings: { ...s.devopsSettings, rules: { ...s.devopsSettings.rules, [a.rule]: !s.devopsSettings.rules[a.rule] } },
      };

    // ── Demo ──
    case 'demo/reset':
      return { ...createInitialState(), session: s.session };
  }
}
