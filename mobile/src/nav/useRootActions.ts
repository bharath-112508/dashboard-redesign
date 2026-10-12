import type { HeaderAction } from '@/components/Header';
import { isClient } from '@/data/selectors';
import { useAppState } from '@/data/store';

import { href, push } from './routes';

/**
 * Header actions of root screens (`hdrActs`, SPEC §2.4): staff get Search, clients get
 * Profile. Screens add their own (e.g. "+") before these.
 */
export function useRootActions(): HeaderAction[] {
  const client = useAppState(isClient);
  return client
    ? [{ icon: 'user-round', label: 'Profile', onPress: () => push(href.me()), testID: 'header-profile' }]
    : [{ icon: 'search', label: 'Search', onPress: () => push(href.search()), testID: 'header-search' }];
}
