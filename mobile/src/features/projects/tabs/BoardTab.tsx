import { useMemo, useState } from 'react';

import { Board, FilterChips, openTicket, Segmented, TextBlock, type BoardColumn } from '@/components';
import { TICKET_STATUS, TICKET_STATUSES } from '@/data/constants';
import { dueInfo, epicsOf, subProgress, type ProjectView } from '@/data/selectors';
import { useAppState, useStoreState } from '@/data/store';
import type { Ticket } from '@/data/types';
import { tones } from '@/theme';

import { boardTickets, type SprintFilter } from '../derive';

function columns(L: Ticket[], client: boolean): BoardColumn[] {
  return TICKET_STATUSES.map((k) => ({
    key: k,
    name: client ? TICKET_STATUS[k].client : TICKET_STATUS[k].label,
    dot: tones[TICKET_STATUS[k].tone].dot,
    cards: L.filter((t) => t.st === k).map((t) => {
      const d = dueInfo(t);
      const sp = subProgress(t);
      return {
        k: t.key,
        title: t.title,
        prio: t.prio,
        type: t.type,
        due: t.due ? d.text : '',
        dueColor: d.color,
        subs: sp.total ? `${sp.done}/${sp.total}` : '',
        comments: t.comments.length,
        people: client ? [] : t.as.slice(0, 3),
        onPress: () => openTicket(t.key),
      };
    }),
  }));
}

/** Board tab (V-44): epic chips, staff sprint segment, 4 snapping columns. */
export function BoardTab({ p, client, epic, setEpic }: { p: ProjectView; client: boolean; epic: string; setEpic: (v: string) => void }) {
  const state = useStoreState();
  const epics = useAppState((s) => epicsOf(s, p.id));
  const [spr, setSpr] = useState<SprintFilter>('active');
  const cols = useMemo(() => columns(boardTickets(state, p.id, epic, spr, client), client), [state, p.id, epic, spr, client]);
  return (
    <>
      {epics.length > 1 ? (
        <FilterChips options={[{ value: 'all', label: 'All epics' }, ...epics.map((e) => ({ value: e.id, label: e.name }))]} value={epic} onChange={setEpic} testID="board-epic" />
      ) : null}
      {client ? null : (
        <Segmented
          options={[
            { value: 'active', label: 'Active sprint' },
            { value: 'all', label: 'All' },
            { value: 'backlog', label: 'Backlog' },
          ]}
          value={spr}
          onChange={setSpr}
          testID="board-spr"
        />
      )}
      <Board columns={cols} testID="project-board" />
      <TextBlock tone="info" text="Swipe sideways to see every column. Tap a card to open it and change its status." />
    </>
  );
}
