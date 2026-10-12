import { useState, type CSSProperties } from 'react';

import { colors } from '@/theme';

import type { SelectFieldProps } from './types';

const base: CSSProperties = {
  height: 50,
  borderRadius: 14,
  border: `1px solid ${colors.lineInput}`,
  background: `${colors.surface} url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='18' height='18' viewBox='0 0 24 24' fill='none' stroke='%236A7A8E' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>") no-repeat right 14px center`,
  padding: '0 40px 0 14px',
  fontFamily: 'SchibstedGrotesk_400Regular, system-ui, sans-serif',
  fontSize: 14.5,
  color: colors.ink,
  appearance: 'none',
  WebkitAppearance: 'none',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** Select (web): a native <select>, as in the prototype. */
export function SelectField({ label, value, options, onChange, highlight, testID }: SelectFieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <select
      aria-label={label}
      data-testid={testID}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{ ...base, borderColor: focus || highlight ? colors.primary : colors.lineInput }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
