import { Pressable, type AccessibilityRole, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { pressOpacity } from '@/theme';

export interface PressProps extends Omit<PressableProps, 'style' | 'accessibilityLabel'> {
  /** required: what the control does or opens (DECISIONS 8) */
  label: string;
  a11yRole?: AccessibilityRole;
  style?: StyleProp<ViewStyle>;
  /** stable selector for tests (data-testid on web) */
  testID?: string;
  /** selected state (tabs, segments, chips): sets aria-selected */
  selected?: boolean;
  /** checked state (checkboxes, toggles, picks): sets aria-checked */
  checked?: boolean;
  /** no opacity dip while pressed */
  flat?: boolean;
}

/**
 * The one pressable used by every control: accessibility role and label are required.
 * Pressed feedback is a light opacity dip (v5 has no press scale).
 */
export function Press({ label, a11yRole = 'button', style, disabled, selected, checked, flat, children, ...rest }: PressProps) {
  return (
    <Pressable
      accessibilityRole={a11yRole}
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, selected, checked }}
      aria-disabled={disabled || undefined}
      aria-selected={selected}
      aria-checked={checked}
      disabled={disabled}
      hitSlop={4}
      {...rest}
      style={({ pressed }) => [style, pressed && !disabled && !flat ? { opacity: pressOpacity } : null]}
    >
      {children}
    </Pressable>
  );
}
