import { useState } from 'react';

import { BottomSheet, Button, DateField, EmptyBlock, Form, PickField, SelectField, TextArea, TextBlock, TextField, showToast } from '@/components';
import { PRIORITIES, TICKET_TYPES } from '@/data/constants';
import { fmt } from '@/data/format';
import { epicsOf, myPerm, project, sprintsOf } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketPrio, TicketType } from '@/data/types';
import { closeSheet } from '@/nav/routes';

/** SH-NEWTICKET Create ticket (V-31), opened from the project header "+" (`tickets.create`). */
export function NewTicketSheet({ pid }: { pid: string }) {
  const p = useAppState((s) => project(s, pid));
  const epics = useAppState((s) => epicsOf(s, pid));
  const canCreate = useAppState((s) => myPerm(s, 'tickets.create'));
  const [title, setTitle] = useState('');
  const [type, setType] = useState<TicketType>('Task');
  const [epicId, setEpic] = useState(epics[0]?.id ?? pid);
  const [sprintId, setSprint] = useState('');
  const [prio, setPrio] = useState<TicketPrio>('Medium');
  const [as, setAs] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [est, setEst] = useState('');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState('');
  const sprints = useAppState((s) => sprintsOf(s, epicId).filter((x) => x.state !== 'done'));
  const { createTicket } = useActions();

  if (!p) {
    return (
      <BottomSheet title="Create ticket" testID="sheet-new-ticket">
        <EmptyBlock text="Project not found." />
      </BottomSheet>
    );
  }
  const save = () => {
    const r = createTicket({ projectId: pid, title, type, epicId, sprintId: sprintId || null, prio, as, due, est, desc });
    if (!r.ok) {
      if (r.field === 'title') setErr(r.error);
      else showToast(r.error);
      return;
    }
    closeSheet();
    showToast(r.toast);
  };
  return (
    <BottomSheet title="Create ticket" sub={p.name} testID="sheet-new-ticket">
      {!canCreate ? <TextBlock tone="bad" text="Your role can't create tickets." /> : null}
      <Form>
        <TextField
          label="Title"
          required
          placeholder="What needs doing?"
          value={title}
          onChange={(v) => {
            setTitle(v);
            if (v.trim()) setErr('');
          }}
          error={err}
          testID="nt-title"
        />
        <PickField<TicketType> label="Type" options={TICKET_TYPES.map((x) => ({ value: x, label: x }))} value={type} onChange={setType} testID="nt-type" />
        <SelectField
          label="Epic"
          options={epics.map((e) => ({ value: e.id, label: e.name }))}
          value={epicId}
          onChange={(v) => {
            setEpic(v);
            setSprint('');
          }}
          testID="nt-epic"
        />
        <SelectField
          label="Sprint"
          options={[{ value: '', label: 'Backlog' }, ...sprints.map((x) => ({ value: x.id, label: `${x.name} · ${fmt(x.start)}–${fmt(x.end)}` }))]}
          value={sprintId}
          onChange={setSprint}
          testID="nt-sprint"
        />
        <PickField<TicketPrio> label="Priority" options={PRIORITIES.map((x) => ({ value: x, label: x }))} value={prio} onChange={setPrio} testID="nt-prio" />
        <PickField multi label="Assignees" optional options={p.team.map((n) => ({ value: n, label: n }))} values={as} onChange={setAs} testID="nt-as" />
        <DateField label="Due date" optional value={due} onChange={setDue} testID="nt-due" />
        <TextField label="Estimate (hours)" optional type="number" value={est} onChange={setEst} testID="nt-est" />
        <TextArea label="Description" optional value={desc} onChange={setDesc} testID="nt-desc" />
      </Form>
      <Button title="Create ticket" onPress={save} disabled={!canCreate} testID="nt-save" />
    </BottomSheet>
  );
}
