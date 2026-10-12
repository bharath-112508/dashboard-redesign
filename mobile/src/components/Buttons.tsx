import { Children, isValidElement, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, radii } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

/** Button kinds (SPEC §6.2): p primary blue, s secondary white, d destructive, g green, ink. */
export type ButtonKind = 'p' | 's' | 'd' | 'g' | 'ink';

const K: Record<ButtonKind, { bg: string; fg: string; border: string }> = {
  p: { bg: colors.primary, fg: colors.white, border: colors.primary },
  s: { bg: colors.surface, fg: colors.ink, border: colors.lineInput },
  d: { bg: colors.destructiveBg, fg: colors.destructiveInk, border: colors.dangerRing },
  g: { bg: colors.green, fg: colors.white, border: colors.green },
  ink: { bg: colors.ink, fg: colors.white, border: colors.ink },
};

export interface ButtonProps {
  title: string;
  onPress?: () => void;
  kind?: ButtonKind;
  icon?: IconName;
  disabled?: boolean;
  /** a11y label (defaults to the title) */
  label?: string;
  testID?: string;
}

/** Button: 48h, radius 14, 14.5/700, optional 17px icon (SPEC §6.2). */
export function Button({ title, onPress, kind = 'p', icon, disabled, label, testID }: ButtonProps) {
  const k = K[kind];
  return (
    <Press
      label={label ?? title}
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, { backgroundColor: k.bg, borderColor: k.border }, disabled && styles.disabled]}
      testID={testID}
    >
      {icon ? <Icon name={icon} size={17} color={k.fg} /> : null}
      <Txt v="rowTitle" w={700} color={k.fg} numberOfLines={1}>
        {title}
      </Txt>
    </Press>
  );
}

/** A row of buttons, 8 apart, each growing to fill (SPEC §6.2 "Buttons"). */
export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <View style={styles.row}>
      {Children.toArray(children)
        .filter(isValidElement)
        .map((c, i) => (
          <View key={c.key ?? i} style={styles.cell}>
            {c}
          </View>
        ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  cell: { flexGrow: 1, flexBasis: 0, minWidth: 120 },
  btn: {
    height: 48,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: radii.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  disabled: { opacity: 0.45 },
});
