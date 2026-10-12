import { Pressable, type AccessibilityRole, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { pressScale } from '@/theme';

export interface PressProps extends Omit<PressableProps, 'style' | 'accessibilityLabel'> {
  /** required: what the control does / opens */
  label: string;
  a11yRole?: AccessibilityRole;
  /** scale while pressed (.98 cards, .97 tiles and CTAs, .94 tabs and avatars) */
  scale?: number;
  style?: StyleProp<ViewStyle>;
  /** stable selector for tests (data-testid on web) */
  testID?: string;
  /** selected state (tabs, segments): sets aria-selected */
  selected?: boolean;
  /** checked state (radios, switches): sets aria-checked */
  checked?: boolean;
}

/**
 * The one pressable used by every control: accessibility role and label are required,
 * and it scales slightly while pressed (SPEC §5.6 micro-interactions).
 */
export function Press({ label, a11yRole = 'button', scale = pressScale.card, style, disabled, selected, checked, children, ...rest }: PressProps) {
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
      style={({ pressed }) => [style, pressed && !disabled ? { transform: [{ scale }] } : null]}
    >
      {children}
    </Pressable>
  );
}
