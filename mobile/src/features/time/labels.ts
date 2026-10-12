import { useCallback } from 'react';

import { projLabel, tkOrSub } from '@/data/selectors';
import { store, useAppState } from '@/data/store';
import type { AppState } from '@/data/store';

/** Displayed key of an entry key: subtask ids show as "PMT-11.2" (A-11). */
export const keyLabelOf = (s: AppState, k: string): string => (k ? (tkOrSub(s, k)?.key ?? k) : '');

/**
 * Label helpers bound to the current state: `proj('c:dacop')` → "Daco · Daco platform",
 * `key('PMT-11.s2')` → "PMT-11.2". Re-render on store changes through `useAppState`.
 */
export function useTimeLabels(): { proj: (v: string) => string; key: (k: string) => string } {
  useAppState((s) => s.projects);
  const proj = useCallback((v: string) => projLabel(store.getState(), v), []);
  const key = useCallback((k: string) => keyLabelOf(store.getState(), k), []);
  return { proj, key };
}
