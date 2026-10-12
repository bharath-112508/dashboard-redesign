/** Epics tree view model (S-PROJECT Epics): Epic → Sprint → Ticket, with open state. */
import { sh } from '@/data/format';
import { dueInfo, myRole, type DueInfo } from '@/data/selectors';
import type { AppState } from '@/data/store';
import type { Sprint, Ticket } from '@/data/types';
import { epicPalette, type Tone } from '@/theme';

import { projectEpics, projectSprints, projectTickets } from './selectors';

export interface TreeTicket {
  ticket: Ticket;
  critical: boolean;
  due: DueInfo;
}

export interface TreeSprint {
  key: string;
  sprint: Sprint;
  dates: string;
  count: string;
  open: boolean;
  tickets: TreeTicket[];
}

export interface TreeEpic {
  key: string;
  name: string;
  tone: Tone;
  meta: string;
  pct: number;
  open: boolean;
  sprints: TreeSprint[];
}

export const epicKey = (project: string, epic: string) => `${project}|${epic}`;
export const sprintKey = (project: string, epic: string, sprint: string) => `${project}|${epic}|${sprint}`;

export function epicsTree(s: AppState, project: string): TreeEpic[] {
  const client = myRole(s) === 'client';
  const all = projectTickets(s, project);
  const sprints = projectSprints(s, project);
  return projectEpics(s, project).map((e, ei) => {
    const ek = epicKey(project, e);
    const sps = sprints.filter((x) => x.e === e);
    const ts = all.filter((t) => t.epic === e);
    const done = ts.filter((t) => t.st === 'done').length;
    const eo = s.ui.epicOpen[ek] ?? ei === 0;
    return {
      key: ek,
      name: e,
      tone: epicPalette[ei % epicPalette.length],
      meta: `${sps.length} sprint${sps.length === 1 ? '' : 's'} · ${done}/${ts.length} done`,
      pct: ts.length ? Math.round((done / ts.length) * 100) : 0,
      open: eo,
      sprints: sps.map((x) => {
        const sk = sprintKey(project, e, x.n);
        const tt = ts.filter((t) => t.sprint === x.n);
        return {
          key: sk,
          sprint: x,
          dates: `${sh(x.a)} – ${sh(x.b)}`,
          count: `${tt.filter((t) => t.st === 'done').length}/${tt.length} done`,
          open: s.ui.sprintOpen[sk] ?? x.st === 'active',
          tickets: tt.map((t) => ({ ticket: t, critical: t.prio === 'Critical' && !client && t.st !== 'done', due: dueInfo(t) })),
        };
      }),
    };
  });
}
