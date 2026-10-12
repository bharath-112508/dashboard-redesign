import { useState, type CSSProperties } from 'react';

import { colors } from '@/theme';

import type { DateFieldProps } from './types';

const base: CSSProperties = {
  height: 50,
  borderRadius: 14,
  border: `1px solid ${colors.lineInput}`,
  background: colors.surface,
  padding: '0 14px',
  fontFamily: 'SchibstedGrotesk_400Regular, system-ui, sans-serif',
  fontSize: 14.5,
  color: colors.ink,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** Date input (web): a native <input type="date">, as in the prototype. */
export function DateField({ label, value, onChange, testID }: DateFieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <input
      type="date"
      aria-label={label}
      data-testid={testID}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{ ...base, borderColor: focus ? colors.primary : colors.lineInput }}
    />
  );
}
