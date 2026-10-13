import { useNavigationContainerRef, useSegments } from 'expo-router';
import { useCallback, useEffect, useReducer, useSyncExternalStore } from 'react';

import { ALL_TABS, type TabKey } from './tabs';

interface NavRoute {
  name: string;
  params?: object;
  /** set on the route a URL opened (deep link); pushed routes have none */
  path?: string;
  state?: NavState;
}
interface NavState {
  index?: number;
  routes: NavRoute[];
}

export interface ShellRoute {
  /** the tab that owns the current stack (highlighted in the tab bar) */
  tab: TabKey;
  /** route name on top of the (app) stack, e.g. "(tabs)", "ticket/[id]", "sheet/log-time" */
  top: string;
  /** route under a sheet (the screen the sheet was opened from) */
  underSheet: string;
  /** number of screens on the (app) stack */
  depth: number;
  /**
   * The screen the app was opened on by a deep link, when no tab has been chosen since
   * (the tab bar then highlights the tab that owns it, `deepLinkOwner`), else null.
   */
  deepLink: string | null;
}

function findApp(state: NavState | undefined): NavState | undefined {
  if (!state) return undefined;
  for (const r of state.routes) {
    if (r.name === '(app)') return r.state;
    const inner = findApp(r.state);
    if (inner) return inner;
  }
  return undefined;
}

let version = 0;

/**
 * Where the shell is: which tab owns the stack and what is on top. Derived from the live
 * navigation state (container 'state' events), so it is always in sync with the router.
 */
export function useShellRoute(): ShellRoute {
  'use no memo'; // reads the live navigation state; must not be memoised by the React Compiler
  useSegments();
  const ref = useNavigationContainerRef();
  const subscribe = useCallback(
    (cb: () => void) =>
      ref.addListener('state', () => {
        version++;
        cb();
      }),
    [ref],
  );
  useSyncExternalStore(subscribe, () => version, () => version);
  // The container can become ready after the first render (deep links): read again then.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (ref.isReady()) {
      bump();
      return;
    }
    const t = setInterval(() => {
      if (ref.isReady()) {
        clearInterval(t);
        bump();
      }
    }, 50);
    return () => clearInterval(t);
  }, [ref]);

  const root = (ref.isReady() ? ref.getRootState() : undefined) as unknown as NavState | undefined;
  const app = findApp(root);
  const routes = app?.routes ?? [];
  const tabsRoute = routes.find((r) => r.name === '(tabs)');
  let tab: TabKey = 'home';
  if (tabsRoute?.state) {
    const st = tabsRoute.state;
    const name = st.routes[st.index ?? 0]?.name;
    if (name && (ALL_TABS as readonly string[]).includes(name)) tab = name as TabKey;
  } else {
    const screen = (tabsRoute?.params as { screen?: string } | undefined)?.screen;
    if (screen && (ALL_TABS as readonly string[]).includes(screen)) tab = screen as TabKey;
  }
  const idx = app?.index ?? routes.length - 1;
  const top = routes[idx]?.name ?? '(tabs)';
  let under = top;
  for (let i = idx; i >= 0; i--) {
    if (!routes[i].name.startsWith('sheet/')) {
      under = routes[i].name;
      break;
    }
  }
  // A deep link puts (tabs) under the opened screen with Home focused, no tab chosen and the
  // URL path on the opened route (pushed routes carry no path).
  const first = routes[1];
  const chosen = !!(tabsRoute?.params as { screen?: string } | undefined)?.screen || (tabsRoute?.state?.index ?? 0) !== 0;
  const deepLink = first?.path && !first.name.startsWith('sheet/') && !chosen ? first.name : null;
  return { tab, top, underSheet: under, depth: routes.length, deepLink };
}
