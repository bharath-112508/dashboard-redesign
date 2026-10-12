import { useState } from 'react';

import { BottomSheet, Button, ButtonRow, DateField, Form, PickList, Rows, Segmented, TextArea, TextBlock, TextField, TicketRow, openTicket, toastResult, Block } from '@/components';
import { fmt } from '@/data/format';
import { epicName, myPerm, sprint, sprintsOf, ticket } from '@/data/selectors';
import { useActions, useAppState, useStoreState } from '@/data/store';

import { nextSprintStart, sprintTickets } from '../derive';

/** SH-NEWSPRINT (V-46): 1- or 2-week sprint starting the day after the last one. */
export function NewSprintSheet({ epicId, onClose }: { epicId: string; onClose: () => void }) {
  const { createSprint } = useActions();
  const name = useAppState((s) => epicName(s, epicId));
  const def = useAppState((s) => nextSprintStart(s, epicId));
  const [len, setLen] = useState<'1' | '2'>('2');
  const [start, setStart] = useState(def);
  const save = () => {
    const r = createSprint(epicId, { start: start || def, weeks: len === '1' ? 1 : 2 });
    toastResult(r);
    if (r.ok) onClose();
  };
  return (
    <BottomSheet visible title="New sprint" sub={name} onClose={onClose} testID="sheet-new-sprint">
      <Segmented
        options={[
          { value: '1', label: '1-week sprint' },
          { value: '2', label: '2-week sprint' },
        ]}
        value={len}
        onChange={setLen}
        testID="new-sprint-len"
      />
      <Form>
        <DateField label="Starts" value={start} onChange={setStart} testID="new-sprint-start" />
      </Form>
      <ButtonRow>
        <Button title="Add sprint" onPress={save} testID="new-sprint-save" />
      </ButtonRow>
    </BottomSheet>
  );
}

/** SH-SPRINT (V-47): the sprint's tasks; Start (planned) or Complete (active) with `sprints.manage`. */
export function SprintSheet({ sprintId, onClose }: { sprintId: string; onClose: () => void }) {
  const { startSprint, completeSprint } = useActions();
  const state = useStoreState();
  const can = useAppState((s) => myPerm(s, 'sprints.manage'));
  const sp = sprint(state, sprintId);
  if (!sp) return null;
  const { tickets, done } = sprintTickets(state, sp.id);
  const open = tickets.length - done;
  return (
    <BottomSheet visible title={sp.name} sub={`${epicName(state, sp.epicId)} · ${fmt(sp.start)} – ${fmt(sp.end)}`} onClose={onClose} testID="sheet-sprint">
      <Block title="Tasks" sub={`${done} of ${tickets.length} done`}>
        <Rows empty="No tasks here yet.">
          {tickets.map((t) => (
            <TicketRow
              key={t.key}
              ticket={t}
              onPress={() => {
                onClose();
                openTicket(t.key);
              }}
            />
          ))}
        </Rows>
      </Block>
      {can && sp.state === 'planned' ? (
        <ButtonRow>
          <Button title="Start sprint" icon="play" onPress={() => toastResult(startSprint(sp.id)) && onClose()} testID="sprint-start" />
        </ButtonRow>
      ) : null}
      {can && sp.state === 'active' ? (
        <>
          <TextBlock tone="note" text={open ? `${open} unfinished tasks move to the backlog when you complete the sprint.` : 'Every task is done.'} />
          <ButtonRow>
            <Button
              title="Complete sprint"
              kind="g"
              icon="circle-check"
              onPress={() => {
                toastResult(completeSprint(sp.id));
                onClose();
              }}
              testID="sprint-complete"
            />
          </ButtonRow>
        </>
      ) : null}
    </BottomSheet>
  );
}

/** SH-MOVESPRINT (V-48): Backlog or a non-done sprint of the epic. */
export function MoveSprintSheet({ ticketKey, epicId, onClose }: { ticketKey: string; epicId: string; onClose: () => void }) {
  const { moveTicketToSprint } = useActions();
  const t = useAppState((s) => ticket(s, ticketKey));
  const SP = useAppState((s) => sprintsOf(s, epicId).filter((x) => x.state !== 'done'));
  if (!t) return null;
  return (
    <BottomSheet visible title="Move to…" sub={`${t.key} · ${t.title}`} onClose={onClose} testID="sheet-move-sprint">
      <PickList
        options={[{ value: '', label: 'Backlog' }, ...SP.map((x) => ({ value: x.id, label: x.name, sub: `${fmt(x.start)} – ${fmt(x.end)}` }))]}
        value={t.sprintId ?? ''}
        onPick={(v) => {
          toastResult(moveTicketToSprint(t.key, v || null));
          onClose();
        }}
        testID="move-sprint"
      />
    </BottomSheet>
  );
}

/** SH-NEWEPIC (V-49): name and requirement, both required. */
export function NewEpicSheet({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { createEpic } = useActions();
  const [name, setName] = useState('');
  const [req, setReq] = useState('');
  const [tried, setTried] = useState(false);
  const save = () => {
    setTried(true);
    if (!name.trim() || !req.trim()) return;
    const r = createEpic(projectId, name, req);
    toastResult(r);
    if (r.ok) onClose();
  };
  return (
    <BottomSheet visible title="New epic" sub="What is being built?" onClose={onClose} testID="sheet-new-epic">
      <Form>
        <TextField label="Name" required value={name} onChange={setName} placeholder="e.g. Mobile app" error={tried && !name.trim() ? 'Required' : undefined} testID="new-epic-name" />
        <TextArea
          label="Requirement"
          required
          value={req}
          onChange={setReq}
          placeholder="Describe the requirement. Goals and dates are planned per sprint."
          error={tried && !req.trim() ? 'Required' : undefined}
          testID="new-epic-req"
        />
      </Form>
      <ButtonRow>
        <Button title="Create epic" onPress={save} testID="new-epic-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
