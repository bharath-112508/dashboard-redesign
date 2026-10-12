import { useRoute } from 'expo-router';

import { useAppState } from '@/data/store';

import { myRouteAccess, ROUTE_ACCESS } from './access';

/**
 * True when the signed-in person may open the route this component renders in. Screen
 * and BottomSheet use it to render nothing / an access-denied state while the (app)
 * RouteGuard sends the person Home (DECISIONS 6).
 */
export function useRouteAllowed(): boolean {
  const name = useRoute().name;
  // Routes outside the signed-in group (sign-in, dev/kitchen-sink) are not guarded.
  const guarded = name in ROUTE_ACCESS;
  return useAppState((s) => !guarded || myRouteAccess(s, name));
}
