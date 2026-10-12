import { useEffect, useState } from 'react';

import { BottomSheet, Button, ButtonRow, DateField, Form, PickField, PickList, Rows, TextArea, TextField, TicketRow, toastResult } from '@/components';
import { PRIORITIES, PRIORITY_DOT, TICKET_STATUS, TICKET_STATUSES } from '@/data/constants';
import { fmtRange } from '@/data/format';
import { project, sprintsOf, ticketsOf, type SubView } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { Ticket, TicketPrio, TicketStatus } from '@/data/types';
import { tones } from '@/theme';

/** Ticket fields edited through SH-TFIELD. */
export type TicketField = 'st' | 'prio' | 'sprint' | 'as' | 'start' | 'due' | 'est';

const TITLES: Record<TicketField, string> = {
  st: 'Status',
  prio: 'Priority',
  sprint: 'Sprint',
  as: 'Assignees',
  start: 'Start',
  due: 'Due date',
  est: 'Estimate (hours)',
};

export const statusOptions = () =>
  TICKET_STATUSES.map((k) => ({ value: k, label: TICKET_STATUS[k].label, dot: tones[TICKET_STATUS[k].tone].dot }));
export const prioOptions = () => PRIORITIES.map((k) => ({ value: k, label: k, dot: PRIORITY_DOT[k] }));

/** A date or number with Clear + Save (SH-TFIELD start/due/est, SH-SFIELD due/est). */
function ValueForm({ kind, label, initial, onSave }: { kind: 'date' | 'number'; label: string; initial: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(initial);
  useEffect(() => setV(initial), [initial]);
  return (
    <>
      <Form>
        {kind === 'date' ? (
          <DateField label={label} value={v} onChange={setV} testID="field-value" />
        ) : (
          <TextField label={label} value={v} onChange={setV} type="number" testID="field-value" />
        )}
      </Form>
      <ButtonRow>
        <Button title="Clear" kind="s" onPress={() => onSave('')} testID="field-clear" />
        <Button title="Save" onPress={() => onSave(v)} testID="field-save" />
      </ButtonRow>
    </>
  );
}

/** SH-TFIELD (V-21): status / priority / sprint pick lists save on tap; assignees multi + Save; dates and estimate. */
export function TicketFieldSheet({ ticket: t, f, onClose }: { ticket: Ticket; f: TicketField | null; onClose: () => void }) {
  const { patchTicket } = useActions();
  const team = useAppState((s) => project(s, t.projectId)?.team ?? []);
  const sprints = useAppState((s) => sprintsOf(s, t.epicId));
  const [as, setAs] = useState<string[]>(t.as);
  useEffect(() => setAs(t.as), [f, t.as]);
  const save = (patch: Parameters<typeof patchTicket>[1]) => {
    const r = patchTicket(t.key, patch);
    if (r.ok) onClose();
    toastResult(r);
  };
  const field = f ?? 'st';
  return (
    <BottomSheet visible={!!f} onClose={onClose} title={TITLES[field]} sub={t.key} testID="sheet-tfield">
      {field === 'st' ? <PickList<TicketStatus> options={statusOptions()} value={t.st} onPick={(v) => save({ st: v })} /> : null}
      {field === 'prio' ? <PickList<TicketPrio> options={prioOptions()} value={t.prio} onPick={(v) => save({ prio: v })} /> : null}
      {field === 'sprint' ? (
        <PickList
          options={[{ value: '', label: 'Backlog' }, ...sprints.map((sp) => ({ value: sp.id, label: sp.name, sub: `${fmtRange(sp.start, sp.end)} · ${sp.state}` }))]}
          value={t.sprintId ?? ''}
          onPick={(v) => save({ sprintId: v || null })}
        />
      ) : null}
      {field === 'as' ? (
        <>
          <Form>
            <PickField
              multi
              label="People on this ticket"
              options={[...new Set([...team, ...t.as])].map((n) => ({ value: n, label: n }))}
              values={as}
              onChange={setAs}
              testID="assignee"
            />
          </Form>
          <Button title="Save" onPress={() => save({ as })} testID="field-save" />
        </>
      ) : null}
      {field === 'start' || field === 'due' ? (
        <ValueForm kind="date" label={TITLES[field]} initial={t[field] ?? ''} onSave={(v) => save({ [field]: v })} />
      ) : null}
      {field === 'est' ? (
        <ValueForm kind="number" label={TITLES.est} initial={t.est ? String(t.est) : ''} onSave={(v) => save({ est: Number(v) || 0 })} />
      ) : null}
    </BottomSheet>
  );
}

/** SH-TDESC (V-22). */
export function DescSheet({ ticket: t, open, onClose }: { ticket: Ticket; open: boolean; onClose: () => void }) {
  const { patchTicket } = useActions();
  const [v, setV] = useState(t.desc);
  useEffect(() => setV(t.desc), [open, t.desc]);
  return (
    <BottomSheet visible={open} onClose={onClose} title="Description" sub={t.key} testID="sheet-tdesc">
      <Form>
        <TextArea label="" placeholder="Describe the work" value={v} onChange={setV} testID="desc-input" />
      </Form>
      <Button
        title="Save"
        onPress={() => {
          const r = patchTicket(t.key, { desc: v.trim() });
          if (r.ok) onClose();
          toastResult(r);
        }}
        testID="desc-save"
      />
    </BottomSheet>
  );
}

/** SH-TLINK (V-27): tickets of the same project (not itself, not linked); Clear links. */
export function LinkSheet({ ticket: t, open, onClose }: { ticket: Ticket; open: boolean; onClose: () => void }) {
  const { linkBlocker, clearBlockers } = useActions();
  const others = useAppState((s) => ticketsOf(s, t.projectId).filter((x) => x.key !== t.key && !t.blk.includes(x.key)));
  return (
    <BottomSheet visible={open} onClose={onClose} title="Blocked by" sub={`Pick the task that blocks ${t.key}`} testID="sheet-tlink">
      <Rows empty="No other tasks in this project.">
        {others.map((x) => (
          <TicketRow
            key={x.key}
            ticket={x}
            row={{ chevron: false }}
            testID={`link-${x.key}`}
            onPress={() => {
              const r = linkBlocker(t.key, x.key);
              if (r.ok) onClose();
              toastResult(r);
            }}
          />
        ))}
      </Rows>
      {t.blk.length ? (
        <Button
          title="Clear links"
          kind="d"
          onPress={() => {
            toastResult(clearBlockers(t.key));
            onClose();
          }}
          testID="link-clear"
        />
      ) : null}
    </BottomSheet>
  );
}

/** Subtask fields edited through SH-SFIELD. */
export type SubField = 'st' | 'prio' | 'as' | 'due' | 'est';
const SUB_TITLES: Record<SubField, string> = { st: 'Status', prio: 'Priority', as: 'Assignee', due: 'Due date', est: 'Estimate (hours)' };

/** SH-SFIELD (V-25): pick lists save on tap; due / estimate with Clear + Save. */
export function SubFieldSheet({ sub: x, f, onClose }: { sub: SubView; f: SubField | null; onClose: () => void }) {
  const { patchSubtask } = useActions();
  const team = useAppState((s) => project(s, x.parent.projectId)?.team ?? []);
  const save = (patch: Parameters<typeof patchSubtask>[2]) => {
    const r = patchSubtask(x.parent.key, x.id, patch);
    if (r.ok) onClose();
    toastResult(r);
  };
  const field = f ?? 'st';
  return (
    <BottomSheet visible={!!f} onClose={onClose} title={SUB_TITLES[field]} sub={x.key} testID="sheet-sfield">
      {field === 'st' ? <PickList<TicketStatus> options={statusOptions()} value={x.st} onPick={(v) => save({ st: v })} /> : null}
      {field === 'prio' ? <PickList<TicketPrio> options={prioOptions()} value={x.prio} onPick={(v) => save({ prio: v })} /> : null}
      {field === 'as' ? (
        <PickList
          options={[{ value: '', label: 'Unassigned' }, ...[...new Set([...x.parent.as, ...team])].map((n) => ({ value: n, label: n }))]}
          value={x.as}
          onPick={(v) => save({ as: v })}
        />
      ) : null}
      {field === 'due' ? <ValueForm kind="date" label="Due date" initial={x.due} onSave={(v) => save({ due: v })} /> : null}
      {field === 'est' ? <ValueForm kind="number" label="Estimate (hours)" initial={x.est ? String(x.est) : ''} onSave={(v) => save({ est: Number(v) || 0 })} /> : null}
    </BottomSheet>
  );
}

/** SH-SNOTE (V-25). */
export function SubNoteSheet({ sub: x, open, onClose }: { sub: SubView; open: boolean; onClose: () => void }) {
  const { patchSubtask } = useActions();
  const [v, setV] = useState(x.note);
  useEffect(() => setV(x.note), [open, x.note]);
  return (
    <BottomSheet visible={open} onClose={onClose} title="Notes" sub={x.key} testID="sheet-snote">
      <Form>
        <TextArea label="" placeholder="Details for this subtask" value={v} onChange={setV} testID="note-input" />
      </Form>
      <Button
        title="Save"
        onPress={() => {
          const r = patchSubtask(x.parent.key, x.id, { note: v.trim() });
          if (r.ok) onClose();
          toastResult(r);
        }}
        testID="note-save"
      />
    </BottomSheet>
  );
}
