import { TextInput, type KeyboardTypeOptions } from 'react-native';

import { colors } from '@/theme';

import { Field, inputStyles } from './Field';
import type { FieldBase } from './types';

export interface TextFieldProps extends FieldBase {
  value: string;
  onChange?: (text: string) => void;
  placeholder?: string;
  /** grey read-only field (Profile email) */
  readOnly?: boolean;
  type?: 'text' | 'email' | 'password' | 'number';
  autoFocus?: boolean;
}

const KB: Record<NonNullable<TextFieldProps['type']>, KeyboardTypeOptions> = { text: 'default', email: 'email-address', password: 'default', number: 'decimal-pad' };

/** Text input 48h r12 15px (SPEC §6.2). */
export function TextField({ value, onChange, placeholder, readOnly, type = 'text', autoFocus, testID, ...field }: TextFieldProps) {
  return (
    <Field {...field}>
      <TextInput
        value={value}
        onChangeText={onChange}
        editable={!readOnly}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        accessibilityLabel={field.label || placeholder}
        secureTextEntry={type === 'password'}
        keyboardType={KB[type]}
        autoCapitalize={type === 'text' ? 'sentences' : 'none'}
        autoCorrect={type === 'text'}
        autoFocus={autoFocus}
        style={[inputStyles.box, field.error ? inputStyles.invalid : null, readOnly ? inputStyles.readOnly : null]}
        testID={testID}
      />
    </Field>
  );
}

/** Textarea, 4 rows (SPEC §6.2). */
export function TextArea({ value, onChange, placeholder, testID, ...field }: Omit<TextFieldProps, 'type' | 'readOnly'>) {
  return (
    <Field {...field}>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.ink3}
        accessibilityLabel={field.label || placeholder}
        multiline
        numberOfLines={4}
        style={[inputStyles.box, inputStyles.area, field.error ? inputStyles.invalid : null]}
        testID={testID}
      />
    </Field>
  );
}
