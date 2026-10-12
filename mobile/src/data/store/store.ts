import AsyncStorage from '@react-native-async-storage/async-storage';

import type { Action } from './actions';
import { reducer } from './reducer';
import { createInitialState, DEFAULT_UI, STATE_VERSION, type AppState } from './state';

/** AsyncStorage key (same as the prototype's localStorage key). */
export const STORAGE_KEY = 'vt.mobile.v4';

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

/** Merge a saved snapshot onto a fresh state so new fields get their defaults. */
function revive(saved: unknown): AppState | null {
  if (!saved || typeof saved !== 'object') return null;
  const s = saved as Partial<AppState>;
  if (s.version !== STATE_VERSION) return null;
  const base = createInitialState();
  return { ...base, ...s, ui: { ...DEFAULT_UI, ...(s.ui ?? {}) }, session: { ...base.session, ...(s.session ?? {}) } };
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

  /** Load the persisted state once at startup (M-47). Safe to call more than once. */
  async hydrate(): Promise<void> {
    if (hydrated) return;
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
