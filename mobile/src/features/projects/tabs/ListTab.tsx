import { useMemo, useState } from 'react';

import { FilterChips, Rows, SearchField, TicketRow } from '@/components';
import { epicName, sprint, ticketsOf, type ProjectView } from '@/data/selectors';
import { useAppState, useStoreState } from '@/data/store';

import { LIST_CHIPS, listTickets, matchesList, type ListFilter } from '../derive';

/** List tab (V-45, staff): search, status chips with counts, ticket rows. */
export function ListTab({ p, st, setSt }: { p: ProjectView; st: ListFilter; setSt: (v: ListFilter) => void }) {
  const state = useStoreState();
  const all = useAppState((s) => ticketsOf(s, p.id));
  const [q, setQ] = useState('');
  const L = useMemo(() => listTickets(all, st, q), [all, st, q]);
  const chips = LIST_CHIPS.map((c) => ({ ...c, count: all.filter((t) => matchesList(t, c.value)).length }));
  return (
    <>
      <SearchField value={q} onChange={setQ} placeholder="Search tickets" testID="list-search" />
      <FilterChips options={chips} value={st} onChange={setSt} testID="list-st" />
      <Rows empty="No tasks match these filters." testID="project-list">
        {L.map((t) => (
          <TicketRow
            key={t.key}
            ticket={t}
            sub={`${epicName(state, t.epicId)} · ${t.sprintId ? (sprint(state, t.sprintId)?.name ?? '') : 'Backlog'} · ${t.as.length ? t.as.join(', ') : 'Unassigned'}`}
          />
        ))}
      </Rows>
    </>
  );
}
