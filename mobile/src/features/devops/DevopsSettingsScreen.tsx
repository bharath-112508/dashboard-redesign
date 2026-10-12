import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Eyebrow, Icon, Press, Screen, Stepper, TextField, Toggle, Txt } from '@/components';
import { DEVOPS_RULE_LABEL } from '@/data/seed/devops';
import { useActions, useAppState } from '@/data/store';
import type { DevopsRuleKey } from '@/data/types';
import { SCREEN_TITLES } from '@/nav/titles';
import { colors, radii, space } from '@/theme';

const RULES: DevopsRuleKey[] = ['skipWeekends', 'pauseOnClient', 'notifyPm'];

/** S-DVSET: follow-up sequence, date rules, phases, statuses and the change log (M-38). */
export function DevopsSettingsScreen() {
  const settings = useAppState((s) => s.devopsSettings);
  const { adjustReminder, addReminder, toggleRule, movePhaseUp, addPhase } = useActions();
  const [draft, setDraft] = useState('');
  const submitPhase = () => {
    if (addPhase(draft)) setDraft('');
  };

  return (
    <Screen title={SCREEN_TITLES.dvset} gap={space.gap.list} contentStyle={styles.content} testID="screen-dvset">
      <Eyebrow style={styles.eyebrow}>Follow-up sequence</Eyebrow>
      <View style={styles.card} testID="dvset-sequence">
        {settings.seq.map((r, i) => (
          <View key={`${r.n}-${i}`} style={[styles.row, i > 0 && styles.divider]} testID={`dvset-reminder-${i}`}>
            <Icon name="bell-ring" size={17} color={colors.tealInk} />
            <Txt v="bodyLg" w={700} style={styles.flex}>
              {r.n}
            </Txt>
            {i === 0 ? (
              <Txt v="bodySm" w={700} color={colors.ink2}>
                On phase start
              </Txt>
            ) : (
              <Stepper
                compact
                value={r.d}
                min={1}
                label={`${r.n} days`}
                format={(v) => `+${v} days`}
                onChange={(v) => adjustReminder(i, v > r.d ? 1 : -1)}
              />
            )}
          </View>
        ))}
        <Press label="Add reminder" onPress={addReminder} scale={1} style={[styles.addRow, styles.divider]} testID="dvset-add-reminder">
          <Icon name="plus" size={15} color={colors.primaryInk} />
          <Txt v="body" w={700} color={colors.primaryInk}>
            Add reminder
          </Txt>
        </Press>
      </View>

      <Eyebrow style={styles.eyebrow}>Date rules</Eyebrow>
      <View style={styles.card} testID="dvset-rules">
        {RULES.map((k, i) => {
          const label = DEVOPS_RULE_LABEL[k];
          return (
            <View key={k} style={[styles.row, i > 0 && styles.divider]}>
              <Txt v="bodyLg" w={700} style={styles.flex}>
                {label}
              </Txt>
              <Toggle value={settings.rules[k]} label={label} onColor={colors.green} onChange={() => toggleRule(k, label)} />
            </View>
          );
        })}
      </View>

      <Eyebrow style={styles.eyebrow}>Phases</Eyebrow>
      <View style={styles.card} testID="dvset-phases">
        {settings.phases.map((p, i) => (
          <View key={`${p}-${i}`} style={[styles.row, styles.phaseRow, i > 0 && styles.divider]} testID={`dvset-phase-${i}`}>
            <View style={styles.num}>
              <Txt v="small" w={800} color={colors.tealInk}>
                {String(i + 1)}
              </Txt>
            </View>
            <Txt v="bodyLg" w={700} style={styles.flex}>
              {p}
            </Txt>
            {i > 0 ? (
              <Press label={`Move ${p} up`} onPress={() => movePhaseUp(i)} scale={0.94} style={styles.roundBtn} testID={`dvset-phase-up-${i}`}>
                <Icon name="arrow-up" size={15} color={colors.ink} />
              </Press>
            ) : null}
          </View>
        ))}
        <View style={[styles.newPhase, styles.divider]}>
          <TextField
            label="New phase name"
            placeholder="New phase name"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={submitPhase}
            returnKeyType="done"
            style={styles.input}
            testID="dvset-phase-input"
          />
          <Press label="Add phase" onPress={submitPhase} scale={0.97} style={styles.addBtn} testID="dvset-phase-add">
            <Txt v="meta" w={700} color={colors.white}>
              Add
            </Txt>
          </Press>
        </View>
      </View>

      <Eyebrow style={styles.eyebrow}>Statuses</Eyebrow>
      <View style={styles.statuses}>
        {settings.statuses.map((x) => (
          <View key={x} style={styles.status}>
            <Txt v="meta" w={700}>
              {x}
            </Txt>
          </View>
        ))}
      </View>

      {settings.log.length ? (
        <>
          <Eyebrow style={styles.eyebrow}>Change log</Eyebrow>
          <View style={styles.card} testID="dvset-log">
            {settings.log.slice(0, 6).map((l, i) => (
              <View key={i} style={[styles.logRow, i > 0 && styles.divider]}>
                <Txt v="meta" w={700} color={colors.ink3} style={styles.logDay}>
                  {l[0]}
                </Txt>
                <Txt v="meta" w={400} style={styles.flex}>
                  <Txt v="meta" w={700}>
                    {l[1]}
                  </Txt>
                  {` · ${l[2]}`}
                </Txt>
              </View>
            ))}
          </View>
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: 8 },
  eyebrow: { paddingHorizontal: 4 },
  card: { backgroundColor: colors.surface, borderRadius: radii.card, borderWidth: 1, borderColor: colors.line, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, minHeight: 50 },
  phaseRow: { paddingVertical: 11 },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  flex: { flex: 1, minWidth: 0 },
  addRow: { height: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  num: { width: 24, height: 24, borderRadius: 12, backgroundColor: colors.tealSoft, alignItems: 'center', justifyContent: 'center' },
  roundBtn: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.stepper, alignItems: 'center', justifyContent: 'center' },
  newPhase: { flexDirection: 'row', gap: 8, paddingVertical: 10, paddingHorizontal: 12, alignItems: 'center' },
  input: { flex: 1, minHeight: 40, height: 40, borderRadius: 20, backgroundColor: colors.stepper, borderColor: colors.line, paddingVertical: 0 },
  addBtn: { height: 40, paddingHorizontal: 16, borderRadius: 20, backgroundColor: colors.ink, justifyContent: 'center' },
  statuses: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  status: {
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'center',
  },
  logRow: { flexDirection: 'row', gap: 10, paddingVertical: 10, paddingHorizontal: 14 },
  logDay: { width: 44 },
});
