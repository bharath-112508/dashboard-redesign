/** S-PLAN: Set up maintenance / Edit support plan (M-29). */
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { BottomSheet, ChipRow, DarkButton, DateField, Field, FieldError, Press, showToast, Stepper, TextField, Toggle, Txt } from '@/components';
import { TODAY } from '@/data/clock';
import { PLAN_COVER, PLAN_FIX, PLAN_RESPONSE, PLAN_TYPES } from '@/data/constants';
import { capabilities, myRole, projectByName } from '@/data/selectors';
import { NEW_PLAN_DEFAULTS } from '@/data/seed/projects';
import { useActions, useAppState } from '@/data/store';
import type { SupportPlan } from '@/data/types';
import { closeSheet } from '@/nav/routes';
import { colors } from '@/theme';

/** Exact validation copy (SPEC S-PLAN). */
export const PLAN_ERRORS = {
  dates: 'Add the start and renewal dates.',
  order: 'Renewal must be after the start date.',
} as const;

export function validatePlan(f: Pick<SupportPlan, 'start' | 'renew'>): string {
  if (!f.start || !f.renew) return PLAN_ERRORS.dates;
  if (f.renew <= f.start) return PLAN_ERRORS.order;
  return '';
}

const opts = <T extends string>(xs: readonly T[]) => xs.map((x) => ({ key: x, label: x }));

export function SupportPlanSheet() {
  const { project = '' } = useLocalSearchParams<{ project?: string }>();
  const p = useAppState((s) => projectByName(s, project));
  const role = useAppState(myRole);
  const allowed = !!role && capabilities(role).canSetProjectStatus;
  const { savePlan } = useActions();
  const isNew = !p?.plan;
  const [f, setF] = useState<SupportPlan>(() => p?.plan ?? { ...NEW_PLAN_DEFAULTS, start: TODAY });
  const [err, setErr] = useState('');
  const set = (patch: Partial<SupportPlan>) => {
    setF((x) => ({ ...x, ...patch }));
    setErr('');
  };
  const hasH = f.type !== 'sla';
  const hasS = f.type !== 'hours';

  const save = () => {
    const e = validatePlan(f);
    if (e) {
      setErr(e);
      return;
    }
    const msg = savePlan(project, f);
    closeSheet();
    showToast(msg);
  };

  const footer = (
    <>
      <FieldError text={err} />
      <DarkButton label={isNew ? 'Move to maintenance' : 'Save plan'} onPress={save} style={styles.save} testID="plan-save" />
    </>
  );

  return (
    <BottomSheet
      title={isNew ? 'Set up maintenance' : 'Edit support plan'}
      subtitle={project}
      icon="wrench"
      iconBg={colors.tealSoft}
      iconFg={colors.tealInk}
      showClose={false}
      maxHeight="90%"
      footer={p && allowed ? footer : undefined}
      testID="sheet-support-plan"
    >
      {!p || !allowed ? (
        <Txt v="bodySm" w={400} color={colors.ink3}>
          Only project managers and admins can set up support plans.
        </Txt>
      ) : (
        <>
          <Heading>Agreement</Heading>
          <Field label="What does the client get?">
            <ChipRow wrap label="What does the client get?" value={f.type} onChange={(type) => set({ type })} options={PLAN_TYPES.map(([key, label]) => ({ key, label }))} />
          </Field>
          {hasH ? (
            <>
              <Field label="Support hours per month">
                <Stepper label="Support hours per month" value={f.hours} min={1} onChange={(hours) => set({ hours })} format={(v) => `${v}h`} />
              </Field>
              <Field label="Unused hours">
                <ChipRow
                  wrap
                  label="Unused hours"
                  value={f.roll}
                  onChange={(roll) => set({ roll })}
                  options={[
                    { key: 'expire', label: 'Expire monthly' },
                    { key: 'roll', label: 'Roll over 1 month' },
                  ]}
                />
              </Field>
              <Field label="Work beyond the plan">
                <ChipRow
                  wrap
                  label="Work beyond the plan"
                  value={f.over}
                  onChange={(over) => set({ over })}
                  options={[
                    { key: 'bill', label: 'Bill hourly' },
                    { key: 'ask', label: 'Quote first' },
                  ]}
                />
              </Field>
            </>
          ) : null}
          {hasS ? (
            <>
              <Heading>SLA</Heading>
              <Field label="First reply within">
                <ChipRow wrap label="First reply within" value={f.resp} onChange={(resp) => set({ resp })} options={opts(PLAN_RESPONSE)} />
              </Field>
              <Field label="Fix blocking problems within">
                <ChipRow wrap label="Fix blocking problems within" value={f.fix} onChange={(fix) => set({ fix })} options={opts(PLAN_FIX)} />
              </Field>
              <Field label="Coverage">
                <ChipRow wrap label="Coverage" value={f.cover} onChange={(cover) => set({ cover })} options={opts(PLAN_COVER)} />
              </Field>
            </>
          ) : null}
          <Heading>Dates</Heading>
          <View style={styles.dates}>
            <Field label="Starts" required style={styles.flex}>
              <DateField label="Starts" value={f.start} onChange={(start) => set({ start })} testID="plan-start" />
            </Field>
            <Field label="Renews" required style={styles.flex}>
              <DateField label="Renews" value={f.renew} onChange={(renew) => set({ renew })} testID="plan-renew" />
            </Field>
          </View>
          <Heading>Live system</Heading>
          <Field label="Production URL">
            <TextField label="Production URL" value={f.url} onChangeText={(url) => set({ url })} placeholder="e.g. daco.no" autoCapitalize="none" testID="plan-url" />
          </Field>
          <Field label="Maintenance window">
            <TextField label="Maintenance window" value={f.win} onChangeText={(win) => set({ win })} placeholder="e.g. Sundays 06:00–07:00" testID="plan-window" />
          </Field>
          <Press label="Send monthly report to client" a11yRole="switch" checked={f.auto} onPress={() => set({ auto: !f.auto })} scale={0.98} style={styles.autoRow} testID="plan-auto">
            <View style={styles.flex}>
              <Txt v="bodyLg" w={700} style={styles.lh19}>
                Send monthly report to client
              </Txt>
              <Txt v="caption" color={colors.ink3}>
                Automatically on the 1st of each month
              </Txt>
            </View>
            <Toggle value={f.auto} label="Send monthly report to client" onColor={colors.green} readOnly />
          </Press>
        </>
      )}
    </BottomSheet>
  );
}

function Heading({ children }: { children: string }) {
  return (
    <Txt v="eyebrow" w={800} color={colors.tealInk} style={styles.heading} accessibilityRole="header">
      {children}
    </Txt>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  lh19: { lineHeight: 19 },
  heading: { marginTop: 6 },
  dates: { flexDirection: 'row', gap: 10 },
  autoRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 16, backgroundColor: colors.bg },
  save: { borderRadius: 25 },
});
