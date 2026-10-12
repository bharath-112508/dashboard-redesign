import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

import { colors, control, pressScale, radii } from '@/theme';

import { Icon, type IconName } from './Icon';
import { Press } from './Press';
import { Txt } from './Txt';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  icon?: IconName;
  disabled?: boolean;
  /** accessible label when it differs from the visible text */
  a11yLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

interface Look {
  bg: string;
  fg: string;
  border?: string;
  height: number;
  radius: number;
  v: 'titleSm' | 'rowTitle' | 'bodySm';
}

function make(look: Look) {
  return function Button({ label, onPress, icon, disabled, a11yLabel, style, testID }: ButtonProps) {
    return (
      <Press
        label={a11yLabel ?? label}
        onPress={onPress}
        disabled={disabled}
        scale={pressScale.tile}
        testID={testID}
        style={[
          styles.base,
          { backgroundColor: look.bg, height: look.height, borderRadius: look.radius, opacity: disabled ? 0.5 : 1 },
          look.border ? { borderWidth: 1, borderColor: look.border } : null,
          style,
        ]}
      >
        {icon ? <Icon name={icon} size={18} color={look.fg} strokeWidth={2.4} /> : null}
        <Txt v={look.v} w={700} color={look.fg} numberOfLines={1}>
          {label}
        </Txt>
      </Press>
    );
  };
}

/** Blue 52px pill (Sign in, sheet save). */
export const PrimaryButton = make({ bg: colors.primary, fg: colors.white, height: control.cta, radius: radii.pill, v: 'titleSm' });
/** Dark ink 50px button (plan save, "Report a problem", "Download CSV"). */
export const DarkButton = make({ bg: colors.ink, fg: colors.white, height: control.input, radius: radii.input, v: 'rowTitle' });
/** White outline 46px button ("Request a change", "Edit plan"). */
export const SecondaryButton = make({ bg: colors.surface, fg: colors.ink, border: colors.line, height: control.secondary, radius: radii.input, v: 'rowTitle' });
/** Rust 50px pill (Sign out, Reject). */
export const DestructiveButton = make({ bg: colors.destructiveBg, fg: colors.destructiveInk, border: colors.dangerRing, height: control.input, radius: radii.pill, v: 'rowTitle' });
/** Green 42px button (Approve). */
export const ApproveButton = make({ bg: colors.green, fg: colors.white, height: control.composer, radius: 12, v: 'rowTitle' });
/** Soft blue 36px pill (small-header actions: "Mark all read", "+ New"). */
export const SoftPillButton = make({ bg: colors.primarySoft, fg: colors.primaryInk, height: 36, radius: radii.pill, v: 'bodySm' });
/** Blue 40px pill with a plus (large-header actions: "Log", "Report"). */
export const HeaderActionButton = make({ bg: colors.primary, fg: colors.white, height: 40, radius: radii.pill, v: 'rowTitle' });

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 16 },
});
