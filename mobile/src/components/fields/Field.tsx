import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radii } from '@/theme';

import { Txt } from '../Txt';

export interface FieldProps {
  label: string;
  /** adds " *" */
  required?: boolean;
  hint?: string;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

/** Form field wrapper: 12.5/700 label, the control, an optional hint. */
export function Field({ label, required, hint, children, style }: FieldProps) {
  return (
    <View style={[styles.field, style]}>
      <Txt v="caption" w={700} color={colors.ink2}>
        {label}
        {required ? ' *' : ''}
      </Txt>
      {children}
      {hint ? (
        <Txt v="small" w={400} color={colors.ink3}>
          {hint}
        </Txt>
      ) : null}
    </View>
  );
}

/** Inline validation error (red 13.5/600). Announced to screen readers. */
export function FieldError({ text }: { text: string }) {
  if (!text) return null;
  return (
    <Txt v="bodySm" color={colors.danger} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="form-error">
      {text}
    </Txt>
  );
}

/** Shared input look: 50 high, radius 14, 1px border. */
export const inputStyles = StyleSheet.create({
  box: {
    minHeight: 50,
    borderRadius: radii.input,
    borderWidth: 1,
    borderColor: colors.lineInput,
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    justifyContent: 'center',
  },
  focus: { borderColor: colors.primary },
  text: { fontFamily: 'SchibstedGrotesk_400Regular', fontSize: 14.5, color: colors.ink, paddingVertical: 12 },
});

const styles = StyleSheet.create({
  field: { gap: 6 },
});
