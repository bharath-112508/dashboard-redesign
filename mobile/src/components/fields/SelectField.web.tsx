import { useState, type CSSProperties } from 'react';

import { colors } from '@/theme';

import type { SelectFieldProps } from './types';

const base: CSSProperties = {
  height: 50,
  borderRadius: 14,
  border: `1px solid ${colors.lineInput}`,
  background: `${colors.surface} url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%231B2D45' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>") no-repeat right 14px center`,
  padding: '0 40px 0 14px',
  fontFamily: 'SchibstedGrotesk_600SemiBold, system-ui, sans-serif',
  fontSize: 15,
  color: colors.ink,
  appearance: 'none',
  WebkitAppearance: 'none',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** Select (web): a native <select>, as in the prototype. */
export function SelectField({ label, value, options, onChange, highlight, strong, testID }: SelectFieldProps) {
  const [focus, setFocus] = useState(false);
  return (
    <select
      aria-label={label}
      data-testid={testID}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
      style={{
        ...base,
        ...(strong ? { fontFamily: 'SchibstedGrotesk_700Bold, system-ui, sans-serif', fontSize: 16 } : null),
        borderColor: focus || highlight ? colors.primary : colors.lineInput,
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
