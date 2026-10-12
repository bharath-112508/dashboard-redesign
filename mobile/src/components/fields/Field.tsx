import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, fontFamily, radii } from '@/theme';

import { Txt } from '../Txt';
import type { FieldBase } from './types';

/**
 * Form field frame (SPEC §6.2 "Form"): label 12.5/700 with a red "*" or "(optional)",
 * the control, a hint (12) and an error (12.5/600 #C0392B).
 */
export function Field({ label, required, optional, hint, error, children, hideLabel }: Omit<FieldBase, 'testID'> & { children: ReactNode; hideLabel?: boolean }) {
  return (
    <View style={styles.field}>
      {label && !hideLabel ? (
        <Txt v="sub" w={700} color={colors.ink2}>
          {label}
          {required ? <Txt v="sub" w={700} color={colors.danger}>{' *'}</Txt> : null}
          {optional ? <Txt v="sub" w={500} color={colors.ink3}>{' (optional)'}</Txt> : null}
        </Txt>
      ) : null}
      {children}
      {hint ? (
        <Txt v="meta" w={400} color={colors.ink3}>
          {hint}
        </Txt>
      ) : null}
      {error ? (
        <Txt v="sub" w={600} color={colors.danger} testID="field-error">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

/** A form: fields 12 apart. */
export function Form({ children }: { children: ReactNode }) {
  return <View style={styles.form}>{children}</View>;
}

export const inputStyles = StyleSheet.create({
  box: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.lineInput,
    borderRadius: radii.input,
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
    fontFamily: fontFamily[400],
    fontSize: 15,
    color: colors.ink,
  },
  invalid: { borderColor: colors.red },
  readOnly: { backgroundColor: colors.track },
  area: { height: undefined, minHeight: 104, paddingTop: 12, paddingBottom: 12, lineHeight: 22, textAlignVertical: 'top' },
});

const styles = StyleSheet.create({
  field: { gap: 6 },
  form: { gap: 12 },
});
