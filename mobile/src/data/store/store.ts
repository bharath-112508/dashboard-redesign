import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Action } from './actions';
import { reducer } from './reducer';
import { createInitialState, STATE_VERSION, type AppState } from './state';

/** AsyncStorage key (DECISIONS 9). */
export const STORAGE_KEY = 'vt.mobile.v5';
/** Keys of older builds; removed on start, never migrated. */
export const LEGACY_KEYS = ['vt.mobile.v4'] as const;

type Listener = () => void;

let state: AppState = createInitialState();
let hydrated = false;
let saveQueued = false;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((l) => l());
}

function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  queueMicrotask(() => {
    saveQueued = false;
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {
      // Storage can be unavailable (private mode); the app keeps working in memory.
    });
  });
}

/** A saved snapshot of this version, merged onto a fresh state so new fields get defaults. */
function revive(saved: unknown): AppState | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Partial<AppState>;
  if (s.version !== STATE_VERSION) return null;
  return { ...createInitialState(), ...s } as AppState;
}

export const store = {
  getState(): AppState {
    return state;
  },

  /** Apply an action, notify subscribers and persist. */
  dispatch(action: Action): void {
    const next = reducer(state, action);
    if (next === state) return;
    state = next;
    if (__DEV__ && process.env.EXPO_PUBLIC_LOG_ACTIONS) console.log('[store]', action.type, action);
    emit();
    queueSave();
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  isHydrated(): boolean {
    return hydrated;
  },

  /** Load the persisted state once at startup and drop the v4 key. Safe to call twice. */
  async hydrate(): Promise<void> {
    if (hydrated) return;
    try {
      await AsyncStorage.multiRemove([...LEGACY_KEYS]);
    } catch {
      // ignore
    }
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      const revived = raw ? revive(JSON.parse(raw)) : null;
      if (revived) state = revived;
    } catch {
      // Corrupt or unavailable storage: start from the seed.
    }
    hydrated = true;
    emit();
  },

  /** Replace the whole state (tests and the dev kitchen sink only). */
  replace(next: AppState): void {
    state = next;
    emit();
    queueSave();
  },
};
