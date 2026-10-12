import { Text, type TextProps, type TextStyle } from 'react-native';

import { colors, typeStyle, type FontWeight, type TypeVariant } from '@/theme';

export interface TxtProps extends TextProps {
  /** type scale entry (SPEC §6.1), default 'body' */
  v?: TypeVariant;
  /** text colour, default ink */
  color?: string;
  /** weight override (400–800) */
  w?: FontWeight;
  align?: TextStyle['textAlign'];
}

/** Text in Inter. Scales with the system font size (cap 1.4×). */
export function Txt({ v = 'body', color = colors.ink, w, align, style, maxFontSizeMultiplier = 1.4, ...rest }: TxtProps) {
  return (
    <Text
      {...rest}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[typeStyle(v, w), { color }, align ? { textAlign: align } : null, style]}
    />
  );
}
