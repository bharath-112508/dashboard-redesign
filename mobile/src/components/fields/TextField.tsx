import { useState } from 'react';
import { Platform, TextInput, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native';

import { colors } from '@/theme';

import { inputStyles } from './Field';

export interface TextFieldProps extends Omit<TextInputProps, 'style'> {
  /** accessible name (usually the field label) */
  label: string;
  /** blue border (focused look, e.g. the Log sheet's project select) */
  highlight?: boolean;
  multiline?: boolean;
  /** min height for multiline (TextArea) */
  minHeight?: number;
  style?: StyleProp<ViewStyle>;
}

const webNoOutline = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as object) : null;

/** Single-line input (50 high, radius 14). */
export function TextField({ label, highlight, multiline, minHeight, style, onFocus, onBlur, ...rest }: TextFieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <TextInput
      accessibilityLabel={label}
      placeholderTextColor={colors.muted}
      multiline={multiline}
      textAlignVertical={multiline ? 'top' : 'center'}
      maxFontSizeMultiplier={1.4}
      {...rest}
      onFocus={(e) => {
        setFocus(true);
        onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocus(false);
        onBlur?.(e);
      }}
      style={[
        inputStyles.box,
        inputStyles.text,
        (focus || highlight) && inputStyles.focus,
        multiline ? { minHeight: minHeight ?? 96, paddingTop: 12 } : null,
        webNoOutline,
        style,
      ]}
    />
  );
}

/** Multi-line input (description, note, reason). */
export function TextArea(props: Omit<TextFieldProps, 'multiline'>) {
  return <TextField {...props} multiline />;
}
