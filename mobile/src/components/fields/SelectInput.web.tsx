import type { CSSProperties } from 'react';

import { colors, fontFamily } from '@/theme';

import type { SelectInputProps } from './types';

const base: CSSProperties = {
  height: 48,
  borderRadius: 12,
  border: `1px solid ${colors.lineInput}`,
  background: `${colors.surface} url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2322354C' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>") no-repeat right 14px center`,
  padding: '0 38px 0 14px',
  fontFamily: `${fontFamily[400]}, system-ui, sans-serif`,
  fontSize: 15,
  color: colors.ink,
  appearance: 'none',
  WebkitAppearance: 'none',
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
};

/** Select control (web): a native <select>, as in the prototype. */
export function SelectInput({ label, value, options, onChange, invalid, testID }: SelectInputProps) {
  return (
    <select
      aria-label={label}
      data-testid={testID}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{ ...base, borderColor: invalid ? colors.red : colors.lineInput }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
