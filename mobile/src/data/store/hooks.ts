import { useMemo, useSyncExternalStore } from 'react';

import { createCommands, type Commands } from './commands';
import type { AppState } from './state';
import { store } from './store';

const subscribe = (l: () => void) => store.subscribe(l);
const snapshot = () => store.getState();

/** The whole state; re-renders on every change. Prefer `useAppState(selector)`. */
export function useStoreState(): AppState {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * Read derived data: `const tickets = useAppState(myTickets)`.
 * The selector runs on every state change; keep selectors cheap and pure.
 */
export function useAppState<T>(selector: (s: AppState) => T): T {
  const state = useStoreState();
  return selector(state);
}

const commands: Commands = createCommands(store.getState, store.dispatch);

/** Every state change goes through these commands (see src/data/README.md). */
export function useActions(): Commands {
  return useMemo(() => commands, []);
}

/** Commands outside React (tests, deep-link handlers). */
export const actions = commands;

/** True once the persisted state has been loaded. */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, store.isHydrated, store.isHydrated);
}
