import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet } from '@/components/BottomSheet';
import { PrimaryButton } from '@/components/Buttons';
import { SegmentedControl } from '@/components/Controls';
import { Field, FieldError, SelectField, TextArea, TextField } from '@/components/fields';
import { showToast } from '@/components/Toast';
import { TODAY } from '@/data/clock';
import { me } from '@/data/selectors';
import { useActions, useAppState } from '@/data/store';
import { closeSheet, type SheetParams } from '@/nav/routes';
import { colors } from '@/theme';

import { INTERNAL, logDayLabel, logTimeProjectOptions, logTimeTicketOptions } from './selectors';

type Params = { [K in keyof SheetParams['log-time']]?: string };

const HOURS = Array.from({ length: 25 }, (_, i) => ({ value: String(i), label: `${i}h` }));
const MINUTES = [0, 5, 10, 15, 30, 45].map((m) => ({ value: String(m), label: `${m}m` }));
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SUPPORT = / · support$/;

interface Form {
  proj: string;
  tk: string;
  text: string;
  h: string;
  m: string;
  bill: boolean;
  note: string;
}

/**
 * S-LOG Log time sheet (M-14 sheet side, M-15, M-16, M-17, M-34).
 * Params: ticketId (preset ticket and its project), day (ISO, default today),
 * project and text (support logging: "{project} · support").
 */
export function LogTimeSheet() {
  const params = useLocalSearchParams<Params>();
  const person = useAppState(me);
  const projects = useAppState(logTimeProjectOptions);
  const presetTicket = useAppState((s) => (params.ticketId ? s.tickets.find((t) => t.id === Number(params.ticketId)) : undefined));
  const day = params.day && ISO.test(params.day) && params.day <= TODAY ? params.day : TODAY;

  const [f, setF] = useState<Form>(() => {
    const text = params.text ?? '';
    const proj = params.project || presetTicket?.proj || (SUPPORT.test(text) ? text.replace(SUPPORT, '') : '');
    return { proj, tk: presetTicket ? String(presetTicket.id) : '', text, h: '1', m: '0', bill: proj !== INTERNAL, note: '' };
  });
  const [err, setErr] = useState('');
  const tickets = useAppState((s) => logTimeTicketOptions(s, f.proj, presetTicket?.id));
  const { addTimeEntry } = useActions();

  const projectOptions = useMemo(() => {
    const list = f.proj && f.proj !== INTERNAL && !projects.includes(f.proj) ? [...projects, f.proj] : projects;
    return [
      { value: '', label: 'Choose a project' },
      ...list.map((p) => ({ value: p, label: p })),
      { value: INTERNAL, label: 'Internal · Admin & meetings' },
    ];
  }, [projects, f.proj]);

  const ticketOptions = [
    { value: '', label: tickets.length ? 'No ticket, describe the work' : 'No open tickets, describe the work' },
    ...tickets.map((t) => ({ value: String(t.id), label: `${t.key} · ${t.title}` })),
  ];

  const set = (patch: Partial<Form>) => {
    setF((x) => ({ ...x, ...patch }));
    setErr('');
  };

  const save = () => {
    const hours = (Number(f.h) || 0) + (Number(f.m) || 0) / 60;
    if (!hours) return setErr('Pick the hours or minutes you worked.');
    if (!f.proj) return setErr('Pick the project you worked on.');
    if (!f.tk && !f.text.trim()) return setErr('Pick a ticket or describe the work.');
    const msg = addTimeEntry({
      day,
      ticketId: f.tk ? Number(f.tk) : null,
      project: f.proj,
      text: f.tk ? '' : f.text,
      hours,
      bill: f.bill,
      note: f.note,
    });
    closeSheet();
    showToast(msg);
  };

  if (!person) return null;

  return (
    <BottomSheet
      title="Log time"
      icon="timer"
      subtitle={logDayLabel(day, person.name)}
      testID="sheet-log-time"
      footer={
        <>
          <FieldError text={err} />
          <PrimaryButton label="Save hours" onPress={save} testID="log-save" />
        </>
      }
    >
      <Field label="Project" required>
        <SelectField
          label="Project"
          value={f.proj}
          options={projectOptions}
          onChange={(v) => set({ proj: v, tk: '', bill: v !== INTERNAL })}
          highlight
          testID="log-project"
        />
      </Field>

      {f.proj ? (
        <Field label="Ticket">
          <SelectField label="Ticket" value={f.tk} options={ticketOptions} onChange={(v) => set({ tk: v })} highlight testID="log-ticket" />
        </Field>
      ) : null}

      {f.proj && !f.tk ? (
        <Field label="What did you work on?" required>
          <TextField
            label="What did you work on?"
            value={f.text}
            onChangeText={(v) => set({ text: v })}
            placeholder="e.g. Sprint planning"
            testID="log-text"
          />
        </Field>
      ) : null}

      <View style={styles.pair}>
        <Field label="Hours" style={styles.flex}>
          <SelectField label="Hours" value={f.h} options={HOURS} onChange={(v) => set({ h: v })} testID="log-hours" />
        </Field>
        <Field label="Minutes" style={styles.flex}>
          <SelectField label="Minutes" value={f.m} options={MINUTES} onChange={(v) => set({ m: v })} testID="log-minutes" />
        </Field>
      </View>

      <SegmentedControl
        label="Billable or non-billable"
        value={f.bill ? 'bill' : 'non'}
        onChange={(k) => setF((x) => ({ ...x, bill: k === 'bill' }))}
        segments={[
          { key: 'bill', label: 'Billable', dot: colors.primary },
          { key: 'non', label: 'Non-billable', dot: colors.nonBillable },
        ]}
        style={styles.seg}
      />

      <Field label="Note">
        <TextArea label="Note" value={f.note} onChangeText={(v) => set({ note: v })} placeholder="Optional" minHeight={68} testID="log-note" />
      </Field>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pair: { flexDirection: 'row', gap: 10 },
  seg: { height: 46 },
});
