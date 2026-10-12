import type { CSSProperties } from 'react';

import { colors, fontFamily } from '@/theme';

import type { DateInputProps } from './types';

const base: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: `1px solid ${colors.lineInput}`,
  background: colors.surface,
  padding: '0 14px',
  fontFamily: `${fontFamily[400]}, system-ui, sans-serif`,
  fontSize: 15,
  color: colors.ink,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** Date control (web): a native <input type="date">, as in the prototype. */
export function DateInput({ label, value, onChange, invalid, testID }: DateInputProps) {
  return (
    <input
      type="date"
      aria-label={label}
      data-testid={testID}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...base, borderColor: invalid ? colors.red : colors.lineInput }}
    />
  );
}
