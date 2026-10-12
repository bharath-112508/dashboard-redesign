import { EMPTY_MAINTENANCE } from '../seed/maintenance';
import type { MaintData, Ticket } from '../types';
import type { Action } from './actions';
import { createInitialState, type AppState } from './state';

const mapTicket = (s: AppState, id: number, f: (t: Ticket) => Ticket): AppState => ({
  ...s,
  tickets: s.tickets.map((t) => (t.id === id ? f(t) : t)),
});

const mapMaint = (s: AppState, project: string, f: (m: MaintData) => MaintData): AppState => ({
  ...s,
  maintenance: { ...s.maintenance, [project]: f(s.maintenance[project] ?? EMPTY_MAINTENANCE) },
});

const withSettingsLog = (s: AppState, line: AppState['devopsSettings']['log'][number]) => [
  line,
  ...s.devopsSettings.log,
];

/** Pure reducer: (state, action) → next state. */
export function reducer(s: AppState, a: Action): AppState {
  switch (a.type) {
    // ── Session ──
    case 'session/signIn':
      return { ...s, session: { ...s.session, user: a.user } };
    case 'session/switchAccount':
      return { ...s, session: { ...s.session, user: null } };
    case 'session/signOut':
      return { ...s, session: { user: null, email: '' } };
    case 'session/setEmailDraft':
      return { ...s, session: { ...s.session, email: a.email } };

    // ── Notifications and profile ──
    case 'notifications/markRead':
      return { ...s, read: { ...s.read, [a.id]: true } };
    case 'notifications/markAllRead': {
      const read = { ...s.read };
      a.ids.forEach((id) => (read[id] = true));
      return { ...s, read };
    }
    case 'profile/setPush':
      return { ...s, push: a.on };

    // ── Tickets ──
    case 'tickets/setStatus':
      return mapTicket(s, a.id, (t) => ({ ...t, st: a.st }));
    case 'tickets/addComment':
      return mapTicket(s, a.id, (t) => ({ ...t, comments: [...t.comments, a.comment] }));
    case 'tickets/setDesc':
      return mapTicket(s, a.id, (t) => ({ ...t, desc: a.desc }));
    case 'tickets/create':
      return { ...s, tickets: [...s.tickets, a.ticket] };

    // ── Time ──
    case 'time/addEntry': {
      const next = typeof a.entry.id === 'number' ? Math.max(s.nextId, a.entry.id + 1) : s.nextId;
      const tk = a.entry.tk;
      const withHours = tk == null ? s : mapTicket(s, tk, (t) => ({ ...t, hrs: t.hrs + a.entry.h }));
      return { ...withHours, entries: [...s.entries, a.entry], nextId: next };
    }

    // ── Questions ──
    case 'questions/addMessage':
      return {
        ...s,
        questions: s.questions.map((q) => (q.id === a.id ? { ...q, msgs: [...q.msgs, a.msg] } : q)),
      };

    // ── Leave ──
    case 'leave/add':
      return {
        ...s,
        leaves: [...s.leaves, { ...a.leave, st: 'Pending' }],
        nextId: Math.max(s.nextId, a.leave.id + 1),
      };
    case 'leave/decide':
      return {
        ...s,
        leaves: s.leaves.map((l) =>
          l.id === a.id ? { ...l, st: a.st, decidedBy: a.by, decidedWhen: a.when } : l,
        ),
      };

    // ── Projects and maintenance ──
    case 'projects/setStatus':
      return {
        ...s,
        projects: s.projects.map((p) => (p.name === a.project ? { ...p, status: a.status } : p)),
      };
    case 'projects/savePlan':
      return {
        ...s,
        projects: s.projects.map((p) =>
          p.name === a.project ? { ...p, plan: a.plan, status: 'maint' } : p,
        ),
        maintenance: s.maintenance[a.project]
          ? s.maintenance
          : { ...s.maintenance, [a.project]: { ...EMPTY_MAINTENANCE } },
        ui: { ...s.ui, projectView: { ...s.ui.projectView, [a.project]: 'sup' } },
      };
    case 'maintenance/toggleBilling':
      return mapMaint(s, a.project, (m) => ({
        ...m,
        req: m.req.map((r) => (r.id === a.requestId ? { ...r, outside: !r.outside } : r)),
      }));
    case 'maintenance/assign':
      return mapMaint(s, a.project, (m) => ({
        ...m,
        req: m.req.map((r) => (r.id === a.requestId ? { ...r, as: a.who } : r)),
      }));
    case 'maintenance/toggleTask':
      return mapMaint(s, a.project, (m) => ({
        ...m,
        tasks: m.tasks.map((t) => (t.id === a.taskId ? { ...t, done: !t.done } : t)),
      }));

    // ── DevOps ──
    case 'devops/advancePhase':
      return {
        ...s,
        devops: s.devops.map((d) =>
          d.p === a.project ? { ...d, phase: a.next, log: [a.line, ...d.log] } : d,
        ),
        ui: { ...s.ui, devopsOpen: { ...s.ui.devopsOpen, [a.project]: true } },
      };
    case 'devops/adjustReminder': {
      const seq = s.devopsSettings.seq.map((r, i) =>
        i === a.index ? { ...r, d: Math.max(1, r.d + a.delta) } : r,
      );
      return { ...s, devopsSettings: { ...s.devopsSettings, seq, log: withSettingsLog(s, a.line) } };
    }
    case 'devops/addReminder': {
      const seq = s.devopsSettings.seq;
      const last = seq[seq.length - 1];
      const added = { n: `Reminder ${seq.length + 1}`, d: (last?.d ?? 0) + 7 };
      return {
        ...s,
        devopsSettings: { ...s.devopsSettings, seq: [...seq, added], log: withSettingsLog(s, a.line) },
      };
    }
    case 'devops/toggleRule':
      return {
        ...s,
        devopsSettings: {
          ...s.devopsSettings,
          rules: { ...s.devopsSettings.rules, [a.rule]: !s.devopsSettings.rules[a.rule] },
          log: withSettingsLog(s, a.line),
        },
      };
    case 'devops/movePhaseUp': {
      if (a.index <= 0) return s;
      const phases = [...s.devopsSettings.phases];
      [phases[a.index - 1], phases[a.index]] = [phases[a.index], phases[a.index - 1]];
      return { ...s, devopsSettings: { ...s.devopsSettings, phases, log: withSettingsLog(s, a.line) } };
    }
    case 'devops/addPhase': {
      const ph = s.devopsSettings.phases;
      const phases = [...ph.slice(0, -1), a.name, ...ph.slice(-1)];
      return { ...s, devopsSettings: { ...s.devopsSettings, phases, log: withSettingsLog(s, a.line) } };
    }

    // ── Companies and users ──
    case 'companies/setPortalPerm':
      return {
        ...s,
        companies: s.companies.map((c) =>
          c.name !== a.company
            ? c
            : {
                ...c,
                contacts: c.contacts.map((k) =>
                  k.name === a.contact ? { ...k, portal: { ...k.portal, [a.perm]: a.on } } : k,
                ),
              },
        ),
      };
    case 'companies/toggleArchived':
      return {
        ...s,
        companies: s.companies.map((c) => (c.name === a.company ? { ...c, archived: !c.archived } : c)),
      };
    case 'users/setRole':
      return { ...s, people: s.people.map((p) => (p.name === a.name ? { ...p, staffRole: a.role } : p)) };
    case 'users/toggleActive':
      return { ...s, people: s.people.map((p) => (p.name === a.name ? { ...p, active: !p.active } : p)) };

    // ── UI ──
    case 'ui/set':
      return { ...s, ui: { ...s.ui, ...a.patch } };

    // ── Demo ──
    case 'demo/reset':
      return { ...createInitialState(), session: s.session };

    default: {
      const never: never = a;
      return never;
    }
  }
}
