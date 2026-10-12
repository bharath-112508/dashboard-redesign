import { useState } from 'react';

import {
  BottomSheet,
  Button,
  ButtonRow,
  DateField,
  Form,
  PickField,
  PickList,
  SelectField,
  TextArea,
  TextBlock,
  TextField,
  ToggleField,
} from '@/components';
import { DVF, PRIORITY_DOT, devopsTone, phaseOf, type DevopsFieldKey } from '@/data/constants';
import { devopsByKey, devopsPickerProjects, myName, type DevopsView } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import type { TicketPrio } from '@/data/types';
import { href, push } from '@/nav/routes';
import { tones } from '@/theme';

import { ladderState, nextInternalName, nextLadderStep } from './board';
import { useFormErrors } from './formErrors';

interface SheetProps {
  visible: boolean;
  onClose: () => void;
}

/** Sheets about one DevOps record take its key; the subtitle is the project name (SPEC 2.6). */
interface DvSheetProps extends SheetProps {
  dvKey: string;
}

function useDv(key: string): DevopsView | null {
  return useAppState((s) => devopsByKey(s, key));
}

// ── SH-DVSTATUS ─────────────────────────────────────────────────────────────

/** SH-DVSTATUS (V-92): statuses from settings, sub = phase; toast "Status updated". */
export function DvStatusSheet({ visible, onClose, dvKey }: DvSheetProps) {
  const d = useDv(dvKey);
  const statuses = useAppState((s) => s.devopsSettings.statuses);
  const { setDevopsStatus } = useActions();
  const fe = useFormErrors();
  if (!visible || !d) return null;
  return (
    <BottomSheet visible title="Status" sub={d.name} onClose={onClose} testID="sheet-dv-status">
      <PickList
        options={statuses.map((s) => ({ value: s, label: s, sub: phaseOf(s), dot: tones[devopsTone(s)].dot }))}
        value={d.infra}
        onPick={(v) => {
          if (fe.result(setDevopsStatus(d.key, v))) onClose();
        }}
        testID="dv-status-pick"
      />
    </BottomSheet>
  );
}

// ── SH-DVFIELD ──────────────────────────────────────────────────────────────

/** SH-DVFIELD (V-93): option fields are pick lists; date fields take a date (+ reason for the estimated deployment). */
export function DvFieldSheet({ visible, onClose, dvKey, field }: DvSheetProps & { field: DevopsFieldKey }) {
  const d = useDv(dvKey);
  const requireNote = useAppState((s) => s.devopsSettings.rules.requireNote);
  const statuses = useAppState((s) => s.devopsSettings.statuses);
  const { setDevopsField } = useActions();
  const fe = useFormErrors();
  const cur = d ? String((d as unknown as Record<string, unknown>)[field] ?? '') : '';
  const [v, setV] = useState(cur.slice(0, 10));
  const [reason, setReason] = useState('');
  if (!visible || !d) return null;
  const def = DVF.find((x) => x.key === field)!;
  if (def.options) {
    const opts = field === 'infra' ? statuses : def.options;
    return (
      <BottomSheet visible title={def.label} sub={d.name} onClose={onClose} testID="sheet-dv-field">
        <PickList
          options={opts.map((o) => ({ value: o, label: o, dot: field === 'prio' ? PRIORITY_DOT[o as TicketPrio] : undefined }))}
          value={cur}
          onPick={(x) => {
            if (fe.result(setDevopsField(d.key, field, x))) onClose();
          }}
          testID="dv-field-pick"
        />
      </BottomSheet>
    );
  }
  const needReason = field === 'latestDue' && requireNote;
  const save = () => {
    if (!fe.need({ value: v, ...(needReason ? { reason } : {}) })) return;
    if (fe.result(setDevopsField(d.key, field, v, reason))) onClose();
  };
  return (
    <BottomSheet visible title={def.label} sub={d.name} onClose={onClose} testID="sheet-dv-field">
      <Form>
        <DateField label={def.label} required value={v} onChange={setV} error={fe.errors.value} testID="dv-field-date" />
        {needReason ? (
          <TextArea label="Reason for the change" required value={reason} onChange={setReason} placeholder="Why did it move?" error={fe.errors.reason} testID="dv-field-reason" />
        ) : null}
      </Form>
      {field === 'initDue' ? <TextBlock tone="note" text="Fixed once saved." /> : null}
      <Button title="Save" onPress={save} testID="dv-field-save" />
    </BottomSheet>
  );
}

// ── SH-DVTEXT ───────────────────────────────────────────────────────────────

/** SH-DVTEXT (V-94): the next step (or "What happened so far" when no next step exists). */
export function DvTextSheet({ visible, onClose, dvKey }: DvSheetProps) {
  const d = useDv(dvKey);
  const { setDevopsText } = useActions();
  const fe = useFormErrors();
  const field: 'next' | 'phase' = d && d.next === undefined && d.phase !== undefined ? 'phase' : 'next';
  const [v, setV] = useState(d?.next || d?.phase || '');
  if (!visible || !d) return null;
  return (
    <BottomSheet visible title="Next step" sub={d.name} onClose={onClose} testID="sheet-dv-text">
      <TextArea label="" value={v} onChange={setV} placeholder="What happens next?" testID="dv-text-input" />
      <Button
        title="Save"
        onPress={() => {
          if (fe.result(setDevopsText(d.key, v, field))) onClose();
        }}
        testID="dv-text-save"
      />
    </BottomSheet>
  );
}

// ── SH-DVLOG ────────────────────────────────────────────────────────────────

const LOG_TYPES = ['Follow-up', 'Call', 'Email', 'Meeting'] as const;

/** SH-DVLOG (V-95): required fields follow the Rules; the client ladder advances, the internal one appends. */
export function DvLogSheet({ visible, onClose, dvKey }: DvSheetProps) {
  const d = useDv(dvKey);
  const S = useAppState((s) => s.devopsSettings);
  const { logFollowUp } = useActions();
  const fe = useFormErrors();
  const [type, setType] = useState<string>('Follow-up');
  const [note, setNote] = useState('');
  const [rem, setRem] = useState('');
  const [adv, setAdv] = useState(true);
  const [nn, setNn] = useState(d ? nextInternalName(d, S) : '');
  if (!visible || !d) return null;
  const { client } = ladderState(d, S);
  const nxt = nextLadderStep(d, S);
  const save = () => {
    const req: Record<string, string> = {};
    if (S.rules.requireNote) req.note = note;
    if (S.rules.requireReminder) req.reminder = rem;
    if (!fe.need(req)) return;
    if (fe.result(logFollowUp(d.key, { type, note, reminder: rem, advance: adv, nextName: client ? undefined : nn }))) onClose();
  };
  return (
    <BottomSheet visible title="Log follow-up" sub={d.name} onClose={onClose} testID="sheet-dv-log">
      <Form>
        <PickField label="Type" options={LOG_TYPES.map((t) => ({ value: t, label: t }))} value={type} onChange={setType} testID="dv-log-type" />
        <TextArea
          label="What happened?"
          required={S.rules.requireNote}
          value={note}
          onChange={setNote}
          placeholder="Also saved as the reason if the estimated deployment moves."
          error={fe.errors.note}
          testID="dv-log-note"
        />
        <DateField label="Next reminder" required={S.rules.requireReminder} value={rem} onChange={setRem} error={fe.errors.reminder} testID="dv-log-reminder" />
        {client && nxt ? (
          <ToggleField title={`Move to ${nxt}`} sub="Steps follow the fixed client sequence" value={adv} onChange={setAdv} testID="dv-log-advance" />
        ) : null}
        {!client ? <TextField label="Next step name" optional value={nn} onChange={setNn} testID="dv-log-next-name" /> : null}
      </Form>
      <Button title="Save & log" onPress={save} testID="dv-log-save" />
    </BottomSheet>
  );
}

// ── SH-DVNEW ────────────────────────────────────────────────────────────────

/**
 * SH-DVNEW (V-91): the project picker lists client and internal projects without a
 * DevOps record (`devopsPickerProjects`); the label is the project name, the company
 * shows as the hint. Creates OPS-n and opens it.
 */
export function DvNewSheet({ visible, onClose }: SheetProps) {
  const projects = useAppState(devopsPickerProjects);
  const statuses = useAppState((s) => s.devopsSettings.statuses);
  const people = useAppState((s) => s.devopsSettings.people);
  const me = useAppState(myName);
  const { createDevopsProject } = useActions();
  const fe = useFormErrors();
  const [pid, setPid] = useState('');
  const [infra, setInfra] = useState(statuses[0] ?? '');
  const [owner, setOwner] = useState(people.includes(me) ? me : 'Unassigned');
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  if (!visible) return null;
  const picked = projects.find((p) => p.id === pid);
  const save = () => {
    if (!fe.need({ projectId: pid, initDue: due })) return;
    const r = createDevopsProject({ projectId: pid, infra, owner, initDue: due, note });
    if (fe.result(r) && r.ok) {
      onClose();
      push(href.dvp(r.key));
    }
  };
  return (
    <BottomSheet visible title="New project" sub="Pick a project" onClose={onClose} testID="sheet-dv-new">
      <Form>
        <SelectField
          label="Project"
          required
          value={pid}
          options={[{ value: '', label: 'Select a project…' }, ...projects.map((p) => ({ value: p.id, label: p.name }))]}
          onChange={setPid}
          hint={picked ? `${picked.kind === 'internal' ? 'Internal' : picked.co} · ${picked.kind === 'internal' ? 'internal project' : 'client project'}` : undefined}
          error={fe.errors.projectId}
          testID="dv-new-project"
        />
        <SelectField label="Status" value={infra} options={statuses.map((s) => ({ value: s, label: s }))} onChange={setInfra} testID="dv-new-status" />
        <SelectField
          label="DevOps owner"
          value={owner}
          options={[...people, 'Unassigned'].map((s) => ({ value: s, label: s }))}
          onChange={setOwner}
          testID="dv-new-owner"
        />
        <DateField label="Initial due date" required hint="Fixed once saved." value={due} onChange={setDue} error={fe.errors.initDue} testID="dv-new-due" />
        <TextArea label="What happened so far?" optional value={note} onChange={setNote} testID="dv-new-note" />
      </Form>
      <TextBlock tone="info" text="New companies and projects are created on the Companies page." />
      <Button title="Create project" onPress={save} testID="dv-new-save" />
    </BottomSheet>
  );
}

// ── SH-DVSETITEM ────────────────────────────────────────────────────────────

/** SH-DVSETITEM (V-100): add, rename or remove a status or a dev phase. */
export function DvSetItemSheet({ visible, onClose, list, index }: SheetProps & { list: 'statuses' | 'phases'; index: number | null }) {
  const S = useAppState((s) => s.devopsSettings);
  const { saveDevopsSettingsItem, removeDevopsSettingsItem } = useActions();
  const fe = useFormErrors();
  const ph = list === 'phases';
  const edit = index != null;
  const [name, setName] = useState(edit ? (ph ? S.phases[index]?.n : S.statuses[index]) ?? '' : '');
  const [days, setDays] = useState(edit && ph ? String(S.phases[index]?.d ?? '') : ph ? '14' : '');
  if (!visible) return null;
  const save = () => {
    if (!fe.need({ name })) return;
    if (fe.result(saveDevopsSettingsItem(list, index, name, ph ? days : undefined))) onClose();
  };
  const canRemove = edit && S[list].length > 1;
  return (
    <BottomSheet visible title={`${edit ? 'Edit' : 'Add'} ${ph ? 'phase' : 'status'}`} onClose={onClose} testID="sheet-dvset-item">
      <Form>
        <TextField label="Name" required value={name} onChange={setName} error={fe.errors.name} testID="dvset-item-name" />
        {ph ? <TextField label="Typical duration (days)" type="number" value={days} onChange={setDays} testID="dvset-item-days" /> : null}
      </Form>
      <ButtonRow>
        {canRemove ? (
          <Button
            title="Remove"
            kind="d"
            onPress={() => {
              if (fe.result(removeDevopsSettingsItem(list, index))) onClose();
            }}
            testID="dvset-item-remove"
          />
        ) : null}
        <Button title="Save" onPress={save} testID="dvset-item-save" />
      </ButtonRow>
    </BottomSheet>
  );
}
