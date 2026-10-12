import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, Chip, Field, FieldError, Icon, PrimaryButton, Press, TextArea, TextField, Txt } from '@/components';
import { showToast } from '@/components/Toast';
import { useActions, useAppState } from '@/data/store';
import { closeSheet } from '@/nav/routes';
import { colors, control, radii } from '@/theme';

import { reportProjectOptions } from './selectors';

export interface ReportSheetProps {
  /** preset project (maintenance Support buttons, M-22) */
  project?: string;
  kind?: 'Bug' | 'Change';
}

/**
 * S-BUG: "Report a problem" / "Request a change" (M-21, M-22). Saving creates a client
 * ticket (Bug, or Task for a change) and toasts "PMT-36 sent to Viljetech".
 */
export function ReportSheet({ project, kind = 'Bug' }: ReportSheetProps) {
  const options = useAppState(reportProjectOptions);
  const { createClientTicket } = useActions();
  const [proj, setProj] = useState(project && options.includes(project) ? project : '');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [att, setAtt] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const isChange = kind === 'Change';

  const save = () => {
    if (!proj) return setErr('Pick the project the bug is in.');
    if (!title.trim() || !desc.trim()) return setErr('Add a title and a description.');
    const t = createClientTicket({ project: proj, kind, title, desc, att });
    closeSheet();
    showToast(`${t.key} sent to Viljetech`);
  };

  return (
    <BottomSheet
      title={isChange ? 'Request a change' : 'Report a problem'}
      icon="bug"
      testID="sheet-report"
      footer={
        <>
          <FieldError text={err} />
          <PrimaryButton label="Send to Viljetech" onPress={save} testID="report-save" />
        </>
      }
    >
      <Field label="Which project?" required hint={proj ? `The Viljetech team gets this as a ticket on ${proj}.` : undefined}>
        <View style={styles.radios} accessibilityRole="radiogroup" accessibilityLabel="Which project?">
          {options.map((p) => {
            const on = p === proj;
            return (
              <Press
                key={p}
                label={p}
                a11yRole="radio"
                checked={on}
                scale={0.97}
                onPress={() => {
                  setProj(p);
                  setErr('');
                }}
                style={[styles.radio, on ? styles.radioOn : styles.radioOff]}
                testID={`report-project-${p}`}
              >
                <Icon name={on ? 'circle-check' : 'circle'} size={18} color={on ? colors.white : colors.ink} strokeWidth={2.4} />
                <Txt v="rowTitle" color={on ? colors.white : colors.ink}>
                  {p}
                </Txt>
              </Press>
            );
          })}
        </View>
      </Field>
      <Field label="Title" required>
        <TextField
          label="Title"
          placeholder="What is broken?"
          value={title}
          onChangeText={(v) => {
            setTitle(v);
            setErr('');
          }}
          testID="report-title"
        />
      </Field>
      <Field label="Description" required>
        <TextArea
          label="Description"
          placeholder="Steps to reproduce, what you expected, device"
          value={desc}
          minHeight={112}
          onChangeText={(v) => {
            setDesc(v);
            setErr('');
          }}
          testID="report-desc"
        />
      </Field>
      <Field label="Screenshots">
        <View style={styles.atts}>
          {att.map((a) => (
            <Chip key={a} label={a} icon="image" bg={colors.track} fg={colors.ink} style={styles.attChip} />
          ))}
          <Press
            label="Add photo"
            scale={0.97}
            onPress={() => setAtt((a) => [...a, `screenshot-${a.length + 1}.png`])}
            style={styles.addPhoto}
            testID="report-add-photo"
          >
            <Txt v="bodySm" w={700} color={colors.primaryInk}>
              + Add photo
            </Txt>
          </Press>
        </View>
      </Field>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  radios: { gap: 6 },
  radio: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: control.input,
    paddingHorizontal: 16,
    borderRadius: radii.pill,
    borderWidth: 1,
  },
  radioOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  radioOff: { backgroundColor: colors.surface, borderColor: colors.lineInput },
  atts: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
  attChip: { height: 34, borderRadius: 10, paddingHorizontal: 10 },
  addPhoto: {
    height: 34,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.faint,
    justifyContent: 'center',
  },
});
